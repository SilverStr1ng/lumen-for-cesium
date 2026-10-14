import { PixelDatatype, BoundingRectangle } from "@cesium/core";
import RenderState from "../Renderer/RenderState.js";
import PassState from "../Renderer/PassState.js";
import { buildSurfaceRadiance } from "./LumenGpuShaders.js";
import LumenGpuTimer from "./LumenGpuTimer.js";

// Optional static source. A complete Sj generation is submitted before the next
// generation reads it. WebGL command ordering establishes readiness without a
// CPU readback/fence. The immutable input snapshot owns geometry/source identity.
class LumenSurfaceRadianceCache {
  constructor(world, snapshot) {
    this.world = world;
    this.snapshot = snapshot.retain();
    this.resources = [];
    this.metrics = {
      status: "layout",
      gpuBytes: 0,
      cpuBytes: 0,
      peakBytes: 0,
      submittedMilliseconds: 0,
      round: 0,
      experimental: true,
    };
    this.enabled = false;
    this.queries = [];
    this.timer = world.scene.context._gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    );
    this.metrics.gpuMillisecondsByRound = {};
    this.metrics.missingQueries = 0;
    this.metrics.disjoint = 0;
    this.unregister = LumenGpuTimer.register(world.scene.context, () => {
      this.metrics.disjoint++;
      this.discardQueries();
    });
    this.removePoll = world.scene.postRender.addEventListener(() =>
      this.pollQueries(),
    );
    this.ready = false;
    world._surfaceCaches.add(this);
  }
  get additionalBytes() {
    return (
      this.metrics.gpuBytes + this.metrics.cpuBytes + this.queries.length * 128
    );
  }
  discardQueries() {
    const gl = this.world.scene.context._gl;
    for (const q of this.queries) {
      gl.deleteQuery(q.query);
    }
    this.metrics.missingQueries += this.queries.length;
    this.queries.length = 0;
  }
  pollQueries() {
    if (!this.timer || this.destroyed) {
      return;
    }
    const context = this.world.scene.context,
      gl = context._gl;
    if (LumenGpuTimer.poll(context, this.timer)) {
      return;
    }
    this.queries = this.queries.filter((q) => {
      if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) {
        return true;
      }
      const value = gl.getQueryParameter(q.query, gl.QUERY_RESULT) / 1e6;
      this.metrics.gpuMillisecondsByRound[q.round] =
        (this.metrics.gpuMillisecondsByRound[q.round] ?? 0) + value;
      gl.deleteQuery(q.query);
      return false;
    });
    this.metrics.pendingQueries = this.queries.length;
  }
  matches(snapshot) {
    return this.ready && !this.destroyed && snapshot === this.snapshot;
  }
  async build({ spacing = 0.08, samples = 256 } = {}) {
    if (!Number.isInteger(samples) || samples < 32 || samples > 1024) {
      throw Error("Surface samples must be in [32,1024]");
    }
    const w = this.world,
      s = this.snapshot,
      start = performance.now(),
      layout = await w._request("surfaceRadianceLayout", {
        options: { spacing, maxSamples: 262144 },
      });
    s.assertAlive();
    if (this.destroyed) {
      throw Error("Superseded surface cache");
    }
    this.metrics.cpuBytes = layout.workerPeakBytes;
    const fg = w.scene.lumen.finalGather;
    if (layout.peakBytes + 8192 > 12 * 1048576) {
      throw Error("Surface cache exceeds 12MiB candidate limit");
    }
    // Account the temporary transferred buffers and both generation images.
    if (
      (fg.additionalSceneBytes ?? 0) +
        (fg.metrics.snapshotBytes ?? 0) +
        layout.gpuBytes +
        8192 >
      fg.maxMemoryBytes
    ) {
      throw Error("Surface cache exceeds total 64MiB additional budget");
    }
    this.metrics.status = "building";
    this.metrics.count = layout.count;
    this.metrics.spacing = spacing;
    this.metrics.samples = samples;
    this.metrics.unsupported = layout.unsupported;
    const allocate = (p, type, data) => {
      const texture = w._texture(p.width, p.height, type, data),
        resource = { texture, fb: undefined };
      this.resources.push(resource);
      this.metrics.gpuBytes += texture.sizeInBytes;
      this.metrics.peakBytes = Math.max(
        this.metrics.peakBytes,
        this.additionalBytes,
      );
      const total =
        (fg.additionalSceneBytes ?? 0) +
        (fg.metrics.snapshotBytes ?? 0) +
        (fg.metrics.memoryBytes ?? 0);
      fg.metrics.peakAdditionalBytes = Math.max(
        fg.metrics.peakAdditionalBytes ?? 0,
        total,
      );
      return resource;
    };
    this.descriptors = allocate(
      layout.samples,
      PixelDatatype.FLOAT,
      layout.samples.data,
    ).texture;
    this.metadata = allocate(
      layout.metadata,
      PixelDatatype.FLOAT,
      layout.metadata.data,
    ).texture;
    this.images = [0, 1].map(() => {
      const r = allocate(layout.samples, PixelDatatype.HALF_FLOAT);
      r.fb = w._framebuffer([r.texture]);
      return r;
    });
    // No transferred clone is retained after upload; geometry stays in its worker.
    layout.samples.data = layout.metadata.data = undefined;
    this.metrics.cpuBytes = 0;
    const context = w.scene.context,
      rounds = s.round;
    this.command = context.createViewportQuadCommand(buildSurfaceRadiance, {
      uniformMap: {
        ...w.finalGatherUniforms(s),
        u_surfaceMetadata: () => this.metadata,
        u_surfaceRadiance: () => this.input,
        u_surfaceSamples: () => this.descriptors,
        u_surfaceRound: () => this.round,
        u_surfaceEnabled: () => false,
        u_fgSamples: () => samples,
        u_fgSampling: () => 2,
        u_fgSeed: () => 0,
        u_fgEpoch: () => this.round,
        u_contactTransport: () => true,
      },
      renderState: RenderState.fromCache({
        depthTest: { enabled: false },
        depthMask: false,
      }),
    });
    for (this.round = 0; this.round < rounds; this.round++) {
      const output = this.images[this.round % 2];
      this.input = this.images[(this.round + 1) % 2].texture;
      for (let y = 0; y < layout.samples.height; y += 2) {
        if (this.destroyed || w.finalGatherSnapshot !== s) {
          throw Error("Superseded surface source");
        }
        const pass = new PassState(context);
        pass.viewport = new BoundingRectangle(
          0,
          y,
          layout.samples.width,
          Math.min(2, layout.samples.height - y),
        );
        this.command.framebuffer = output.fb;
        this.pollQueries();
        const gl = context._gl,
          ext = this.timer,
          canTime =
            ext &&
            this.queries.length < 64 &&
            !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY),
          query = canTime ? gl.createQuery() : undefined;
        if (query) {
          gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        } else {
          this.metrics.missingQueries++;
        }
        try {
          this.command.execute(context, pass);
        } finally {
          if (query) {
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            this.queries.push({ query, round: this.round });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.metrics.round = this.round;
      this.texture = output.texture;
    }
    this.ready = true;
    this.enabled = true;
    this.metrics.status = "ready";
    this.metrics.submittedMilliseconds = performance.now() - start;
    this.pollQueries();
    this.metrics.identity = {
      revision: s.revision,
      round: s.round,
      versions: s.versions,
    };
    w.scene.requestRender();
    return this;
  }
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.ready = false;
    this.enabled = false;
    this.command?.shaderProgram.destroy();
    this.removePoll?.();
    this.unregister?.();
    this.discardQueries();
    for (const r of this.resources) {
      this.world._freeTexture(r.texture, r.fb);
    }
    this.resources.length = 0;
    this.metrics.cpuBytes = this.metrics.gpuBytes = 0;
    this.world._surfaceCaches.delete(this);
    this.snapshot.release();
    this.metrics.status = "disposed";
  }
}
export default LumenSurfaceRadianceCache;
