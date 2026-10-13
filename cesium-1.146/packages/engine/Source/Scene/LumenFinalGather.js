import destroyLumenResource from "./destroyLumenResource.js";
import LumenGpuTimer from "./LumenGpuTimer.js";
import {
  Cartesian2,
  Cartesian3,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  BoundingRectangle,
  DeveloperError,
} from "@cesium/core";
import Texture from "../Renderer/Texture.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import PassState from "../Renderer/PassState.js";
import RenderState from "../Renderer/RenderState.js";
import Sampler from "../Renderer/Sampler.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import ContextLimits from "../Renderer/ContextLimits.js";
import LumenReceiverPass from "./LumenReceiverPass.js";
import {
  receiverTrace,
  receiverShade,
  receiverNeighborhood,
} from "./LumenGpuShaders.js";

// All presets are deterministic, have no history, and leave the 2m DDGI grid unchanged.
const presets = Object.freeze({
  balanced: Object.freeze({ scale: 0.5, samples: 16 }),
  high: Object.freeze({ scale: 0.5, samples: 32 }),
  fast: Object.freeze({ scale: 0.25, samples: 16 }),
  roi: Object.freeze({ scale: 1, samples: 64, roi: 256 }),
});
const nearest = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
});
/** Optional same-frame, world-space diffuse final gather. Owns only receiver and
 * output textures; raw round snapshots remain owned by the static GPU world.
 * Unsupported views/surfaces and resource failures use the existing DDGI. @private */
class LumenFinalGather {
  constructor(lumen) {
    this.lumen = lumen;
    this.scene = lumen._scene;
    this.mode = "ddgi";
    this.quality = "balanced";
    this.model = undefined;
    this.maxMemoryBytes = 64 * 1048576;
    this.maxRayInvocations = 16 * 1048576;
    this.traversalBudget = 256;
    this.seed = 0;
    this.freezeSampling = false; // explicit image diagnostics only
    this.fallbackReason = 1;
    this.ready = false;
    this._executingMain = false;
    this._compositeEnabled = true;
    this.profileForward = false; // diagnostic timer only, no readback
    this._textures = [];
    this._framebuffers = [];
    this._commands = {};
    this._queries = [];
    this.receiverSize = new Cartesian2(1, 1);
    this.resultSize = new Cartesian2(1, 1);
    this.offset = new Cartesian2();
    this.sceneSize = new Cartesian2(1, 1);
    this._localToEye = new Matrix4();
    this._timer = this.scene.context._gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    );
    this._unregisterTimer = LumenGpuTimer.register(this.scene.context, () =>
      this._invalidateTimers(),
    );
    this._timerFrames = new Map();
    this.metrics = {
      status: "disabled",
      frames: 0,
      memoryBytes: 0,
      peakMemoryBytes: 0,
      draws: 0,
      stages: {},
      timingUnavailable: 0,
      disjoint: 0,
      productionReadbacks: 0,
      history: false,
      completedTimings: [],
      incompleteTimerFrames: 0,
      unknownFraction: "diagnostic-only; no production readback",
    };
  }
  configure({
    mode = this.mode,
    quality = this.quality,
    model = this.model,
  } = {}) {
    if (!["ddgi", "fg", "raw"].includes(mode) || !presets[quality]) {
      throw new DeveloperError("Invalid final gather mode or quality");
    }
    const changed = this.quality !== quality || this.model !== model;
    this.mode = mode;
    this.quality = quality;
    this.model = model;
    this.ready = false;
    const w = this.lumen.world;
    if (mode === "ddgi") {
      w?.setFinalGatherCapture?.(false);
      this.release();
      this.metrics.status = "disabled";
    } else {
      if (changed) {
        this.release();
      }
      w?.setFinalGatherCapture?.(true);
      this.metrics.status = "waiting for complete round input";
      // One extra solve is needed when enabling after the original solve has settled.
      // Capturing never changes the transport options or feeds the screen result back.
      if (
        w?.packet &&
        !w.finalGatherSnapshot &&
        w.requestedRevision === w.settledRevision
      ) {
        this.scene.requestRender();
        return w.solve({});
      }
    }
    this.scene.requestRender();
    return Promise.resolve();
  }
  beginFrame() {
    this.ready = false;
    this._executingMain = false;
    this._poll();
  }
  supported(model, frameState) {
    return (
      this.model === model &&
      !model?.isDestroyed() &&
      this.mode !== "ddgi" &&
      this.lumen.enabled &&
      frameState.mode === 3 &&
      frameState.passes.render &&
      !frameState.passes.pick &&
      !frameState.passes.depth
    );
  }
  enabledFor(model, frameState) {
    return (
      this.ready &&
      this._compositeEnabled &&
      this._executingMain &&
      this.supported(model, frameState)
    );
  }
  _layout() {
    const s = this.scene,
      p = presets[this.quality],
      rw = Math.max(1, Math.ceil(s.drawingBufferWidth * p.scale)),
      rh = Math.max(1, Math.ceil(s.drawingBufferHeight * p.scale));
    const width = p.roi ? Math.min(rw, p.roi) : rw,
      height = p.roi ? Math.min(rh, p.roi) : rh,
      ox = Math.floor((rw - width) / 2),
      oy = Math.floor((rh - height) / 2);
    return {
      rw,
      rh,
      width,
      height,
      ox,
      oy,
      samples: p.samples,
      bytes: rw * rh * 36 + width * height * 100,
      slots: width * height * p.samples,
    };
  }
  _texture(width, height, datatype = PixelDatatype.FLOAT) {
    const t = new Texture({
      context: this.scene.context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: datatype,
      flipY: false,
      sampler: nearest,
    });
    this._textures.push(t);
    const f = new Framebuffer({
      context: this.scene.context,
      colorTextures: [t],
      destroyAttachments: false,
    });
    this._framebuffers.push(f);
    return { texture: t, framebuffer: f };
  }
  _allocate(l) {
    const key = [l.rw, l.rh, l.width, l.height].join(":");
    if (this._layoutKey === key) {
      return;
    }
    this.release();
    try {
      this.receiver = new LumenReceiverPass();
      this.receiver.update(this.scene.context, l.rw, l.rh);
      this.hits = this._texture(l.width * 4, l.height);
      this.neighborhood = this._texture(
        l.width,
        l.height,
        PixelDatatype.UNSIGNED_BYTE,
      );
      this.ping = [
        this._texture(l.width, l.height),
        this._texture(l.width, l.height),
      ];
      const c = this.scene.context,
        gl = c._gl,
        binding = c._currentFramebuffer;
      try {
        for (const f of [this.receiver.framebuffer, ...this._framebuffers]) {
          if (f.status !== gl.FRAMEBUFFER_COMPLETE) {
            throw Error("FG framebuffer incomplete");
          }
        }
      } finally {
        if (binding) {
          binding._bind();
          gl.drawBuffers(binding._getActiveColorAttachments());
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.drawBuffers([gl.BACK]);
        }
        c._currentFramebuffer = binding;
      }
      this._layoutKey = key;
      this.metrics.memoryBytes = l.bytes;
      this.metrics.peakMemoryBytes = Math.max(
        this.metrics.peakMemoryBytes,
        l.bytes,
      );
    } catch (error) {
      this.release();
      throw error;
    }
  }
  _invalidateTimers() {
    const gl = this.scene.context._gl;
    this.metrics.disjoint++;
    for (const q of this._queries) {gl.deleteQuery(q.query);}
    this._queries.length = 0;
    this.metrics.incompleteTimerFrames += this._timerFrames.size;
    this._timerFrames.clear();
  }
  _poll() {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext) {return;}
    if (LumenGpuTimer.poll(this.scene.context, ext)) {return;}
    this._queries = this._queries.filter((q) => {
      if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE))
        {return true;}
      const ms = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
      const a =
        this.metrics.stages[q.stage] ?? (this.metrics.stages[q.stage] = []);
      a.push({ frame: q.frame, milliseconds: ms });
      if (a.length > 4096) {a.shift();}
      const frame = this._timerFrames.get(q.frame);
      if (frame) {
        frame.received++;
        frame.stages[q.stage] = (frame.stages[q.stage] ?? 0) + ms;
      }
      gl.deleteQuery(q.query);
      return false;
    });
    for (const [id, frame] of this._timerFrames) {
      if (frame.closed && frame.received === frame.submitted) {
        if (!frame.missing && frame.submitted) {
          this.metrics.completedTimings.push(frame);
          if (this.metrics.completedTimings.length > 2048)
            {this.metrics.completedTimings.shift();}
        } else {this.metrics.incompleteTimerFrames++;}
        this._timerFrames.delete(id);
      }
    }
  }
  _measure(stage, draw) {
    const gl = this.scene.context._gl,
      ext = this._timer;
    const id = this.scene.frameState.frameNumber;
    let frame = this._timerFrames.get(id);
    if (!frame) {
      frame = {
        frame: id,
        submitted: 0,
        received: 0,
        missing: 0,
        stages: {},
        closed: false,
        fgExecuted: false,
      };
      this._timerFrames.set(id, frame);
    }
    let query;
    if (
      ext &&
      this._queries.length < 128 &&
      !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
    ) {
      query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      frame.submitted++;
    } else {
      this.metrics.timingUnavailable++;
      frame.missing++;
    }
    try {
      return draw();
    } finally {
      if (stage === "forward") {frame.closed = true;}
      if (query) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        this._queries.push({
          query,
          stage,
          frame: this.scene.frameState.frameNumber,
        });
      }
    }
  }
  _draw(name, target, width, height) {
    const c = this.scene.context;
    if (!this._commands[name]) {
      const uniformMap = {};
      // A stable callback map addresses the currently retained immutable snapshot.
      for (const key of Object.keys(this._inputUniforms)) {
        uniformMap[key] = () => this._inputUniforms[key]();
      }
      Object.assign(uniformMap, {
        u_receiverPosition: () => this.receiver.position,
        u_receiverNormal: () => this.receiver.normal,
        u_receiverOffset: () => this.offset,
        u_fgStart: () => this._start,
        u_receiverHits: () => this.hits.texture,
        u_fgAccumulation: () => this._accumulation,
        u_fgRaw: () => this.texture,
        u_fgLocalToEye: () => this._localToEye,
        u_fgNeighborhoodScale: () => this.resultSize.y / this.receiverSize.y,
        u_fgNeedsNeighborhood: () => this.quality !== "roi",
        u_fgSamples: () => this.samples,
        u_fgSeed: () => this.seed,
        u_budget: () => this.traversalBudget,
        u_fgPreviousEnabled: () => this._input.round > 1,
      });
      this._commands[name] = c.createViewportQuadCommand(
        name === "receiverTrace"
          ? receiverTrace
          : name === "receiverShade"
            ? receiverShade
            : receiverNeighborhood,
        { uniformMap, owner: this },
      );
    }
    const cmd = this._commands[name];
    cmd.framebuffer = target;
    cmd.renderState = RenderState.fromCache({
      viewport: new BoundingRectangle(0, 0, width, height),
    });
    const pass = new PassState(c);
    pass.framebuffer = target;
    pass.viewport = new BoundingRectangle(0, 0, width, height);
    cmd.execute(c, pass);
    this.metrics.draws++;
  }
  executePrepared(passState, list) {
    const s = this.scene,
      w = this.lumen.world,
      fs = s.frameState;
    this.ready = false;
    if (this.mode === "ddgi" || !this.lumen.enabled) {
      return;
    }
    if (
      !this.model ||
      this.model.isDestroyed() ||
      !w?.ready ||
      w.isDestroyed() ||
      !w.finalGatherSnapshot
    ) {
      this.release();
      this.metrics.status = "DDGI fallback: no complete FG input";
      return;
    }
    if (w.finalGatherSnapshot.revision !== w.requestedRevision) {
      this.fallbackReason = 2;
      this.metrics.status = "DDGI fallback: waiting for matching revision";
      return;
    }
    if (
      fs.mode !== 3 ||
      !fs.passes.render ||
      fs.passes.pick ||
      fs.passes.depth ||
      s._useWebVR ||
      s._renderTranslucentDepthForPick
    ) {
      this.metrics.status = "DDGI fallback: unsupported view";
      return;
    }
    const local = Cartesian3.fromElements(
      w.eyeToLocal[12],
      w.eyeToLocal[13],
      w.eyeToLocal[14],
      new Cartesian3(),
    );
    if (Cartesian3.magnitude(local) > 2000) {
      this.metrics.status = "DDGI fallback: outside local view";
      return;
    }
    const l = this._layout(),
      snapshot = w.finalGatherSnapshot;
    // Budget checks precede every allocation and include the owned round copies.
    const snapshotBytes =
      (snapshot.previous?.sizeInBytes ?? 0) +
      (snapshot.current?.sizeInBytes ?? 0) +
      (snapshot.materials?.sizeInBytes ?? 0);
    if (
      !s.context.webgl2 ||
      !s.context.colorBufferFloat ||
      l.width * 4 > ContextLimits.maximumTextureSize ||
      l.rw > ContextLimits.maximumTextureSize ||
      l.rh > ContextLimits.maximumTextureSize ||
      l.bytes + snapshotBytes > this.maxMemoryBytes ||
      l.slots > this.maxRayInvocations ||
      !Number.isInteger(this.traversalBudget) ||
      this.traversalBudget < 1 ||
      this.traversalBudget > 4096
    ) {
      this.release();
      this.fallbackReason = 10;
      this.metrics.status = "DDGI fallback: capability or resource budget";
      return;
    }
    const cameraKey = [
      ...Matrix4.toArray(s.camera.viewMatrix),
      s.camera.frustum.fov,
      s.drawingBufferWidth,
      s.drawingBufferHeight,
      this.quality,
    ].map((value) => typeof value === "number" ? value.toPrecision(10) : value).join(":");
    if (
      this.freezeSampling &&
      this.texture &&
      this._sampleWorld === w &&
      this._sampleCameraKey === cameraKey
    ) {
      this.ready = true;
      return;
    }
    snapshot.retain();
    try {
      this._allocate(l);
      this._input = snapshot;
      this._inputUniforms = w.finalGatherUniforms(snapshot);
      this.samples = l.samples;
      Cartesian2.fromElements(l.rw, l.rh, this.receiverSize);
      Cartesian2.fromElements(l.width, l.height, this.resultSize);
      Cartesian2.fromElements(l.ox, l.oy, this.offset);
      Cartesian2.fromElements(
        s.drawingBufferWidth,
        s.drawingBufferHeight,
        this.sceneSize,
      );
      this.metrics.receiverDraws = this._measure("receiver", () =>
        this.receiver.execute(s, passState, list, l.rw, l.rh),
      );
      this._accumulation = this.ping[1].texture;
      for (let start = 0; start < l.samples; start += 4) {
        this._start = start;
        const index = (start / 4) % 2;
        this._measure("trace", () =>
          this._draw(
            "receiverTrace",
            this.hits.framebuffer,
            l.width * 4,
            l.height,
          ),
        );
        this._measure("shade", () =>
          this._draw(
            "receiverShade",
            this.ping[index].framebuffer,
            l.width,
            l.height,
          ),
        );
        this._accumulation = this.ping[index].texture;
      }
      this.texture = this._accumulation;
      Matrix4.inverse(w.eyeToLocal, this._localToEye);
      this._measure("neighborhood", () =>
        this._draw(
          "receiverNeighborhood",
          this.neighborhood.framebuffer,
          l.width,
          l.height,
        ),
      );
      this.ready = true;
      this.fallbackReason = 0;
      this._sampleWorld = w;
      this._sampleCameraKey = cameraKey;
      this.metrics.frames++;
      const timerFrame = this._timerFrames.get(fs.frameNumber);
      if (timerFrame) {
        timerFrame.fgExecuted = true;
        timerFrame.closed = !this.profileForward;
      }
      Object.assign(this.metrics, {
        status: "active experimental FG",
        revision: snapshot.revision,
        round: snapshot.round,
        versions: { ...snapshot.versions },
        quality: this.quality,
        resolution: [l.width, l.height],
        receiverResolution: [l.rw, l.rh],
        samples: l.samples,
        raySlots: l.slots,
        primaryRayUpperBound: l.slots,
        solarRayUpperBound: l.slots,
        traversalBudget: this.traversalBudget,
        snapshotBytes,
        totalAdditionalBytes: l.bytes + snapshotBytes,
      });
    } catch (error) {
      this.release();
      this.metrics.status = `DDGI fallback: ${error.message}`;
    } finally {
      snapshot.release();
      this._input = undefined;
    }
  }
  release() {
    this.ready = false;
    this.texture = undefined;
    this.neighborhood = this.hits = this.ping = undefined;
    this._layoutKey = undefined;
    this.receiver?.destroy();
    this.receiver = undefined;
    for (const f of this._framebuffers) {
      if (!f.isDestroyed()) {
        f.destroy();
      }
    }
    for (const t of this._textures) {
      if (!t.isDestroyed()) {
        t.destroy();
      }
    }
    this._textures = [];
    this._framebuffers = [];
    for (const cmd of Object.values(this._commands)) {
      if (!cmd.shaderProgram.isDestroyed()) {
        cmd.shaderProgram.destroy();
      }
    }
    this._commands = {};
    const gl = this.scene.context._gl;
    for (const q of this._queries) {
      gl.deleteQuery(q.query);
    }
    this._queries = [];
    this._timerFrames.clear();
    this.metrics.memoryBytes = 0;
    this.metrics.snapshotBytes =
      this.lumen.world?.finalGatherSnapshot?.resources.reduce(
        (sum, r) => sum + r.texture.sizeInBytes,
        0,
      ) ?? 0;
    this.metrics.totalAdditionalBytes = this.metrics.snapshotBytes;
  }
  isDestroyed() {
    return this._destroyed === true;
  }
  destroy() {
    if (this.isDestroyed()) {
      return;
    }
    this.release();
    this._unregisterTimer();
    this._destroyed = true;
    this.model = undefined;
    this.lumen = this.scene = undefined;
    return destroyLumenResource(this);
  }
}
LumenFinalGather.presets = presets;
export default LumenFinalGather;
