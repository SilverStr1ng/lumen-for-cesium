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
import planFinalGather from "./LumenFinalGatherPlan.js";
import LumenFinalGatherReconstruction from "./LumenFinalGatherReconstruction.js";
import {
  receiverTrace,
  receiverFused,
  receiverShade,
  receiverNeighborhood,
} from "./LumenGpuShaders.js";

// Quality sets resolution/sample count; the sampling policy controls history.
const presets = Object.freeze({
  ...planFinalGather.presets,
  auto: Object.freeze({ auto: true }),
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
    this.sampling = "fixed-reference";
    this.reconstructionEnabled = true;
    this.execution = "split";
    this.rayOrder = "azimuth";
    this.lazyFallback = true;
    this.sequenceEpoch = undefined;
    this._sampleEpoch = 0;
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
    this._profileFrame = undefined;
    this.receiverSize = new Cartesian2(1, 1);
    this.resultSize = new Cartesian2(1, 1);
    this.offset = new Cartesian2();
    this.sceneSize = new Cartesian2(1, 1);
    this._currentVP = new Matrix4();
    this._stableFrames = 0;
    this._plan = undefined;
    this._planKey = undefined;
    this.continuousSampling = false;
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
    sampling = this.sampling,
    reconstruction = this.reconstructionEnabled,
    execution = this.execution,
    rayOrder = this.rayOrder,
    lazyFallback = this.lazyFallback,
    seed = this.seed,
    sequenceEpoch = this.sequenceEpoch,
  } = {}) {
    // null explicitly clears a deterministic override; omission preserves it.
    if (sequenceEpoch === null) {
      sequenceEpoch = undefined;
    }
    if (!["ddgi", "fg", "raw"].includes(mode) || !presets[quality]) {
      throw new DeveloperError("Invalid final gather mode or quality");
    }
    if (
      !["fixed-reference", "scrambled-single-frame", "reconstructed"].includes(
        sampling,
      ) ||
      !Number.isInteger(seed) ||
      seed < -2147483648 ||
      seed > 2147483647 ||
      (sequenceEpoch !== undefined &&
        (!Number.isInteger(sequenceEpoch) ||
          sequenceEpoch < 0 ||
          sequenceEpoch > 4294967295))
    ) {
      throw new DeveloperError("Invalid FG sampling contract");
    }
    const changed =
      this.quality !== quality ||
      this.model !== model ||
      this.sampling !== sampling ||
      this.reconstructionEnabled !== reconstruction ||
      this.execution !== execution ||
      this.rayOrder !== rayOrder ||
      this.seed !== seed ||
      this.sequenceEpoch !== sequenceEpoch;
    if (!["split", "fused4", "fused8"].includes(execution)) {
      throw new DeveloperError("Invalid FG execution backend");
    }
    if (!["original", "azimuth"].includes(rayOrder)) {
      throw new DeveloperError("Invalid FG ray ordering");
    }
    if (
      typeof reconstruction !== "boolean" ||
      typeof lazyFallback !== "boolean"
    ) {
      throw new DeveloperError(
        "FG reconstruction and lazy fallback must be boolean",
      );
    }
    this.lazyFallback = lazyFallback;
    this.rayOrder = rayOrder;
    this.execution = execution;
    this.reconstructionEnabled = reconstruction;
    this.sampling = sampling;
    this.seed = seed;
    this.sequenceEpoch = sequenceEpoch;

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
    // Reserve space for a complete frame of queries. Skip instrumentation as a
    // group under query latency instead of filling the cap halfway through FG.
    this._profileFrame = this._queries.length <= 32;
  }
  supported(model, frameState) {
    return (
      this.model === model &&
      !model?.isDestroyed() &&
      this.mode !== "ddgi" &&
      this.lumen.enabled &&
      ContextLimits.maximumTextureImageUnits >= 13 &&
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
      this.supported(model, frameState) &&
      this._sampleWorld === this.lumen.world &&
      this.lumen.world?.ready &&
      !this.lumen.world.isDestroyed() &&
      this.lumen.world.requestedRevision === this.metrics.revision
    );
  }
  _layout(snapshotBytes = 0) {
    const s = this.scene,
      c = s.context;
    const input = {
      width: s.drawingBufferWidth,
      height: s.drawingBufferHeight,
      quality: this.quality,
      execution: this.execution,
      rayOrder: this.rayOrder,
      reconstruction:
        this.sampling === "reconstructed" && this.reconstructionEnabled,
      snapshotBytes,
      memoryBudget: this.maxMemoryBytes,
      invocationBudget: this.maxRayInvocations,
      maximumTextureSize: ContextLimits.maximumTextureSize,
      maximumRenderbufferSize: ContextLimits.maximumRenderbufferSize,
      samplerUnits: ContextLimits.maximumTextureImageUnits,
      requiredSamplers: LumenReceiverPass.requiredSamplers(this.model),
      colorAttachments: ContextLimits.maximumColorAttachments,
      floatRenderable: !!c?.webgl2 && !!c.colorBufferFloat,
    };
    const key = JSON.stringify(input);
    if (this._planKey !== key) {
      this._plan = planFinalGather(input);
      this._planKey = key;
      this.metrics.planChanges = (this.metrics.planChanges ?? 0) + 1;
    }
    return this._plan;
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
  _allocationKey(l) {
    return [
      l.rw,
      l.rh,
      l.width,
      l.height,
      this.execution,
      this.sampling === "reconstructed" && this.reconstructionEnabled,
    ].join(":");
  }
  _allocate(l) {
    const key = this._allocationKey(l);
    if (this._layoutKey === key) {
      return;
    }
    this.release();
    try {
      this.receiver = new LumenReceiverPass();
      this.receiver.update(this.scene.context, l.rw, l.rh);
      if (this.execution === "split") {
        this.hits = this._texture(l.width * 4, l.height);
      }
      this.neighborhood = this._texture(
        l.width,
        l.height,
        PixelDatatype.UNSIGNED_BYTE,
      );
      this.ping = [
        this._texture(l.width, l.height),
        this._texture(l.width, l.height),
      ];
      if (this.sampling === "reconstructed" && this.reconstructionEnabled) {
        this.reconstruction = new LumenFinalGatherReconstruction(this);
        this.reconstruction.update(l.width, l.height);
      }
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
    for (const q of this._queries) {
      gl.deleteQuery(q.query);
    }
    this._queries.length = 0;
    this.metrics.incompleteTimerFrames += this._timerFrames.size;
    this._timerFrames.clear();
  }
  _poll() {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext) {
      return;
    }
    if (LumenGpuTimer.poll(this.scene.context, ext)) {
      return;
    }
    this._queries = this._queries.filter((q) => {
      if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) {
        return true;
      }
      const ms = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
      const a =
        this.metrics.stages[q.stage] ?? (this.metrics.stages[q.stage] = []);
      a.push({ frame: q.frame, milliseconds: ms });
      if (a.length > 4096) {
        a.shift();
      }
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
          if (this.metrics.completedTimings.length > 2048) {
            this.metrics.completedTimings.shift();
          }
        } else {
          this.metrics.incompleteTimerFrames++;
        }
        this._timerFrames.delete(id);
      }
    }
  }
  _measure(stage, draw) {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext || this._profileFrame === false) {
      this.metrics.timingUnavailable++;
      return draw();
    }
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
      if (stage === "forward") {
        frame.closed = true;
      }
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
        u_receiverHits: () => this.hits?.texture ?? c.defaultTexture,
        u_fgAccumulation: () => this._accumulation,
        u_fgRaw: () => this.texture,
        u_fgLocalToEye: () => this._localToEye,
        u_fgNeighborhoodScale: () => this.resultSize.y / this.receiverSize.y,
        u_fgNeedsNeighborhood: () => this.quality !== "roi",
        u_fgSamples: () => this.samples,
        u_fgSeed: () => this.seed,
        u_fgRayOrder: () => (this.rayOrder === "azimuth" ? 1 : 0),
        u_fgSampling: () =>
          this.sampling === "fixed-reference"
            ? 0
            : this.sampling === "reconstructed"
              ? 2
              : 1,
        u_fgEpoch: () => this._epochForFrame | 0,
        u_fgPixelOffset: () => Cartesian2.ZERO,
        u_budget: () => this.traversalBudget,
        u_fgPreviousEnabled: () => this._input.round > 1,
      });
      this._commands[name] = c.createViewportQuadCommand(
        name.startsWith("receiverFused")
          ? receiverFused(Number(name.slice(-1)))
          : name === "receiverTrace"
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
    this.metrics.effectiveMode = "ddgi";
    this.fallbackReason = 1;
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
      this.fallbackReason = 2;
      this.metrics.status = "DDGI fallback: no complete FG input";
      return;
    }
    if (w.finalGatherSnapshot.revision !== w.requestedRevision) {
      this.fallbackReason = 2;
      this.reconstruction?.invalidate("requested revision unavailable");
      this._stableFrames = 0;
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
      this.fallbackReason = 9;
      this.metrics.status = "DDGI fallback: outside local view";
      return;
    }
    const snapshot = w.finalGatherSnapshot;
    // Budget checks precede every allocation and include the owned round copies.
    const snapshotBytes =
      (snapshot.previous?.sizeInBytes ?? 0) +
      (snapshot.current?.sizeInBytes ?? 0) +
      (snapshot.materials?.sizeInBytes ?? 0);
    const l = this._layout(snapshotBytes);
    this.metrics.requestedMode = this.mode;
    this.metrics.requestedQuality = this.quality;
    this.metrics.plan = l;
    if (
      !l.supported ||
      !s.context.webgl2 ||
      !s.context.colorBufferFloat ||
      l.width * (this.execution === "split" ? 4 : 1) >
        ContextLimits.maximumTextureSize ||
      l.rw > ContextLimits.maximumTextureSize ||
      l.rh > ContextLimits.maximumTextureSize ||
      l.bytes + snapshotBytes > this.maxMemoryBytes ||
      l.slots + l.geometrySlots > this.maxRayInvocations ||
      !Number.isInteger(this.traversalBudget) ||
      this.traversalBudget < 1 ||
      this.traversalBudget > 4096
    ) {
      this.release();
      this.fallbackReason = 10;
      this.metrics.effectiveMode = "ddgi";
      const reason = !l.supported
        ? l.reason
        : "invalid traversal budget or device capability";
      this.metrics.fallbackReason = reason;
      this.metrics.status = `DDGI fallback: ${reason}`;
      return;
    }
    const allocationKey = this._allocationKey(l),
      allocationMatches = this._layoutKey === allocationKey;
    const cameraKey = [
      ...Matrix4.toArray(s.camera.viewMatrix),
      ...Matrix4.toArray(s.camera.frustum.projectionMatrix),
      s.camera.frustum.near,
      s.camera.frustum.far,
      s.drawingBufferWidth,
      s.drawingBufferHeight,
      this.quality,
    ]
      .map((value) =>
        typeof value === "number" ? value.toPrecision(10) : value,
      )
      .join(":");
    if (
      allocationMatches &&
      this.freezeSampling &&
      this.texture &&
      this._sampleWorld === w &&
      this.metrics.revision === snapshot.revision &&
      this.metrics.round === snapshot.round &&
      this._sampleCameraKey === cameraKey
    ) {
      this.ready = true;
      this.metrics.effectiveMode = "fg";
      this.fallbackReason = 0;
      return;
    }
    const reconstructionKey = JSON.stringify([
      snapshot.revision,
      snapshot.round,
      snapshot.versions,
      Matrix4.toArray(w.inverseFrame),
      this.quality,
      this.seed,
      this.sampling,
      this.sequenceEpoch,
      allocationKey,
    ]);
    const cameraChanged = this._historyCameraKey !== cameraKey;
    if (
      this.sampling === "reconstructed" &&
      this.reconstructionEnabled &&
      this.reconstruction &&
      allocationMatches &&
      this._historyWorld === w &&
      this._historyKey === reconstructionKey &&
      !cameraChanged &&
      (this._stableFrames >= this.reconstruction.targetFrames ||
        (this.sequenceEpoch !== undefined &&
          this._sampleCameraKey === cameraKey)) &&
      !this.continuousSampling
    ) {
      this.ready = true;
      this.fallbackReason = 0;
      this.metrics.effectiveMode = "fg";
      this.metrics.status = "experimental FG: accumulation paused";
      return;
    }
    if (
      cameraChanged ||
      this._historyWorld !== w ||
      this._historyKey !== reconstructionKey
    ) {
      this._stableFrames = 0;
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
      this._epochForFrame = this.sequenceEpoch ?? this._sampleEpoch;
      this._accumulation = this.ping[1].texture;
      const chunk = this.execution === "fused8" ? 8 : 4;
      for (let start = 0; start < l.samples; start += chunk) {
        this._start = start;
        const index = (start / chunk) % 2;
        if (this.execution === "split") {
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
        } else {
          this._measure("traceShade", () =>
            this._draw(
              `receiverFused${chunk}`,
              this.ping[index].framebuffer,
              l.width,
              l.height,
            ),
          );
        }
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
      if (this.reconstruction) {
        Matrix4.multiply(
          s.camera.frustum.projectionMatrix,
          this._localToEye,
          this._currentVP,
        );
        const eye = Cartesian3.fromElements(
          w.eyeToLocal[12],
          w.eyeToLocal[13],
          w.eyeToLocal[14],
          new Cartesian3(),
        );
        const direction = Cartesian3.normalize(
          Cartesian3.fromElements(
            -w.eyeToLocal[8],
            -w.eyeToLocal[9],
            -w.eyeToLocal[10],
            new Cartesian3(),
          ),
          new Cartesian3(),
        );
        if (this._historyWorld !== w) {
          this.reconstruction.invalidate("world generation");
        }
        this.reconstruction.execute({
          key: reconstructionKey,
          raw: this.texture,
          receiver: this.receiver,
          neighborhood: this.neighborhood.texture,
          vp: this._currentVP,
          localToEye: this._localToEye,
          epoch: this._epochForFrame,
          eye,
          direction,
        });
        if (this.reconstruction.addedInformation) {
          this._stableFrames++;
        }
        this._historyWorld = w;
        this._historyKey = reconstructionKey;
        this._historyCameraKey = cameraKey;
        this.metrics.accumulationPasses = this.reconstruction.frames;
        this.metrics.stablePasses = this._stableFrames;
        this.metrics.history = true;
        this.metrics.historyReset = this.reconstruction.reason;
        if (
          this.sequenceEpoch === undefined &&
          this._stableFrames < this.reconstruction.targetFrames
        ) {
          s.requestRender();
        }
      }
      this.ready = true;
      this.fallbackReason = 0;

      this._sampleWorld = w;
      this._sampleCameraKey = cameraKey;
      this.metrics.frames++;
      this.metrics.sampleEpoch = this._epochForFrame;
      this.metrics.sampling = this.sampling;
      this._sampleEpoch = (this._sampleEpoch + 1) >>> 0;
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
        effectiveMode: "fg",
        fallbackReason: "none",
        effectiveQuality: l.effectiveQuality,
        execution: this.execution,
        rayOrder: this.rayOrder,
        reconstructionEnabled: this.reconstructionEnabled,
        lazyFallback: this.lazyFallback,
        samples: l.samples,
        raySlots: l.slots,
        primaryRayUpperBound: l.slots,
        solarRayUpperBound: l.slots,
        traversalBudget: this.traversalBudget,
        geometryRayUpperBound: l.geometrySlots,
        snapshotBytes,
        totalAdditionalBytes: l.bytes + snapshotBytes,
        peakAdditionalBytes: Math.max(
          this.metrics.peakAdditionalBytes ?? 0,
          l.bytes + snapshotBytes,
        ),
      });
    } catch (error) {
      this.release();
      this.fallbackReason = 10;
      this.metrics.status = `DDGI fallback: ${error.message}`;
    } finally {
      snapshot.release();
      this._input = undefined;
    }
  }
  release() {
    this.ready = false;
    this.texture = undefined;
    this._sampleWorld = this._inputUniforms = this._input = undefined;
    this.reconstruction?.destroy();
    this.reconstruction = undefined;
    this._historyWorld = this._historyKey = this._historyCameraKey = undefined;
    this._stableFrames = 0;
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
    this.metrics.history = false;
    this.metrics.accumulationPasses = 0;
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
