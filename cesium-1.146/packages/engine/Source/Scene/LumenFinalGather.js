import {
  Cartesian2,
  Cartesian3,
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
import { receiverTrace, receiverShade } from "./LumenGpuShaders.js";

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
    this._timer = this.scene.context._gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    );
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
      unknownFraction: "diagnostic-only; no production readback",
    };
  }
  configure({
    mode = this.mode,
    quality = this.quality,
    model = this.model,
  } = {}) {
    if (!["ddgi", "fg", "raw"].includes(mode) || !presets[quality])
      throw new DeveloperError("Invalid final gather mode or quality");
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
      if (changed) this.release();
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
      bytes: rw * rh * 36 + width * height * 96,
      slots: width * height * p.samples,
    };
  }
  _texture(width, height) {
    const t = new Texture({
      context: this.scene.context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
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
    if (this._layoutKey === key) return;
    this.release();
    try {
      this.receiver = new LumenReceiverPass();
      this.receiver.update(this.scene.context, l.rw, l.rh);
      this.hits = this._texture(l.width * 4, l.height);
      this.ping = [
        this._texture(l.width, l.height),
        this._texture(l.width, l.height),
      ];
      const c = this.scene.context,
        gl = c._gl,
        binding = c._currentFramebuffer;
      try {
        for (const f of [this.receiver.framebuffer, ...this._framebuffers])
          if (f.status !== gl.FRAMEBUFFER_COMPLETE)
            throw Error("FG framebuffer incomplete");
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
  _poll() {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    this._queries = this._queries.filter((q) => {
      if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE))
        return true;
      if (disjoint) this.metrics.disjoint++;
      else {
        const ms = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
        const a =
          this.metrics.stages[q.stage] ?? (this.metrics.stages[q.stage] = []);
        a.push({ frame: q.frame, milliseconds: ms });
        if (a.length > 4096) a.shift();
      }
      gl.deleteQuery(q.query);
      return false;
    });
  }
  _measure(stage, draw) {
    const gl = this.scene.context._gl,
      ext = this._timer;
    let query;
    if (
      ext &&
      this._queries.length < 128 &&
      !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
    ) {
      query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    } else this.metrics.timingUnavailable++;
    try {
      return draw();
    } finally {
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
      for (const key of Object.keys(this._inputUniforms))
        uniformMap[key] = () => this._inputUniforms[key]();
      Object.assign(uniformMap, {
        u_receiverPosition: () => this.receiver.position,
        u_receiverNormal: () => this.receiver.normal,
        u_receiverOffset: () => this.offset,
        u_fgStart: () => this._start,
        u_receiverHits: () => this.hits.texture,
        u_fgAccumulation: () => this._accumulation,
        u_fgSamples: () => this.samples,
        u_fgSeed: () => this.seed,
        u_budget: () => this.traversalBudget,
        u_fgPreviousEnabled: () => this._input.round > 1,
      });
      this._commands[name] = c.createViewportQuadCommand(
        name === "receiverTrace" ? receiverTrace : receiverShade,
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
    if (this.mode === "ddgi" || !this.lumen.enabled) return;
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
      this.metrics.status = "DDGI fallback: capability or resource budget";
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
      this.metrics.frames++;
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
      this.ready = true;
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
      this.metrics.status = "DDGI fallback: " + error.message;
    } finally {
      snapshot.release();
      this._input = undefined;
    }
  }
  release() {
    this.ready = false;
    this.texture = undefined;
    this._layoutKey = undefined;
    this.receiver?.destroy();
    this.receiver = undefined;
    for (const f of this._framebuffers) if (!f.isDestroyed()) f.destroy();
    for (const t of this._textures) if (!t.isDestroyed()) t.destroy();
    this._textures = [];
    this._framebuffers = [];
    for (const cmd of Object.values(this._commands))
      if (!cmd.shaderProgram.isDestroyed()) cmd.shaderProgram.destroy();
    this._commands = {};
    const gl = this.scene.context._gl;
    for (const q of this._queries) gl.deleteQuery(q.query);
    this._queries = [];
    this.metrics.memoryBytes = 0;
  }
  destroy() {
    this.release();
    this.model = undefined;
    this.lumen = this.scene = undefined;
  }
}
LumenFinalGather.presets = presets;
export default LumenFinalGather;
