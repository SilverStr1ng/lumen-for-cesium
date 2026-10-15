import {
  Cartesian3,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  DeveloperError,
} from "@cesium/core";
import Texture from "../Renderer/Texture.js";
import Sampler from "../Renderer/Sampler.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import ContextLimits from "../Renderer/ContextLimits.js";

/** Static world adapter. Worker results are published as complete generations. @private */
class LumenWorld {
  constructor(scene, options) {
    if (!scene.context.webgl2) {
      throw new DeveloperError("World DDGI requires WebGL2");
    }
    this.scene = scene;
    this.status = "loading";
    this.ready = false;
    this.revision = 1;
    this.options = {
      spacing: 2,
      rays: 128,
      bounces: 3,
      traversalBudget: 100000,
      sunDirection: [1, 1, 1],
      sunRadiance: [2, 2, 2],
      skyRadiance: [0.025, 0.035, 0.05],
      ...options,
    };
    this.options.maxTextureSize = ContextLimits.maximumTextureSize;
    if (!Number.isFinite(this.options.spacing) || this.options.spacing <= 0) {
      throw new DeveloperError("spacing must be finite and positive");
    }
    if (
      !Number.isInteger(this.options.bounces) ||
      this.options.bounces < 1 ||
      this.options.bounces > 8
    ) {
      throw new DeveloperError("bounces must be an integer in [1,8]");
    }
    this.inverseFrame = Matrix4.inverse(options.modelMatrix, new Matrix4());
    this.eyeToLocal = new Matrix4();
    this.origin = new Cartesian3();
    this.counts = new Cartesian3();
    this.spacing = this.options.spacing;
    this.memoryBytes = 0;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 128 * 1024 * 1024;
    this.gain = 1;
    this._requests = new Map();
    this._id = 0;
    this.worker = new Worker(options.workerUrl, { type: "module" });
    this.worker.onmessage = ({ data }) => this._message(data);
    this.worker.onerror = (e) => this._fail(new Error(e.message));
    this.completed = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    try { this.worker.postMessage({
      type: "load",
      url: options.url,
      axisMatrix: options.axisMatrix,
      options: this.options,
      revision: this.revision,
    }); } catch (error) {
      this.worker.terminate();
      this._closed = true;
      throw error;
    }
  }
  _fail(error) {
    this.worker.terminate();
    this._closed = true;
    this._pending = undefined;
    this.revision++;
    this._releaseTextures();
    this.status = "error";
    this.error = String(error);
    this.ready = false;
    this._reject?.(error);
    for (const request of this._requests.values()) {
      request.reject(error);
    }
    this._requests.clear();
    this.scene.requestRender();
  }
  _message(data) {
    if (data.revision !== this.revision) {
      return;
    }
    if (data.type === "response") {
      const request = this._requests.get(data.id);
      request?.resolve(data.result);
      this._requests.delete(data.id);
      return;
    }
    if (data.type === "progress") {
      this.status = data.phase;
      this.progress = data;
    }
    if (data.type === "generation") {
      this._pending = data;
      this.status = `bounce ${data.bounce}`;
    }
    if (data.type === "complete") {
      this.status = "ready";
      this._resolve(data.history);
    }
    if (data.type === "error") {
      this._fail(new Error(data.message));
    }
    this.scene.requestRender();
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
    const packet = this._pending;
    if (!packet) {
      return;
    }
    this._pending = undefined;
    const { grid } = packet,
      width = grid.width,
      height = grid.height,
      positionWidth = grid.counts[0] * grid.counts[1],
      positionHeight = grid.counts[2];
    const bytes =
      packet.irradiance.byteLength +
      packet.moments.byteLength +
      packet.positions.byteLength;
    if (
      width > ContextLimits.maximumTextureSize ||
      height > ContextLimits.maximumTextureSize ||
      bytes * 2 > this.maxMemoryBytes
    ) {
      this._fail(new Error("DDGI atlas exceeds texture or memory budget"));
      return;
    }
    const sampler = new Sampler({
      minificationFilter: TextureMinificationFilter.NEAREST,
      magnificationFilter: TextureMagnificationFilter.NEAREST,
    });
    const make = (arrayBufferView, w, h) =>
      new Texture({
        context: this.scene.context,
        width: w,
        height: h,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: PixelDatatype.FLOAT,
        flipY: false,
        sampler,
        source: { width: w, height: h, arrayBufferView },
      });
    const textures = [];
    try {
      textures.push(make(packet.irradiance, width, height));
      textures.push(make(packet.moments, width, height));
      textures.push(make(packet.positions, positionWidth, positionHeight));
    } catch (error) {
      for (const t of textures) {
        t.destroy();
      }
      this._fail(error);
      return;
    }
    this._releaseTextures();
    [this.irradianceTexture, this.distanceTexture, this.positionTexture] =
      textures;
    this.origin = Cartesian3.fromArray(grid.origin, 0, this.origin);
    this.counts = Cartesian3.fromArray(grid.counts, 0, this.counts);
    this.spacing = grid.spacing;
    this.normalBias = grid.normalBias;
    this.memoryBytes = bytes;
    this.packet = packet;
    this.ready = true;
  }
  solve(changes = {}) {
    if (this._closed) {
      throw new DeveloperError(
        "World worker has been closed; use loadWorld to restart",
      );
    }
    if (!this.packet && !this._pending) {
      throw new DeveloperError("Wait for world.completed before relighting");
    }
    if (
      changes.bounces !== undefined &&
      (!Number.isInteger(changes.bounces) ||
        changes.bounces < 1 ||
        changes.bounces > 8)
    ) {
      throw new DeveloperError("bounces must be an integer in [1,8]");
    }
    if (
      ["spacing", "rays", "url", "axisMatrix", "modelMatrix"].some(
        (key) => key in changes,
      )
    ) {
      throw new DeveloperError(
        "Geometry and probe layout changes require loadWorld",
      );
    }
    this._reject?.(new Error("DDGI solve superseded"));
    for (const request of this._requests.values()) {
      request.reject(new Error("DDGI revision changed"));
    }
    this._requests.clear();
    this.revision++;
    this.options = { ...this.options, ...changes };
    this._pending = undefined;
    this.ready = false;
    this.status = "relighting";
    this.completed = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this.worker.postMessage({
      type: "solve",
      options: this.options,
      revision: this.revision,
    });
    this.scene.requestRender();
    return this.completed;
  }
  _request(type, payload) {
    if (!this.ready) {
      return Promise.reject(new Error("DDGI field is not ready"));
    }
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._requests.set(id, { resolve, reject });
      this.worker.postMessage({
        type,
        revision: this.revision,
        id,
        ...payload,
      });
    });
  }
  sample(points) {
    return this._request("sample", { points });
  }
  trace(rays) {
    return this._request("trace", { rays });
  }
  surfaces(materials) {
    return this._request("surfaces", { materials });
  }
  _releaseTextures() {
    for (const name of [
      "irradianceTexture",
      "distanceTexture",
      "positionTexture",
    ]) {
      this[name]?.destroy();
      this[name] = undefined;
    }
    this.memoryBytes = 0;
  }
  destroy() {
    this._closed = true;
    this.worker.terminate();
    this._reject?.(new Error("Lumen world destroyed"));
    for (const request of this._requests.values()) {
      request.reject(new Error("Lumen world destroyed"));
    }
    this._requests.clear();
    this._releaseTextures();
    this.ready = false;
    this.status = "destroyed";
  }
}
export default LumenWorld;
