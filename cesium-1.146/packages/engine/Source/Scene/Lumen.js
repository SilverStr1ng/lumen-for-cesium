import { Cartesian3, DeveloperError, destroyObject } from "@cesium/core";
import LumenWorld from "./LumenWorld.js";
import LumenGpuWorld from "./LumenGpuWorld.js";
import LumenFinalGather from "./LumenFinalGather.js";

/**
 * Experimental diffuse-lighting integration. Irradiance is linear E (not E/pi).
 * Stage A provides controlled illumination for validating the rendering contract.
 * @alias Lumen
 * @constructor
 * @param {Scene} scene The owning scene.
 */
function Lumen(scene) {
  this._scene = scene;
  this._enabled = false;
  this._irradiance = new Cartesian3(0.5, 0.5, 0.5);
  this._coverage = 1.0;
  this._debugMode = 0;
  this._diffuseResponse = "lambert";
  this._iblPolicy = "enhanced";
  this.world = undefined;
  this.finalGather = new LumenFinalGather(this);
}

Object.defineProperties(Lumen.prototype, {
  /** Enhanced multiscatter allocation is opt-in within active supported Lumen materials. Disabled Lumen always restores the original engine IBL. */
  iblPolicy: {
    get() {
      return this._iblPolicy;
    },
    set(value) {
      if (!["legacy", "enhanced"].includes(value)) {
        throw new DeveloperError("IBL policy must be legacy or enhanced");
      }
      this._iblPolicy = value;
      this._scene.requestRender();
    },
  },
  /** lambert: controlled rho E/pi; cesium: reuse IBL Fresnel/multiscatter energy allocation. */
  diffuseResponse: {
    get() {
      return this._diffuseResponse;
    },
    set(value) {
      if (!["lambert", "cesium"].includes(value)) {
        throw new DeveloperError("diffuseResponse must be lambert or cesium");
      }
      this._diffuseResponse = value;
      this._scene.requestRender();
    },
  },
  /** Enable the controlled diffuse irradiance and component-aware shadows. */
  enabled: {
    get() {
      return this._enabled;
    },
    set(value) {
      this._enabled = Boolean(value);
      this._scene.requestRender();
    },
  },
  /** Linear RGB irradiance. The material applies diffuse reflectance / pi. */
  irradiance: {
    get() {
      return Cartesian3.clone(this._irradiance);
    },
    set(value) {
      if (
        !value ||
        ![value.x, value.y, value.z].every((v) => Number.isFinite(v) && v >= 0)
      ) {
        throw new DeveloperError(
          "irradiance must contain finite, nonnegative x, y and z.",
        );
      }
      Cartesian3.clone(value, this._irradiance);
      this._scene.requestRender();
    },
  },
  /** Fraction of diffuse IBL replaced by the new irradiance, in [0, 1]. */
  coverage: {
    get() {
      return this._coverage;
    },
    set(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new DeveloperError("coverage must be in [0, 1].");
      }
      this._coverage = value;
      this._scene.requestRender();
    },
  },
  /** 0: final, 1: direct, 2: indirect diffuse, 3: emissive, 4: E, 5: coverage, 6: shadow, 7/8: direct diffuse/specular, 9/10: specular/diffuse IBL, 11: local GI removed, 12: multiple scattering, 13: raw FG, 14: reconstructed FG, 15: reconstruction weight. All precede display transforms. */
  debugMode: {
    get() {
      return this._debugMode;
    },
    set(value) {
      if (!Number.isInteger(value) || value < 0 || value > 20) {
        throw new DeveloperError("debugMode must be an integer in [0, 20].");
      }
      this._debugMode = value;
      this._scene.requestRender();
    },
  },
});

/** Load one resident static glTF in the same local frame as its display model.
 * Returns a DDGI world; await world.completed for convergence.
 * @param {object} options backend ("gpu" or "cpu"), matching workerUrl, url,
 * modelMatrix, axisMatrix and probe settings.
 * @returns {object} The world adapter.
 */
Lumen.prototype.loadWorld = function (options) {
  this.finalGather.release();
  this.world?.destroy();
  const World = options.backend === "gpu" ? LumenGpuWorld : LumenWorld;
  this.world = new World(this._scene, {
    ...options,
    captureFinalGather:
      options.captureFinalGather ?? this.finalGather.mode !== "ddgi",
  });
  return this.world;
};
Lumen.prototype.update = function () {
  this.finalGather.beginFrame();
  this.world?.update();
};

Lumen.prototype.isDestroyed = function () {
  return false;
};
Lumen.prototype.destroy = function () {
  this.finalGather.destroy();
  this.world?.destroy();
  this._scene = undefined;
  return destroyObject(this);
};

export default Lumen;
