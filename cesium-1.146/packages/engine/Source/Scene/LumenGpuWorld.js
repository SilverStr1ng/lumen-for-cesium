import {
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Matrix4,
  BoundingRectangle,
  PixelDatatype,
  PixelFormat,
  Color,
  DeveloperError,
  Event,
} from "@cesium/core";
import Texture from "../Renderer/Texture.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import PassState from "../Renderer/PassState.js";
import RenderState from "../Renderer/RenderState.js";
import Sampler from "../Renderer/Sampler.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import ContextLimits from "../Renderer/ContextLimits.js";
import * as shaders from "./LumenGpuShaders.js";
import LumenProbeDisplay from "./LumenProbeDisplay.js";
import LumenGpuTimer from "./LumenGpuTimer.js";
import LumenFinalGatherSnapshot from "./LumenFinalGatherSnapshot.js";

const defaultGatherControl = new Cartesian4(0, 0, -1, -1);
const nearest = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
});
const linear = new Sampler({
  minificationFilter: TextureMinificationFilter.LINEAR,
  magnificationFilter: TextureMagnificationFilter.LINEAR,
});
function immutableOptions(options) {
  const result = { ...options };
  for (const key of [
    "sunDirection",
    "sunRadiance",
    "skyRadiance",
    "neutralMaterials",
  ]) {
    if (result[key]) {
      result[key] = Object.freeze([...result[key]]);
    }
  }
  if (result.materialOverrides) {
    result.materialOverrides = Object.freeze(
      result.materialOverrides.map((m) =>
        Object.freeze({
          ...m,
          baseColorFactor: m.baseColorFactor
            ? Object.freeze([...m.baseColorFactor])
            : undefined,
          emissiveFactor: m.emissiveFactor
            ? Object.freeze([...m.emissiveFactor])
            : undefined,
        }),
      ),
    );
  }
  return Object.freeze(result);
}

/** Static geometry, GPU intersections, ray-addressed surface cache and snapshot DDGI.
 * No readback or CPU lighting in update(). Diagnostic APIs explicitly synchronize.
 * @private
 */
class LumenGpuWorld {
  constructor(scene, options) {
    if (!scene.context.webgl2 || !scene.context.colorBufferFloat) {
      throw new DeveloperError(
        "GPU DDGI requires WebGL2 and EXT_color_buffer_float",
      );
    }
    this.scene = scene;
    this.options = {
      spacing: 2,
      rays: 128,
      bounces: 3,
      traversalBudget: 4096,
      targetGpuMilliseconds: 3,
      maxBatch: 128,
      integrationMode: "arithmetic",
      diagnosticIntegrationLut: false,
      publicationMode: "snapshot",
      environmentMode: "sphere",
      bvhStrategy: "sah",
      bvhBins: 12,
      visibilityMode: "optimized",
      reconstructionMode: "spatial",
      displayTransitionMilliseconds: 0,
      ...options,
    };
    this._validate(this.options);
    this.displayTransitionMilliseconds =
      this.options.displayTransitionMilliseconds;
    this.options = immutableOptions(this.options);
    this.inverseFrame = Matrix4.inverse(options.modelMatrix, new Matrix4());
    this.eyeToLocal = new Matrix4();
    this.origin = new Cartesian3();
    this.counts = new Cartesian3();
    this.spacing = this.options.spacing;
    this.gain = 1;
    this.ready = false;
    this.status = "loading GPU geometry";
    this.revision = 1;
    this.settledRevision = 0;
    this.publicationEvent = new Event();
    this._requestedAt = performance.now();
    this.memoryBytes = 0;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 192 * 1048576;
    this.linearAtlas = scene.context.textureFloatLinear;
    this._textures = [];
    this._framebuffers = [];
    this._commands = {};
    this._fgSnapshots = new Set();
    this._captureFinalGather = !!options.captureFinalGather;
    this._requests = new Map();
    this._requestId = 0;
    this._queries = [];
    this._batches = {};
    this._costs = {};
    this.versions = {
      geometry: 1,
      rayLayout: 1,
      material: 1,
      sunVisibility: 0,
      lighting: 1,
    };
    this.metrics = {
      passes: {},
      disjoint: 0,
      updates: [],
      productionReadbacks: 0,
      diagnosticReadbacks: 0,
      cpuSchedulingMilliseconds: 0,
      submittedFrames: 0,
      submittedBatches: 0,
      timerMissing: 0,
      queryQueuePeak: 0,
      memory: { currentBytes: 0, peakBytes: 0, textures: 0, framebuffers: 0 },
      initialStages: {},
      work: {
        probeHitInvocations: 0,
        sunVisibilitySubmittedSlots: 0,
        momentProbeUpdates: 0,
      },
    };
    this._timer = scene.context._gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    );
    this.worker = new Worker(options.workerUrl, { type: "module" });
    this._promise();
    this.worker.onmessage = ({ data }) => {
      if (this._closed) {
        return;
      }
      if (data.type === "prepared") {
        this._prepared = data.packet;
      }
      if (data.type === "progress") {
        this.status = data.phase;
      }
      if (data.type === "error") {
        this._fail(new Error(data.message));
      }
      if (data.type === "response") {
        this._requests.get(data.id)?.resolve(data.result);
        this._requests.delete(data.id);
      }
      scene.requestRender();
    };
    this.worker.onerror = (e) => this._fail(new Error(e.message));
    try {
      this.worker.postMessage({
        type: "load",
        url: options.url,
        axisMatrix: options.axisMatrix,
        options: {
          ...this.options,
          maxTextureSize: ContextLimits.maximumTextureSize,
        },
      });
    } catch (error) {
      this._closed = true;
      this.worker.terminate();
      throw error;
    }
    this._unregisterTimer = LumenGpuTimer.register(scene.context, () =>
      this._invalidateTimers(),
    );
  }
  _validate(o) {
    if (
      !Number.isFinite(o.displayTransitionMilliseconds) ||
      o.displayTransitionMilliseconds < 0 ||
      o.displayTransitionMilliseconds > 250
    ) {
      throw new DeveloperError(
        "display transition must be finite in [0,250] ms",
      );
    }
    if (!["spatial", "legacy"].includes(o.reconstructionMode)) {
      throw new DeveloperError("reconstructionMode must be spatial or legacy");
    }
    if (!["sphere", "upper-hemisphere"].includes(o.environmentMode)) {
      throw new DeveloperError(
        "environmentMode must be sphere or upper-hemisphere",
      );
    }
    if (
      !["median", "sah"].includes(o.bvhStrategy) ||
      !Number.isInteger(o.bvhBins) ||
      o.bvhBins < 4 ||
      o.bvhBins > 64
    ) {
      throw new DeveloperError(
        "bvhStrategy median/sah and bvhBins in [4,64] required",
      );
    }
    if (!["reference", "optimized"].includes(o.visibilityMode)) {
      throw new DeveloperError("visibilityMode must be reference or optimized");
    }
    if (!["snapshot", "progressive"].includes(o.publicationMode)) {
      throw new DeveloperError(
        "publicationMode must be snapshot or progressive",
      );
    }
    if (!["lut", "arithmetic"].includes(o.integrationMode)) {
      throw new DeveloperError("integrationMode must be lut or arithmetic");
    }
    if (o.integrationMode === "lut" && !o.diagnosticIntegrationLut) {
      throw new DeveloperError(
        "LUT is available only in diagnosticIntegrationLut runs",
      );
    }
    if (
      !Number.isFinite(o.spacing) ||
      o.spacing <= 0 ||
      !Number.isInteger(o.rays) ||
      o.rays < 32 ||
      o.rays > 512 ||
      !Number.isInteger(o.bounces) ||
      o.bounces < 1 ||
      o.bounces > 8
    ) {
      throw new DeveloperError(
        "GPU spacing > 0, rays in [32,512], bounces in [1,8] required",
      );
    }
    if (
      !Number.isInteger(o.traversalBudget) ||
      o.traversalBudget < 1 ||
      o.traversalBudget > 4096
    ) {
      throw new DeveloperError("GPU traversalBudget must be in [1,4096]");
    }
    if (
      !Number.isFinite(o.targetGpuMilliseconds) ||
      o.targetGpuMilliseconds <= 0 ||
      !Number.isInteger(o.maxBatch) ||
      o.maxBatch < 1 ||
      o.maxBatch > 256
    ) {
      throw new DeveloperError(
        "Positive GPU time budget and maxBatch in [1,256] required",
      );
    }
    for (const name of ["sunRadiance", "skyRadiance"]) {
      if (
        o[name] &&
        (o[name].length !== 3 ||
          o[name].some((v) => !Number.isFinite(v) || v < 0))
      ) {
        throw new DeveloperError(`${name} must be finite nonnegative RGB`);
      }
    }
    if (
      o.sunDirection &&
      (o.sunDirection.length !== 3 ||
        !o.sunDirection.every(Number.isFinite) ||
        Math.hypot(...o.sunDirection) < 1e-10)
    ) {
      throw new DeveloperError("sunDirection must be finite and nonzero");
    }
    if (
      o.neutralMaterials &&
      (o.neutralMaterials.length > 2 ||
        o.neutralMaterials.some((v) => !Number.isInteger(v) || v < 0))
    ) {
      throw new DeveloperError(
        "GPU neutralMaterials supports at most two nonnegative material IDs",
      );
    }
    if (o.materialOverrides) {
      if (!Array.isArray(o.materialOverrides)) {
        throw new DeveloperError("materialOverrides must be an array");
      }
      for (const m of o.materialOverrides) {
        if (
          !Number.isInteger(m.id) ||
          m.id < 0 ||
          (this._materials && m.id >= this._materials.height) ||
          Object.keys(m).some(
            (k) =>
              ![
                "id",
                "baseColorFactor",
                "emissiveFactor",
                "metallicFactor",
              ].includes(k),
          )
        ) {
          throw new DeveloperError(
            "Only existing static material RGB/emission/metallic factors may change; alpha or sidedness require reload",
          );
        }
        for (const key of ["baseColorFactor", "emissiveFactor"]) {
          if (
            m[key] &&
            (m[key].length !== 3 ||
              m[key].some(
                (v) =>
                  !Number.isFinite(v) ||
                  v < 0 ||
                  (key === "baseColorFactor" && v > 1),
              ))
          ) {
            throw new DeveloperError(
              `${key} must be finite RGB; reflectance must be in [0,1]`,
            );
          }
        }
        if (
          m.metallicFactor !== undefined &&
          (!Number.isFinite(m.metallicFactor) ||
            m.metallicFactor < 0 ||
            m.metallicFactor > 1)
        ) {
          throw new DeveloperError("metallicFactor must be in [0,1]");
        }
      }
    }
  }
  _promise() {
    this.completed = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // A caller may use solve() without observing the initial load promise.
    this.completed.catch(() => {});
    this.firstPublished = new Promise((resolve, reject) => {
      this._resolveFirst = resolve;
      this._rejectFirst = reject;
    });
    this.firstPublished.catch(() => {});
  }
  get requestedRevision() {
    return this.revision;
  }
  get activeRevision() {
    return this._phase === "ready" || this._closed
      ? 0
      : (this._jobRevision ?? 0);
  }
  get publishedRevision() {
    return this.packet?.revision ?? 0;
  }
  get publishedBounce() {
    return this.packet?.bounce ?? 0;
  }
  atlasState() {
    return {
      requestedRevision: this.requestedRevision,
      activeRevision: this.activeRevision,
      publishedRevision: this.publishedRevision,
      publishedBounce: this.publishedBounce,
      settledRevision: this.settledRevision,
      published: this._published,
      read: this._phase === "ready" ? undefined : this._previous,
      write: this._phase === "ready" ? undefined : this._target,
      atlases: this._atlasMetadata?.map((m) => ({ ...m })),
      pending: this._pendingLighting ? this.revision : undefined,
    };
  }
  _texture(
    width,
    height,
    datatype = PixelDatatype.FLOAT,
    data,
    filter = nearest,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > ContextLimits.maximumTextureSize ||
      height > ContextLimits.maximumTextureSize
    ) {
      throw new Error("GPU texture exceeds device limit");
    }
    const bytes = width * height * 4 * PixelDatatype.sizeInBytes(datatype);
    if (this.memoryBytes + bytes > this.maxMemoryBytes) {
      throw new Error("GPU DDGI texture memory budget exceeded");
    }
    const t = new Texture({
      context: this.scene.context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: datatype,
      flipY: false,
      sampler: filter,
      source: data ? { width, height, arrayBufferView: data } : undefined,
    });
    this._textures.push(t);
    this.memoryBytes += bytes;
    this.metrics.memory.currentBytes = this.memoryBytes;
    this.metrics.memory.peakBytes = Math.max(
      this.metrics.memory.peakBytes,
      this.memoryBytes,
    );
    this.metrics.memory.textures = this._textures.length;
    return t;
  }
  _framebuffer(textures) {
    const c = this.scene.context,
      gl = c._gl,
      binding = c._currentFramebuffer;
    const f = new Framebuffer({
      context: c,
      colorTextures: textures,
      destroyAttachments: false,
    });
    this._framebuffers.push(f);
    this.metrics.memory.framebuffers = this._framebuffers.length;
    try {
      const status = f.status;
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw Error(`GPU framebuffer incomplete: ${status}`);
      }
      new ClearCommand({ framebuffer: f, color: Color.TRANSPARENT }).execute(c);
      return f;
    } catch (error) {
      f.destroy();
      this._framebuffers = this._framebuffers.filter((fb) => fb !== f);
      this.metrics.memory.framebuffers = this._framebuffers.length;
      throw error;
    } finally {
      if (binding && !binding.isDestroyed()) {
        binding._bind();
        gl.drawBuffers(binding._getActiveColorAttachments());
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.drawBuffers([gl.BACK]);
      }
      c._currentFramebuffer =
        binding && !binding.isDestroyed() ? binding : undefined;
    }
  }
  _freeTexture(texture, fb) {
    if (fb && !fb.isDestroyed()) {
      fb.destroy();
    }
    if (!texture.isDestroyed()) {
      this.memoryBytes -= texture.sizeInBytes;
      texture.destroy();
    }
    this._textures = this._textures.filter((t) => t !== texture);
    this._framebuffers = this._framebuffers.filter((f) => f !== fb);
    Object.assign(this.metrics.memory, {
      currentBytes: this.memoryBytes,
      textures: this._textures.length,
      framebuffers: this._framebuffers.length,
    });
  }
  setFinalGatherCapture(enabled) {
    this._captureFinalGather = !!enabled;
    if (!enabled) {
      this.finalGatherSnapshot?.release();
      this.finalGatherSnapshot = undefined;
    }
    this.scene.requestRender();
  }
  finalGatherUniforms(snapshot, exact = this._fgExact ?? false) {
    snapshot.assertAlive();
    const base = this._uniforms(),
      g = snapshot.geometry;
    return {
      ...base,
      u_nodes: () => g.nodes,
      u_vertices: () => g.vertices,
      u_uv: () => g.uv,
      u_atlas: () => g.atlas,
      u_materials: () => snapshot.materials,
      u_sunDirection: () => snapshot.light.sunDirection,
      u_sunRadiance: () => snapshot.light.sunRadiance,
      u_skyRadiance: () => snapshot.light.skyRadiance,
      u_upperHemisphere: () => snapshot.light.upperHemisphere,
      u_neutral: () => snapshot.light.neutral,
      u_lumenProbeIrradiance: () =>
        exact ? snapshot.current : snapshot.previous,
      u_lumenProbeDistances: () => snapshot.moments,
      u_lumenProbePositions: () => snapshot.positions,
      u_lumenProbeOrigin: () => snapshot.origin,
      u_lumenProbeCounts: () => snapshot.counts,
      u_lumenProbeSpacing: () => snapshot.spacing,
      u_lumenNormalBias: () => snapshot.normalBias,
      u_lumenLegacyKernel: () =>
        snapshot.options.reconstructionMode === "legacy",
      u_lumenGatherControl: () => defaultGatherControl,
      u_budget: () => this._fgBudget ?? snapshot.options.traversalBudget,
      u_fgPreviousEnabled: () => snapshot.round > 1,
      u_fgSamples: () => this._fgSamples ?? 32,
      u_fgSeed: () => this._fgSeed ?? 0,
      u_fgRayOrder: () => 0,
      u_fgSampling: () => this._fgSampling ?? 0,
      u_fgEpoch: () => this._fgEpoch ?? 0,
      u_fgPixelOffset: () => this._fgPixelOffset ?? Cartesian2.ZERO,
      u_fgRayBias: () => 0.0002,
    };
  }
  _initialize(p) {
    const g = p.grid;
    this._order = p.order;
    this.packet = {
      grid: g,
      bvh: p.bvh,
      cache: { surfels: g.total * g.rays, addressing: "probe-ray hit surfels" },
      bounce: 0,
      history: [],
    };
    this.origin = Cartesian3.fromArray(g.origin, 0, this.origin);
    this.counts = Cartesian3.fromArray(g.counts, 0, this.counts);
    this.normalBias = g.normalBias;
    this._baseMaterials = p.materials.data.slice();
    this._overrideKey = "[]";
    for (const name of ["nodes", "vertices", "uv", "materials", "atlas"]) {
      const a = p[name];
      this[`_${name}`] = this._texture(
        a.width,
        a.height,
        name === "atlas" ? PixelDatatype.UNSIGNED_BYTE : PixelDatatype.FLOAT,
        a.data,
      );
    }
    const pw = g.counts[0] * g.counts[1],
      ph = g.counts[2];
    this._initialPositions = this._texture(pw, ph);
    this.positionTexture = this._texture(pw, ph);
    this._hits = this._texture(g.rays, g.total);
    this._visibility = this._texture(
      g.rays,
      g.total,
      PixelDatatype.UNSIGNED_BYTE,
    );
    this._direct = this._texture(g.rays, g.total, PixelDatatype.HALF_FLOAT);
    this._cache = this._texture(g.rays, g.total, PixelDatatype.HALF_FLOAT);
    this._positionFB = this._framebuffer([this._initialPositions]);
    this._classifiedFB = this._framebuffer([this.positionTexture]);
    this._hitFB = this._framebuffer([this._hits]);
    this._visibilityFB = this._framebuffer([this._visibility]);
    this._directFB = this._framebuffer([this._direct]);
    this._cacheFB = this._framebuffer([this._cache]);
    const M = this._texture(
      g.width,
      g.height,
      PixelDatatype.FLOAT,
      undefined,
      this.linearAtlas ? linear : nearest,
    );
    this._distanceFB = this._framebuffer([M]);
    const iw = g.counts[0] * g.counts[1] * 8,
      ih = g.counts[2] * 8;
    this._internalE = this._texture(iw, ih);
    this._internalM = this._texture(iw, ih);
    if (this.options.diagnosticIntegrationLut) {
      this._weights = this._texture(g.rays, 64);
      this._weightsFB = this._framebuffer([this._weights]);
    }
    this._integrateFB = this._framebuffer([this._internalE]);
    this._momentsFB = this._framebuffer([this._internalM]);
    this._geometryIntegrationMode = this.options.integrationMode;
    this.packet.integration = {
      mode: this.options.integrationMode,
      angularResolution: 8,
      borderResolution: 10,
      internalBytes: iw * ih * 16 * 2,
      weightBytes: this._weights ? g.rays * 64 * 16 : 0,
    };
    this._atlases = Array.from({ length: 3 }, () => {
      const E = this._texture(
        g.width,
        g.height,
        PixelDatatype.FLOAT,
        undefined,
        this.linearAtlas ? linear : nearest,
      );
      return { E, M, fb: this._framebuffer([E]) };
    });
    this._published = 2;
    this._previous = 2;
    this._atlasMetadata = Array.from({ length: 3 }, () => ({
      revision: 0,
      bounce: 0,
      complete: false,
    }));
    this.irradianceTexture = this._atlases[2].E;
    this.distanceTexture = this._atlases[2].M;
    this._lighting = this._light(this.options);
    this._phase = "relocate";
    this._cursor = 0;
    this._started = performance.now();
  }
  _light(o) {
    return {
      sunDirection: Cartesian3.normalize(
        Cartesian3.fromArray(o.sunDirection ?? [1, 1, 1]),
        new Cartesian3(),
      ),
      sunRadiance: Cartesian3.fromArray(o.sunRadiance ?? [2, 2, 2]),
      skyRadiance: Cartesian3.fromArray(o.skyRadiance ?? [0.15, 0.18, 0.25]),
      upperHemisphere: o.environmentMode === "upper-hemisphere" ? 1 : 0,
      neutral: new Cartesian2(
        o.neutralMaterials?.[0] ?? -1,
        o.neutralMaterials?.[1] ?? -1,
      ),
    };
  }
  _uniforms() {
    const c = this.scene.context;
    return {
      u_fgCopySource: () => this._fgCopySource ?? c.defaultTexture,
      u_nodes: () => this._nodes,
      u_vertices: () => this._vertices,
      u_uv: () => this._uv,
      u_tieRankOffset: () => this.packet.bvh.tieRankOffset ?? -1,
      u_materials: () => this._materials,
      u_atlas: () => this._atlas,
      u_hits: () => this._hits,
      u_direct: () => this._direct,
      u_cache: () => this._cache,
      u_visibility: () => this._visibility,
      u_weights: () => this._weights,
      u_borderSource: () =>
        this._phase === "momentsBorder" ? this._internalM : this._internalE,
      u_nodesCount: () => this.packet.bvh.nodes,
      u_budget: () =>
        this._diagnosticBudget ??
        this._jobOptions?.traversalBudget ??
        this.options.traversalBudget,
      u_rays: () => this.options.rays,
      u_first: () => (this._bounce === 1 ? 1 : 0),
      u_sunDirection: () => this._lighting.sunDirection,
      u_sunRadiance: () => this._lighting.sunRadiance,
      u_skyRadiance: () => this._lighting.skyRadiance,
      u_upperHemisphere: () => this._lighting.upperHemisphere,
      u_visibilityOptimized: () =>
        (this._jobOptions ?? this.options).visibilityMode === "optimized",
      u_queryAnyHit: () => this._diagnosticAnyHit ?? false,
      u_queryStats: () => this._diagnosticStats ?? false,
      u_transportPart: () => this._transportPart ?? 0,
      u_neutral: () => this._lighting.neutral,
      u_lumenProbeIrradiance: () =>
        this._phase === "query" && this._sampleDisplay
          ? this.displayIrradianceTexture
          : this._atlases[this._previous].E,
      u_displayHistory: () => this._display?.inputHistory ?? c.defaultTexture,
      u_displayTarget: () => this._display?.inputTarget ?? c.defaultTexture,
      u_displayAlpha: () => this._display?.alpha ?? 1,
      u_lumenProbeDistances: () => this._atlases[this._previous].M,
      u_lumenProbePositions: () =>
        ["intersect", "classify"].includes(this._phase)
          ? this._initialPositions
          : this.positionTexture,
      u_lumenEyeToLocal: () => Matrix4.IDENTITY,
      u_lumenProbeOrigin: () => this.origin,
      u_lumenProbeCounts: () => this.counts,
      u_lumenProbeSpacing: () => this.spacing,
      u_lumenNormalBias: () => this.normalBias,
      u_lumenWorldGain: () => 1,
      u_lumenCoverage: () => 1,
      u_lumenWorldEnabled: () => true,
      u_lumenLinearAtlas: () => this.linearAtlas,
      u_lumenLegacyKernel: () =>
        this._phase === "query"
          ? (this._sampleLegacyKernel ??
            this.options.reconstructionMode === "legacy")
          : (this._jobOptions ?? this.options).reconstructionMode === "legacy",
      // Display/query ablations never enter the raw bounce solver.
      u_lumenGatherControl: () =>
        this._phase === "query"
          ? (this._sampleGatherControl ?? defaultGatherControl)
          : defaultGatherControl,
      u_lumenIrradiance: () => Cartesian3.ZERO,
      u_queryOrigin: () => this._queryOrigin ?? c.defaultTexture,
      u_queryDirection: () => this._queryDirection ?? c.defaultTexture,
      u_queryGeometricNormal: () =>
        this._queryGeometricNormal ?? c.defaultTexture,
    };
  }
  _draw(name, framebuffer, x, y, width, height) {
    const c = this.scene.context;
    const mode =
      name === "moments"
        ? this._geometryIntegrationMode
        : this._jobOptions?.integrationMode;
    const variant = ["moments", "integrate"].includes(name);
    const key = variant ? `${name}_${mode}` : name;
    let command = this._commands[key];
    if (!command) {
      command = this._commands[key] = c.createViewportQuadCommand(
        `${variant && mode === "lut" ? "#define LUMEN_USE_LUT\n" : ""}${shaders[name]}`,
        {
          uniformMap:
            name === "queryFinalGather" ||
            name === "queryExactProbeVisibility" ||
            name === "queryTransport"
              ? this._finalGatherQueryUniforms()
              : this._uniforms(),
          renderState: RenderState.fromCache({
            depthTest: { enabled: false },
            depthMask: false,
          }),
          owner: this,
        },
      );
    }
    command.framebuffer = framebuffer;
    // A fresh pass state makes Context apply the changed viewport even for adjacent batches.
    const ps = new PassState(c);
    ps.viewport = new BoundingRectangle(x, y, width, height);
    command.execute(c, ps);
  }
  _invalidateTimers() {
    this.metrics.disjoint++;
    const gl = this.scene.context._gl;
    for (const q of this._queries) {
      if (q.stage) {
        q.stage.timerMissing++;
      }
      this.metrics.timerMissing++;
      gl.deleteQuery(q.query);
    }
    this._queries.length = 0;
  }
  _pollTimers() {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext) {
      return;
    }
    if (LumenGpuTimer.poll(this.scene.context, ext)) {
      return;
    }
    while (
      this._queries.length &&
      gl.getQueryParameter(this._queries[0].query, gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = this._queries.shift(),
        ms = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q.query);
      const stats = (this.metrics.passes[q.phase] ??= {
        batches: 0,
        totalMilliseconds: 0,
        maximumMilliseconds: 0,
        samples: [],
      });
      stats.batches++;
      stats.totalMilliseconds += ms;
      stats.maximumMilliseconds = Math.max(stats.maximumMilliseconds, ms);
      if (q.stage) {
        q.stage.gpuMilliseconds += ms;
        q.stage.timerSamples++;
      }
      if (stats.samples.length < 200) {
        stats.samples.push(ms);
      }
      if (ms >= 0) {
        // Sub-20us batches are still valid observations; otherwise cheap phases never grow.
        const measured = Math.max(ms, 0.005);
        const key = q.scheduleKey ?? q.phase;
        this._costs[key] = Math.max(
          (this._costs[key] ?? 0) * 0.8,
          measured / q.count,
        );
        this._batches[key] = Math.max(
          1,
          Math.min(
            this.options.maxBatch,
            Math.ceil(q.count * 1.5),
            Math.round(
              (q.count * this.options.targetGpuMilliseconds) / measured,
            ),
          ),
        );
      }
    }
  }
  _beginLighting() {
    this._jobRevision = this.revision;
    this._jobOptions = this.options;
    this._jobRequestedAt = this._requestedAt;
    this._pendingLighting = false;
    this._lighting = this._light(this.options);
    const materialKey = JSON.stringify({
      neutral: this.options.neutralMaterials ?? [],
      overrides: this.options.materialOverrides ?? [],
    });
    if (this._materialKey !== undefined && this._materialKey !== materialKey) {
      this.versions.material++;
    }
    this._materialKey = materialKey;
    this._applyMaterials();
    const sunKey = [
      this.versions.geometry,
      this.versions.rayLayout,
      ...[
        this._lighting.sunDirection.x,
        this._lighting.sunDirection.y,
        this._lighting.sunDirection.z,
      ].map((v) => v.toPrecision(14)),
    ].join(":");
    if (sunKey !== this._visibilityKey) {
      this.versions.sunVisibility++;
      this._pendingVisibilityKey = sunKey;
      this._phase = "visibility";
    } else {
      this._phase = "direct";
    }
    this.versions.lighting = this._jobRevision;
    this._jobVersions = Object.freeze({ ...this.versions });
    this._cursor = 0;
    this._bounce = 1;
    this._history = [];
    this._started = performance.now();
    this._jobMetrics = {
      revision: this._jobRevision,
      stages: {},
      submittedFrames: 0,
      submittedBatches: 0,
      cpuSchedulingMilliseconds: 0,
      versions: this._jobVersions,
      work: {
        probeHitInvocations: 0,
        sunVisibilitySubmittedSlots: 0,
        momentProbeUpdates: 0,
      },
    };
    this._previous = this._published;
    this._prepareBounce();
  }
  _prepareBounce() {
    if (this._bounce > 1) {
      const read = this._atlasMetadata[this._previous];
      if (
        !read.complete ||
        read.revision !== this._jobRevision ||
        read.bounce !== this._bounce - 1
      ) {
        throw new Error(
          "DDGI must read the complete previous round of this revision",
        );
      }
    }
    this._target = [0, 1, 2].find(
      (i) => i !== this._published && i !== this._previous,
    );
    this._atlasMetadata[this._target] = {
      revision: this._jobRevision,
      bounce: this._bounce,
      complete: false,
    };
  }
  get displayIrradianceTexture() {
    return this.displayTransitionMilliseconds > 0 && this._display?.ready
      ? this._display.shown.E
      : this.irradianceTexture;
  }
  get displaySettled() {
    return !this._display?.active || this.displayTransitionMilliseconds === 0;
  }
  setDisplayTransition(milliseconds) {
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 250
    ) {
      throw new DeveloperError(
        "display transition must be finite in [0,250] ms",
      );
    }
    if (milliseconds > 0 && this.ready && !this._display) {
      this._ensureDisplay().publish(
        this.irradianceTexture,
        this.packet.versions ?? this.versions,
        this.options,
        this.publishedRevision,
        0,
      );
    }
    this.displayTransitionMilliseconds = milliseconds;
    if (milliseconds === 0 && this._display) {
      for (const resource of this._display.resources) {
        const bytes = resource.E.sizeInBytes;
        resource.fb.destroy();
        resource.E.destroy();
        this.memoryBytes -= bytes;
        this._textures = this._textures.filter((t) => t !== resource.E);
        this._framebuffers = this._framebuffers.filter(
          (f) => f !== resource.fb,
        );
      }
      this._display = undefined;
      this.metrics.memory.currentBytes = this.memoryBytes;
      this.metrics.memory.textures = this._textures.length;
      this.metrics.memory.framebuffers = this._framebuffers.length;
    }
    this.scene.requestRender();
  }
  _ensureDisplay() {
    if (!this._display) {
      const g = this.packet.grid;
      if (
        this.memoryBytes + 3 * g.width * g.height * 16 >
        this.maxMemoryBytes
      ) {
        throw new DeveloperError(
          "display transition exceeds GPU memory budget",
        );
      }
      const resources = Array.from({ length: 3 }, () => {
        const E = this._texture(
          g.width,
          g.height,
          PixelDatatype.FLOAT,
          undefined,
          this.linearAtlas ? linear : nearest,
        );
        return { E, fb: this._framebuffer([E]) };
      });
      this._display = new LumenProbeDisplay(this, resources);
    }
    return this._display;
  }
  _publishRound(final) {
    const metadata = this._atlasMetadata[this._previous];
    if (!metadata.complete || metadata.revision < this.publishedRevision) {
      throw new Error("Cannot publish a partial or older DDGI atlas");
    }
    if (this.displayTransitionMilliseconds > 0) {
      this._ensureDisplay().publish(
        this._atlases[this._previous].E,
        this._jobVersions,
        this._jobOptions,
        this._jobRevision,
        this.displayTransitionMilliseconds,
      );
    }
    this._published = this._previous;
    this.irradianceTexture = this._atlases[this._published].E;
    this.distanceTexture = this._atlases[this._published].M;
    this.ready = true;
    this.packet.revision = this._jobRevision;
    this.packet.bounce = this._bounce;
    this.packet.history = this._history.slice();
    this.packet.versions = this._jobVersions;
    this.packet.integration.mode = this._jobOptions.integrationMode;
    const submissionMilliseconds = performance.now() - this._started;
    this._jobMetrics.firstPublishSubmissionMilliseconds ??=
      submissionMilliseconds;
    this._jobMetrics.requestToFirstSubmissionMilliseconds ??=
      performance.now() - this._jobRequestedAt;
    const publication = Object.freeze({
      revision: this._jobRevision,
      bounce: this._bounce,
      requestedBounces: this._jobOptions.bounces,
      final,
      ...this.atlasState(),
      submissionMilliseconds,
      requestToSubmissionMilliseconds: performance.now() - this._jobRequestedAt,
      timingScope:
        "CPU submission and atlas selection; not GPU completion or presentation",
    });
    if (this._jobRevision === this.revision) {
      this._resolveFirst(publication);
    }
    // Publication notifications run after the entire Scene render stack unwinds.
    // The round transaction (including next-round ownership / final settlement)
    // is committed first. Listeners may destroy the Scene, replace this world,
    // or solve again without resuming a render against released resources.
    queueMicrotask(() => {
      if (this._closed || this.scene.isDestroyed()) {
        return;
      }
      try {
        this.publicationEvent.raiseEvent(publication);
      } catch (error) {
        // Listener failure terminates this world, rather than escaping into the
        // render loop. Already settled promises stay settled; pending work rejects.
        this.publicationError = String(error);
        if (!this._closed) {
          this._fail(error);
        }
      }
    });
  }
  _finishJob(settled) {
    const submissionMilliseconds = performance.now() - this._started;
    const result = {
      ...this._jobMetrics,
      revision: this._jobRevision,
      milliseconds: submissionMilliseconds,
      bounces: this._bounce,
      requestedBounces: this._jobOptions.bounces,
      settled,
      supersededAtRoundBoundary: !settled,
      submissionMilliseconds,
      finalSubmissionMilliseconds: settled ? submissionMilliseconds : null,
      requestToFinalSubmissionMilliseconds: settled
        ? performance.now() - this._jobRequestedAt
        : null,
      publicationMode: this._jobOptions.publicationMode,
      timingScope:
        "CPU submission and atlas selection; not GPU completion or presentation",
    };
    this.metrics.updates.push(result);
    if (this.metrics.updates.length > 100) {
      this.metrics.updates.shift();
    }
    this.status = this._phase = "ready";
    if (settled && this._jobRevision === this.revision) {
      this._resolve(result);
    }
    if (this._pendingLighting) {
      this._beginLighting();
    }
  }
  _completeRound() {
    this._atlasMetadata[this._target].complete = true;
    if (
      this._captureFinalGather &&
      (this._jobOptions.publicationMode === "progressive" ||
        this._bounce === this._jobOptions.bounces)
    ) {
      // Rendering has released its per-frame lease. Drop the previous world
      // owner before copying the replacement, so normal round swaps never
      // temporarily own two full FG snapshots. Explicit leases stay counted.
      this.finalGatherSnapshot?.release();
      this.finalGatherSnapshot = undefined;
      try {
        const next = new LumenFinalGatherSnapshot(
          this,
          this._previous,
          this._target,
        );
        this.finalGatherSnapshot = next;
        this.finalGatherStatus = "ready";
      } catch (e) {
        this.finalGatherStatus = String(e);
        this.finalGatherSnapshot?.release();
        this.finalGatherSnapshot = undefined;
      }
    }
    this._previous = this._target;
    this._target = undefined;
    this._history.push({
      bounce: this._bounce,
      milliseconds: performance.now() - this._started,
    });
    const final = this._bounce === this._jobOptions.bounces;
    const progressive = this._jobOptions.publicationMode === "progressive";
    if (final) {
      this.settledRevision = this._jobRevision;
    }
    if (progressive || final) {
      this._publishRound(final);
    }
    if (final || (progressive && this._pendingLighting)) {
      this._finishJob(final);
    } else {
      this._bounce++;
      this._prepareBounce();
      this._phase = "bounce";
    }
    // Let the forward pass display each progressive round before submitting another.
    return progressive;
  }
  _applyMaterials() {
    const overrides = this.options.materialOverrides ?? [],
      key = JSON.stringify(overrides);
    if (key === this._overrideKey) {
      return;
    }
    const data = this._baseMaterials.slice();
    for (const m of overrides) {
      if (m.id >= this._materials.height) {
        throw new DeveloperError("Unknown material override ID");
      }
      const offset = m.id * 48;
      if (m.baseColorFactor) {
        data.set(m.baseColorFactor, offset);
      }
      if (m.emissiveFactor) {
        data.set(m.emissiveFactor, offset + 8);
      }
      if (m.metallicFactor !== undefined) {
        data[offset + 4] = m.metallicFactor;
      }
    }
    this._materials.copyFrom({
      source: {
        width: this._materials.width,
        height: this._materials.height,
        arrayBufferView: data,
      },
    });
    this._overrideKey = key;
  }
  update() {
    if (this._closed) {
      return;
    }
    Matrix4.multiplyTransformation(
      this.inverseFrame,
      this.scene.camera.inverseViewMatrix,
      this.eyeToLocal,
    );
    const cpuStarted = performance.now();
    const initialBatchCount = this.metrics.submittedBatches;
    const jobsThisFrame = new Set();
    try {
      this._inUpdate = true;
      this._pollTimers();
      if (this.displayTransitionMilliseconds > 0) {
        this._display?.update();
      }
      if (this._prepared) {
        const p = this._prepared;
        this._prepared = undefined;
        this._initialize(p);
      }
      if (!this._phase || this._phase === "ready") {
        if (this._queries.length) {
          this.scene.requestRender();
        }
        return;
      }
      let estimatedTime = 0;
      // Cheap cache/integration batches share one frame; expensive tracing remains bounded.
      // Estimates come from asynchronously completed GPU queries, never a blocking read.
      for (let batch = 0; batch < 8; batch++) {
        if (this._phase === "ready") {
          break;
        }
        const g = this.packet.grid,
          phase = this._phase,
          gl = this.scene.context._gl,
          workTotal = phase === "weights" ? 64 : g.total,
          scheduleKey =
            phase === "integrate"
              ? `${phase}_${this._jobOptions.integrationMode}`
              : phase;
        const count = Math.min(
          this._batches[scheduleKey] ?? 8,
          workTotal - this._cursor,
        );
        const job = [
          "relocate",
          "intersect",
          "classify",
          "weights",
          "moments",
          "momentsBorder",
        ].includes(phase)
          ? undefined
          : this._jobMetrics;
        const stages = job?.stages ?? this.metrics.initialStages;
        const stage = (stages[phase] ??= {
          submittedBatches: 0,
          probes: 0,
          items: 0,
          gpuMilliseconds: 0,
          timerSamples: 0,
          timerMissing: 0,
          cpuSchedulingMilliseconds: 0,
          itemType: phase === "weights" ? "direction rows" : "probes",
        });
        const batchStarted = performance.now();
        const estimate = this._costs[scheduleKey];
        if (
          batch > 0 &&
          (!estimate ||
            estimatedTime + count * estimate >
              this.options.targetGpuMilliseconds)
        ) {
          break;
        }
        estimatedTime += estimate
          ? count * estimate
          : this.options.targetGpuMilliseconds;
        stage.submittedBatches++;
        stage.items += count;
        if (phase !== "weights") {
          stage.probes += count;
        }
        const workKey =
          phase === "intersect"
            ? "probeHitInvocations"
            : phase === "visibility"
              ? "sunVisibilitySubmittedSlots"
              : phase === "moments"
                ? "momentProbeUpdates"
                : undefined;
        if (workKey) {
          const amount = phase === "moments" ? count : count * g.rays;
          this.metrics.work[workKey] += amount;
          if (job) {
            job.work[workKey] += amount;
          }
        }
        this.metrics.submittedBatches++;
        if (job) {
          job.submittedBatches++;
          if (!jobsThisFrame.has(job)) {
            job.submittedFrames++;
            jobsThisFrame.add(job);
          }
        }
        let query;
        if (
          this._timer &&
          this._queries.length < 32 &&
          !gl.getQuery(this._timer.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
        ) {
          query = gl.createQuery();
          gl.beginQuery(this._timer.TIME_ELAPSED_EXT, query);
        }
        try {
          if (
            ["weights", "intersect", "visibility", "direct", "bounce"].includes(
              phase,
            )
          ) {
            const fb =
              phase === "weights"
                ? this._weightsFB
                : phase === "intersect"
                  ? this._hitFB
                  : phase === "visibility"
                    ? this._visibilityFB
                    : phase === "direct"
                      ? this._directFB
                      : this._cacheFB;
            this._draw(phase, fb, 0, this._cursor, g.rays, count);
          } else {
            const stride = g.counts[0] * g.counts[1],
              scale = ["integrate", "moments"].includes(phase)
                ? 8
                : ["border", "momentsBorder"].includes(phase)
                  ? 10
                  : 1;
            const fb =
              phase === "relocate"
                ? this._positionFB
                : phase === "classify"
                  ? this._classifiedFB
                  : phase === "moments"
                    ? this._momentsFB
                    : phase === "momentsBorder"
                      ? this._distanceFB
                      : phase === "integrate"
                        ? this._integrateFB
                        : this._atlases[this._target].fb;
            let cursor = this._cursor,
              remaining = count;
            while (remaining) {
              const n = Math.min(remaining, stride - (cursor % stride));
              this._draw(
                phase,
                fb,
                (cursor % stride) * scale,
                Math.floor(cursor / stride) * scale,
                n * scale,
                scale,
              );
              cursor += n;
              remaining -= n;
            }
          }
        } finally {
          if (query) {
            gl.endQuery(this._timer.TIME_ELAPSED_EXT);
            this._queries.push({ query, phase, count, stage, scheduleKey });
            this.metrics.queryQueuePeak = Math.max(
              this.metrics.queryQueuePeak,
              this._queries.length,
            );
          } else {
            stage.timerMissing++;
            this.metrics.timerMissing++;
          }
          const cpuMilliseconds = performance.now() - batchStarted;
          stage.cpuSchedulingMilliseconds += cpuMilliseconds;
          if (job) {
            job.cpuSchedulingMilliseconds += cpuMilliseconds;
          }
        }
        this._cursor += count;
        this.progress = { completed: this._cursor, total: workTotal };
        this.status = `GPU ${phase} · bounce ${this._bounce ?? 0}`;
        if (this._cursor >= workTotal) {
          this._cursor = 0;
          if (phase === "relocate") {
            this._phase = "intersect";
          } else if (phase === "intersect") {
            this._phase = "classify";
          } else if (phase === "classify") {
            this._phase = this._weights ? "weights" : "moments";
          } else if (phase === "weights") {
            this._phase = "moments";
          } else if (phase === "moments") {
            this._phase = "momentsBorder";
          } else if (phase === "momentsBorder") {
            this._beginLighting();
          } else if (phase === "visibility") {
            this._visibilityKey = this._pendingVisibilityKey;
            this._phase = "direct";
          } else if (phase === "direct") {
            this._phase = "bounce";
          } else if (phase === "bounce") {
            this._phase = "integrate";
          } else if (phase === "integrate") {
            this._phase = "border";
          } else if (phase === "border") {
            if (this._completeRound()) {
              break;
            }
          }
        }
      }
      this.scene.requestRender();
    } catch (e) {
      this._fail(e);
    } finally {
      this.metrics.cpuSchedulingMilliseconds += performance.now() - cpuStarted;
      if (this.metrics.submittedBatches !== initialBatchCount) {
        this.metrics.submittedFrames++;
      }
      this._inUpdate = false;
    }
  }
  solve(options = {}) {
    if (this._closed) {
      throw new Error("GPU world is closed");
    }
    for (const k of [
      "spacing",
      "rays",
      "url",
      "axisMatrix",
      "modelMatrix",
      "traversalBudget",
      "diagnosticIntegrationLut",
      "bvhStrategy",
      "bvhBins",
    ]) {
      if (k in options) {
        throw new Error("Reload world to change GPU geometry or probe layout");
      }
    }
    const next = { ...this.options, ...options };
    this._validate(next);
    this._reject?.(new Error("GPU lighting generation superseded"));
    this._rejectFirst?.(new Error("GPU lighting generation superseded"));
    this._promise();
    this.revision++;
    this._requestedAt = performance.now();
    this.options = immutableOptions(next);
    if (this.packet && this._phase === "ready") {
      this._beginLighting();
    } else if (
      this.packet &&
      ![
        "relocate",
        "intersect",
        "classify",
        "weights",
        "moments",
        "momentsBorder",
      ].includes(this._phase)
    ) {
      this._pendingLighting = true;
    }
    this.scene.requestRender();
    return this.completed;
  }
  _request(type, payload) {
    if (this._closed || !this.packet) {
      return Promise.reject(new Error("GPU geometry is not ready"));
    }
    const id = ++this._requestId;
    return new Promise((resolve, reject) => {
      this._requests.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...payload });
    });
  }
  referenceTrace(rays) {
    return this._request("referenceTrace", { rays });
  }
  surfaces(materials) {
    return this._request("surfaces", { materials });
  }
  // Diagnostics only. Normal rendering never calls readPixels or waits for GPU completion.
  _read(fb, width, height, attachment = 0, datatype = PixelDatatype.FLOAT) {
    if (this._inUpdate) {
      this.metrics.productionReadbacks++;
    } else {
      this.metrics.diagnosticReadbacks++;
    }
    const gl = this.scene.context._gl,
      old = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      oldBuffer = gl.getParameter(gl.READ_BUFFER);
    const data =
      datatype === PixelDatatype.UNSIGNED_BYTE
        ? new Uint8Array(width * height * 4)
        : new Float32Array(width * height * 4);
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb._framebuffer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.readPixels(0, 0, width, height, gl.RGBA, datatype, data);
      const err = gl.getError();
      if (err) {
        throw new Error(`GPU diagnostic readPixels: ${err}`);
      }
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old);
      gl.readBuffer(oldBuffer);
    }
    return data;
  }
  snapshot() {
    if (!this.ready) {
      throw new Error("GPU field is not ready");
    }
    const g = this.packet.grid;
    return {
      grid: g,
      positions: this._read(
        this._classifiedFB,
        g.counts[0] * g.counts[1],
        g.counts[2],
      ),
      irradiance: this._read(
        this._atlases[this._published].fb,
        g.width,
        g.height,
      ),
      moments: this._read(this._distanceFB, g.width, g.height),
    };
  }
  cacheDiagnostics() {
    if (!this.ready) {
      throw new Error("GPU field is not ready");
    }
    const g = this.packet.grid,
      hits = this._read(this._hitFB, g.rays, g.total),
      visibility = this._read(
        this._visibilityFB,
        g.rays,
        g.total,
        0,
        PixelDatatype.UNSIGNED_BYTE,
      );
    let hitSlots = 0,
      probeUnknown = 0,
      effectiveSunQueries = 0,
      sunUnknown = 0;
    for (let i = 0; i < hits.length; i += 4) {
      if (Math.abs(hits[i]) > 1) {
        hitSlots++;
      }
      if (hits[i] === -1) {
        probeUnknown++;
      }
      if (visibility[i + 2] > 127) {
        effectiveSunQueries++;
        if (visibility[i + 1] < 128) {
          sunUnknown++;
        }
      }
    }
    return {
      allocatedSlots: g.rays * g.total,
      hitSlots,
      probeUnknown,
      effectiveSunQueries,
      sunUnknown,
      versions: { ...this.versions },
    };
  }
  _query(name, points) {
    if (!this.ready) {
      throw new Error("GPU field is not ready");
    }
    if (!points.length) {
      return [];
    }
    if (points.length > ContextLimits.maximumTextureSize) {
      throw new Error("Too many diagnostic points");
    }
    const c = this.scene.context,
      a = new Float32Array(points.length * 4),
      b = new Float32Array(points.length * 4);
    points.forEach((p, i) => {
      a.set([...(p.position ?? p.origin), p.maxDistance ?? 100], i * 4);
      b.set([...(p.normal ?? p.direction), p.ignore ?? -1], i * 4);
    });
    const make = (data) =>
      new Texture({
        context: c,
        width: points.length,
        height: 1,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: PixelDatatype.FLOAT,
        flipY: false,
        sampler: nearest,
        source: { width: points.length, height: 1, arrayBufferView: data },
      });
    const geometric = points.some((p) => p.geometricNormal)
      ? new Float32Array(points.length * 4)
      : undefined;
    points.forEach((p, i) =>
      geometric?.set(
        [...(p.geometricNormal ?? p.normal ?? p.direction), 0],
        i * 4,
      ),
    );
    const oldPrevious = this._previous,
      oldPhase = this._phase;
    const inputA = make(a),
      inputB = make(b),
      inputNg = geometric ? make(geometric) : inputB,
      output = make(new Float32Array(a.length));
    const fb = new Framebuffer({
      context: c,
      colorTextures: [output],
      destroyAttachments: false,
    });
    try {
      this._queryOrigin = inputA;
      this._queryDirection = inputB;
      this._queryGeometricNormal = inputNg;
      this._previous = this._published;
      this._phase = "query";
      this._draw(name, fb, 0, 0, points.length, 1);
      const data = this._read(fb, points.length, 1);
      return Array.from({ length: points.length }, (_, i) =>
        Array.from(data.subarray(i * 4, i * 4 + 4)),
      );
    } finally {
      this._queryOrigin =
        this._queryDirection =
        this._queryGeometricNormal =
          undefined;
      this._previous = oldPrevious;
      this._phase = oldPhase;
      fb.destroy();
      inputA.destroy();
      inputB.destroy();
      if (inputNg !== inputB) {
        inputNg.destroy();
      }
      output.destroy();
    }
  }
  _finalGatherQueryUniforms() {
    // A command persists, but each uniform reads the currently leased snapshot.
    const keys = Object.keys(this.finalGatherUniforms(this._fgInput));
    return Object.fromEntries(
      keys.map((key) => [
        key,
        () => this.finalGatherUniforms(this._fgInput)[key](),
      ]),
    );
  }
  diagnoseTransport(rays, { snapshot = this.finalGatherSnapshot } = {}) {
    if (!snapshot) throw Error("FG snapshot required for transport diagnostic");
    snapshot.assertAlive();
    this._fgInput = snapshot.retain();
    try {
      const names = [
        "hit",
        "sky",
        "emission",
        "sun",
        "ddgi",
        "position",
        "normal",
        "solarOrigin",
        "solarHit",
      ];
      return Object.fromEntries(
        names.map((name, part) => {
          this._transportPart = part;
          const values = this._query("queryTransport", rays);
          if (name === "hit" || name === "solarHit")
            for (const h of values) {
              if (Math.abs(h[0]) > 1)
                h[0] = Math.sign(h[0]) * (this._order[Math.abs(h[0]) - 2] + 2);
            }
          return [name, values];
        }),
      );
    } finally {
      this._transportPart = undefined;
      this._fgInput.release();
      this._fgInput = undefined;
    }
  }
  sampleFinalGather(
    points,
    {
      snapshot = this.finalGatherSnapshot,
      samples = 256,
      seed = 0,
      sampling = "fixed-reference",
      epoch = 0,
      pixel = [0, 0],
      budget,
    } = {},
  ) {
    if (!snapshot) {
      throw Error("enable FG capture and solve before querying Final Gather");
    }
    snapshot.assertAlive();
    if (!Number.isInteger(samples) || samples < 1 || samples > 1024) {
      throw Error("FG samples in [1,1024] required");
    }
    if (
      budget !== undefined &&
      (!Number.isInteger(budget) || budget < 1 || budget > 4096)
    ) {
      throw Error("FG budget in [1,4096] required");
    }
    if (
      !["fixed-reference", "scrambled-single-frame", "reconstructed"].includes(
        sampling,
      ) ||
      !Number.isInteger(seed) ||
      seed < -2147483648 ||
      seed > 2147483647 ||
      !Array.isArray(pixel) ||
      pixel.length !== 2 ||
      pixel.some(
        (value) =>
          !Number.isInteger(value) || value < -2147483648 || value > 2147483647,
      ) ||
      !Number.isInteger(epoch) ||
      epoch < 0 ||
      epoch > 4294967295
    ) {
      throw Error("Invalid FG query sequence");
    }
    this._fgInput = snapshot.retain();
    this._fgSamples = samples;
    this._fgSeed = seed;
    this._fgSampling =
      sampling === "fixed-reference" ? 0 : sampling === "reconstructed" ? 2 : 1;
    this._fgEpoch = epoch | 0;
    this._fgPixelOffset = Cartesian2.fromArray(pixel);
    this._fgBudget = budget;
    this._fgExact = false;
    try {
      const rows = this._query("queryFinalGather", points);
      return Promise.resolve(
        rows.map((v) => ({
          irradiance: v.slice(0, 3),
          valid: v[3] > 0.5,
          unknown: v[3] < 0,
          revision: snapshot.revision,
          round: snapshot.round,
          samples,
        })),
      );
    } finally {
      this._fgInput.release();
      this._fgInput = undefined;
      this._fgBudget = undefined;
    }
  }
  sampleExactProbeVisibility(
    points,
    { snapshot = this.finalGatherSnapshot, budget } = {},
  ) {
    if (!snapshot) {
      throw Error("FG capture required for frozen exact-probe comparison");
    }
    if (
      budget !== undefined &&
      (!Number.isInteger(budget) || budget < 1 || budget > 4096)
    ) {
      throw Error("FG budget in [1,4096] required");
    }
    this._fgInput = snapshot.retain();
    this._fgBudget = budget;
    this._fgExact = true;
    try {
      const rows = this._query("queryExactProbeVisibility", points);
      return Promise.resolve(
        rows.map((v) => ({
          irradiance: v.slice(0, 3),
          coverage: Math.max(0, v[3]),
          valid: v[3] >= 0,
          unknown: v[3] < 0,
          revision: snapshot.revision,
          round: snapshot.round,
        })),
      );
    } finally {
      this._fgInput.release();
      this._fgInput = undefined;
      this._fgBudget = undefined;
      this._fgExact = false;
    }
  }
  sample(points, diagnostic = {}) {
    const old = this._sampleGatherControl,
      oldDisplay = this._sampleDisplay,
      oldLegacy = this._sampleLegacyKernel;
    try {
      this._sampleLegacyKernel = diagnostic.legacyKernel;
      this._sampleDisplay = diagnostic.display === true;
      this._sampleGatherControl = new Cartesian4(
        diagnostic.visibility === false ? 1 : 0,
        diagnostic.crush === false ? 1 : 0,
        diagnostic.fixedIrradiance ?? -1,
        diagnostic.fixedFacing ?? -1,
      );
      return Promise.resolve(
        this._query("querySample", points).map((v) => ({
          irradiance: v.slice(0, 3),
          coverage: v[3],
        })),
      );
    } finally {
      this._sampleGatherControl = old;
      this._sampleDisplay = oldDisplay;
      this._sampleLegacyKernel = oldLegacy;
    }
  }
  trace(rays, { anyHit = false, statistics = false } = {}) {
    const groups = new Map(),
      result = new Array(rays.length);
    rays.forEach((r, i) => {
      const budget = r.budget ?? this.options.traversalBudget;
      if (!Number.isInteger(budget) || budget < 1 || budget > 4096) {
        throw new Error("GPU diagnostic traversal budget in [1,4096] required");
      }
      const group = groups.get(budget) ?? [];
      group.push({
        r: { ...r, ignore: r.ignore >= 0 ? this._order.indexOf(r.ignore) : -1 },
        i,
      });
      groups.set(budget, group);
    });
    const previousBudget = this._diagnosticBudget;
    const previousAnyHit = this._diagnosticAnyHit;
    const previousStats = this._diagnosticStats;
    try {
      this._diagnosticAnyHit = anyHit;
      this._diagnosticStats = statistics;
      for (const [budget, group] of groups) {
        this._diagnosticBudget = budget;
        this._query(
          "queryTrace",
          group.map((e) => e.r),
        ).forEach((v, j) => {
          result[group[j].i] = statistics
            ? {
                nodeVisits: v[0],
                triangleTests: v[1],
                alphaTests: v[2],
                status: v[3] === -1 ? "Unknown" : v[3] === 0 ? "Miss" : "Hit",
              }
            : {
                status: v[0] === -1 ? "Unknown" : v[0] === 0 ? "Miss" : "Hit",
                triangle: this._order[Math.abs(v[0]) - 2],
                gpuTriangle: Math.abs(v[0]) - 2,
                u: v[1],
                v: v[2],
                distance: v[3],
                backface: v[0] < -1,
              };
        });
      }
    } finally {
      this._diagnosticBudget = previousBudget;
      this._diagnosticAnyHit = previousAnyHit;
      this._diagnosticStats = previousStats;
    }
    return Promise.resolve(result);
  }
  _fail(error) {
    // A queued Worker error must not resurrect a destroyed world or touch a
    // context that its owning Scene has already released.
    if (this._closed) {
      return;
    }
    this.error = String(error);
    this.status = "error";
    this._reject?.(error);
    this._rejectFirst?.(error);
    this._release();
    this.scene.requestRender();
  }
  _release() {
    this._unregisterTimer?.();
    for (const snapshot of [...this._fgSnapshots]) {
      snapshot.destroy();
    }
    this.finalGatherSnapshot = undefined;
    this._closed = true;
    this.ready = false;
    this.worker?.terminate();
    this._order = this._baseMaterials = this._prepared = undefined;
    for (const r of this._requests.values()) {
      r.reject(new Error("GPU world closed"));
    }
    this._requests.clear();
    this._pendingLighting = false;
    this._target = this._previous = undefined;
    const gl = this.scene.context._gl;
    for (const q of this._queries) {
      gl.deleteQuery(q.query);
    }
    this._queries.length = 0;
    for (const command of Object.values(this._commands)) {
      command.shaderProgram.destroy();
    }
    this._commands = {};
    for (const f of this._framebuffers) {
      f.destroy();
    }
    this._framebuffers = [];
    for (const t of this._textures) {
      t.destroy();
    }
    this._textures = [];
    this._display = undefined;
    this.memoryBytes = 0;
    this.metrics.memory.currentBytes = 0;
    this.metrics.memory.textures = this.metrics.memory.framebuffers = 0;
    this.irradianceTexture =
      this.distanceTexture =
      this.positionTexture =
        undefined;
  }
  isDestroyed() {
    return this._closed === true;
  }
  destroy() {
    if (this._closed) {
      return;
    }
    this._reject?.(new Error("GPU world destroyed"));
    this._rejectFirst?.(new Error("GPU world destroyed"));
    this._release();
    this.status = "destroyed";
  }
}
export default LumenGpuWorld;
