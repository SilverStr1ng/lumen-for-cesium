import {
  Cartesian2,
  Cartesian3,
  Matrix4,
  BoundingRectangle,
  PixelDatatype,
  PixelFormat,
  Color,
  DeveloperError,
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

const nearest = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
});
const linear = new Sampler({
  minificationFilter: TextureMinificationFilter.LINEAR,
  magnificationFilter: TextureMagnificationFilter.LINEAR,
});

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
      ...options,
    };
    this._validate(this.options);
    this.inverseFrame = Matrix4.inverse(options.modelMatrix, new Matrix4());
    this.eyeToLocal = new Matrix4();
    this.origin = new Cartesian3();
    this.counts = new Cartesian3();
    this.spacing = this.options.spacing;
    this.gain = 1;
    this.ready = false;
    this.status = "loading GPU geometry";
    this.revision = 1;
    this.memoryBytes = 0;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 192 * 1048576;
    this.linearAtlas = scene.context.textureFloatLinear;
    this._textures = [];
    this._framebuffers = [];
    this._commands = {};
    this._requests = new Map();
    this._requestId = 0;
    this._queries = [];
    this._batches = {};
    this._costs = {};
    this.metrics = {
      passes: {},
      disjoint: 0,
      updates: [],
      productionReadbacks: 0,
      diagnosticReadbacks: 0,
    };
    this._timer = scene.context._gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    );
    this._promise();
    this.worker = new Worker(options.workerUrl, { type: "module" });
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
    this.worker.postMessage({
      type: "load",
      url: options.url,
      axisMatrix: options.axisMatrix,
      options: {
        ...this.options,
        maxTextureSize: ContextLimits.maximumTextureSize,
      },
    });
  }
  _validate(o) {
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
  }
  _promise() {
    this.completed = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // A caller may use solve() without observing the initial load promise.
    this.completed.catch(() => {});
  }
  _texture(
    width,
    height,
    datatype = PixelDatatype.FLOAT,
    data,
    filter = nearest,
  ) {
    if (
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
    return t;
  }
  _framebuffer(textures) {
    const c = this.scene.context,
      gl = c._gl;
    const f = new Framebuffer({
      context: c,
      colorTextures: textures,
      destroyAttachments: false,
    });
    this._framebuffers.push(f);
    const binding = c._currentFramebuffer;
    const status = f.status;
    if (binding) {
      binding._bind();
      gl.drawBuffers(binding._getActiveColorAttachments());
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawBuffers([gl.BACK]);
    }
    c._currentFramebuffer = binding;
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`GPU framebuffer incomplete: ${status}`);
    }
    new ClearCommand({ framebuffer: f, color: Color.TRANSPARENT }).execute(c);
    return f;
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
    this._direct = this._texture(g.rays, g.total, PixelDatatype.HALF_FLOAT);
    this._cache = this._texture(g.rays, g.total, PixelDatatype.HALF_FLOAT);
    this._positionFB = this._framebuffer([this._initialPositions]);
    this._classifiedFB = this._framebuffer([this.positionTexture]);
    this._hitFB = this._framebuffer([this._hits]);
    this._directFB = this._framebuffer([this._direct]);
    this._cacheFB = this._framebuffer([this._cache]);
    this._atlases = Array.from({ length: 3 }, () => {
      const E = this._texture(
        g.width,
        g.height,
        PixelDatatype.FLOAT,
        undefined,
        this.linearAtlas ? linear : nearest,
      );
      const M = this._texture(
        g.width,
        g.height,
        PixelDatatype.FLOAT,
        undefined,
        this.linearAtlas ? linear : nearest,
      );
      return { E, M, fb: this._framebuffer([E, M]) };
    });
    this._published = 2;
    this._previous = 2;
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
      neutral: new Cartesian2(
        o.neutralMaterials?.[0] ?? -1,
        o.neutralMaterials?.[1] ?? -1,
      ),
    };
  }
  _uniforms() {
    const c = this.scene.context;
    return {
      u_nodes: () => this._nodes,
      u_vertices: () => this._vertices,
      u_uv: () => this._uv,
      u_materials: () => this._materials,
      u_atlas: () => this._atlas,
      u_hits: () => this._hits,
      u_direct: () => this._direct,
      u_cache: () => this._cache,
      u_nodesCount: () => this.packet.bvh.nodes,
      u_budget: () => this.options.traversalBudget,
      u_rays: () => this.options.rays,
      u_first: () => (this._bounce === 1 ? 1 : 0),
      u_sunDirection: () => this._lighting.sunDirection,
      u_sunRadiance: () => this._lighting.sunRadiance,
      u_skyRadiance: () => this._lighting.skyRadiance,
      u_neutral: () => this._lighting.neutral,
      u_lumenProbeIrradiance: () => this._atlases[this._previous].E,
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
      u_lumenIrradiance: () => Cartesian3.ZERO,
      u_queryOrigin: () => this._queryOrigin ?? c.defaultTexture,
      u_queryDirection: () => this._queryDirection ?? c.defaultTexture,
    };
  }
  _draw(name, framebuffer, x, y, width, height) {
    const c = this.scene.context;
    let command = this._commands[name];
    if (!command) {
      command = this._commands[name] = c.createViewportQuadCommand(
        shaders[name],
        {
          uniformMap: this._uniforms(),
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
  _pollTimers() {
    const gl = this.scene.context._gl,
      ext = this._timer;
    if (!ext) {
      return;
    }
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      this.metrics.disjoint++;
      for (const q of this._queries) {
        gl.deleteQuery(q.query);
      }
      this._queries.length = 0;
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
      if (stats.samples.length < 200) {
        stats.samples.push(ms);
      }
      if (ms > 0.02) {
        this._costs[q.phase] = Math.max(
          (this._costs[q.phase] ?? 0) * 0.8,
          ms / q.count,
        );
        this._batches[q.phase] = Math.max(
          1,
          Math.min(
            this.options.maxBatch,
            Math.ceil(q.count * 1.5),
            Math.round((q.count * this.options.targetGpuMilliseconds) / ms),
          ),
        );
      }
    }
  }
  _beginLighting() {
    this._jobRevision = this.revision;
    this._jobOptions = this.options;
    this._pendingLighting = false;
    this._lighting = this._light(this.options);
    this._phase = "direct";
    this._cursor = 0;
    this._bounce = 1;
    this._history = [];
    this._started = performance.now();
    this._target = this._published === 0 ? 1 : 0;
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
    try {
      this._inUpdate = true;
      this._pollTimers();
      if (this._prepared) {
        const p = this._prepared;
        this._prepared = undefined;
        this._initialize(p);
      }
      if (!this._phase || this._phase === "ready") {
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
          gl = this.scene.context._gl;
        const count = Math.min(
          this._batches[phase] ?? 8,
          g.total - this._cursor,
        );
        const estimate = this._costs[phase];
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
          if (["intersect", "direct", "bounce"].includes(phase)) {
            const fb =
              phase === "intersect"
                ? this._hitFB
                : phase === "direct"
                  ? this._directFB
                  : this._cacheFB;
            this._draw(phase, fb, 0, this._cursor, g.rays, count);
          } else {
            const stride = g.counts[0] * g.counts[1],
              scale = phase === "integrate" ? 10 : 1;
            const fb =
              phase === "relocate"
                ? this._positionFB
                : phase === "classify"
                  ? this._classifiedFB
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
            this._queries.push({ query, phase, count });
          }
        }
        this._cursor += count;
        this.progress = { completed: this._cursor, total: g.total };
        this.status = `GPU ${phase} · bounce ${this._bounce ?? 0}`;
        if (this._cursor >= g.total) {
          this._cursor = 0;
          if (phase === "relocate") {
            this._phase = "intersect";
          } else if (phase === "intersect") {
            this._phase = "classify";
          } else if (phase === "classify") {
            this._beginLighting();
          } else if (phase === "direct") {
            this._phase = "bounce";
          } else if (phase === "bounce") {
            this._phase = "integrate";
          } else if (phase === "integrate") {
            this._previous = this._target;
            this._history.push({
              bounce: this._bounce,
              milliseconds: performance.now() - this._started,
            });
            if (this._bounce < this._jobOptions.bounces) {
              this._bounce++;
              this._target = [0, 1, 2].find(
                (i) => i !== this._previous && i !== this._published,
              );
              this._phase = "bounce";
            } else {
              this._published = this._previous;
              this.irradianceTexture = this._atlases[this._published].E;
              this.distanceTexture = this._atlases[this._published].M;
              this.ready = true;
              this.packet.revision = this._jobRevision;
              this.packet.bounce = this._bounce;
              this.packet.history = this._history;
              this.status = this._phase = "ready";
              const result = {
                revision: this._jobRevision,
                milliseconds: performance.now() - this._started,
                bounces: this._bounce,
              };
              this.metrics.updates.push(result);
              if (this.metrics.updates.length > 100) {
                this.metrics.updates.shift();
              }
              if (this._jobRevision === this.revision) {
                this._resolve(result);
              }
              if (this._pendingLighting) {
                this._beginLighting();
              }
            }
          }
        }
      }
      this.scene.requestRender();
    } catch (e) {
      this._fail(e);
    } finally {
      this._inUpdate = false;
    }
  }
  solve(options = {}) {
    if (this._closed) {
      throw new Error("GPU world is closed");
    }
    for (const k of ["spacing", "rays", "url", "axisMatrix", "modelMatrix"]) {
      if (k in options) {
        throw new Error("Reload world to change GPU geometry or probe layout");
      }
    }
    const next = { ...this.options, ...options };
    this._validate(next);
    this._reject?.(new Error("GPU lighting generation superseded"));
    this._promise();
    this.revision++;
    this.options = next;
    if (this.packet && this._phase === "ready") {
      this._beginLighting();
    } else if (
      this.packet &&
      !["relocate", "intersect", "classify"].includes(this._phase)
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
  _read(fb, width, height, attachment = 0) {
    if (this._inUpdate) {
      this.metrics.productionReadbacks++;
    } else {
      this.metrics.diagnosticReadbacks++;
    }
    const gl = this.scene.context._gl,
      old = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      oldBuffer = gl.getParameter(gl.READ_BUFFER);
    const data = new Float32Array(width * height * 4);
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb._framebuffer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
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
      moments: this._read(
        this._atlases[this._published].fb,
        g.width,
        g.height,
        1,
      ),
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
    const oldPrevious = this._previous,
      oldPhase = this._phase;
    const inputA = make(a),
      inputB = make(b),
      output = make(new Float32Array(a.length));
    const fb = new Framebuffer({
      context: c,
      colorTextures: [output],
      destroyAttachments: false,
    });
    try {
      this._queryOrigin = inputA;
      this._queryDirection = inputB;
      this._previous = this._published;
      this._phase = "query";
      this._draw(name, fb, 0, 0, points.length, 1);
      const data = this._read(fb, points.length, 1);
      return Array.from({ length: points.length }, (_, i) =>
        Array.from(data.subarray(i * 4, i * 4 + 4)),
      );
    } finally {
      this._queryOrigin = this._queryDirection = undefined;
      this._previous = oldPrevious;
      this._phase = oldPhase;
      fb.destroy();
      inputA.destroy();
      inputB.destroy();
      output.destroy();
    }
  }
  sample(points) {
    return Promise.resolve(
      this._query("querySample", points).map((v) => ({
        irradiance: v.slice(0, 3),
        coverage: v[3],
      })),
    );
  }
  trace(rays) {
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
    const previousBudget = this.options.traversalBudget;
    try {
      for (const [budget, group] of groups) {
        this.options.traversalBudget = budget;
        this._query(
          "queryTrace",
          group.map((e) => e.r),
        ).forEach((v, j) => {
          result[group[j].i] = {
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
      this.options.traversalBudget = previousBudget;
    }
    return Promise.resolve(result);
  }
  _fail(error) {
    this.error = String(error);
    this.status = "error";
    this._reject?.(error);
    this._release();
    this.scene.requestRender();
  }
  _release() {
    this._closed = true;
    this.ready = false;
    this.worker?.terminate();
    for (const r of this._requests.values()) {
      r.reject(new Error("GPU world closed"));
    }
    this._requests.clear();
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
    this.memoryBytes = 0;
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
    this._release();
    this.status = "destroyed";
  }
}
export default LumenGpuWorld;
