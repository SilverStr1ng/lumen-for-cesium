// Shared light ownership; the atmosphere specular source is explicitly a different
// approximation from the controlled upper-hemisphere GI sky.
export class LightingEnvironment {
  constructor(enabled = false) {
    this.sun = {};
    this.giSky = {};
    this.specular = {
      enabled,
      source:
        "Cesium atmosphere/ground, SCENE_LIGHT, no sun disk or local-building reflections",
      orientation: "local ENU through Cesium IBL reference frame",
      generateSphericalHarmonics: false,
    };
    this.versions = {
      sun: 0,
      giSky: 0,
      specularRequested: 0,
      specularPublished: 0,
    };
    this._sunKey = "";
    this._skyKey = "";
  }
  update(lighting) {
    const direction = lighting.sunDirection.map(
        (v) => v / Math.hypot(...lighting.sunDirection),
      ),
      intensity = Math.max(...lighting.sunRadiance),
      color = lighting.sunRadiance.map((v) => (intensity ? v / intensity : 0));
    const sunKey = JSON.stringify([direction, intensity, color]),
      skyKey = JSON.stringify([lighting.skyRadiance, lighting.environmentMode]);
    const changed = sunKey !== this._sunKey;
    if (changed) {
      this.versions.sun++;
      if (this.specular.enabled) this.versions.specularRequested++;
      this._sunKey = sunKey;
    }
    if (skyKey !== this._skyKey) {
      this.versions.giSky++;
      this._skyKey = skyKey;
    }
    this.sun = { direction, intensity, color };
    this.giSky = {
      radiance: [...lighting.skyRadiance],
      mode: lighting.environmentMode,
    };
    return changed;
  }
  snapshot() {
    return {
      sun: { ...this.sun },
      giSky: { ...this.giSky },
      specular: { ...this.specular },
      versions: { ...this.versions },
      approximation:
        "GI uses controlled sky radiance; specular uses atmospheric scattering and ground, not exposure/gain matching.",
    };
  }
}
