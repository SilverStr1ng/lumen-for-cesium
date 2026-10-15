import LumenSession from "../lumen/LumenSession.js";
// Both independent pages use the public facade. Cesium owns the render loop.
const C = window.Cesium;
C.Ion.defaultAccessToken = "";
const display = document.documentElement.dataset.display;
const dataset = new URL("../fixtures/local-pilot/dataset.json", import.meta.url)
  .href;
let widget,
  session,
  night = false;
const status = document.getElementById("status");
function focus() {
  const anchor = session.status().anchor;
  if (!anchor) return;
  const frame = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.height),
  );
  widget.scene.camera.lookAtTransform(frame, new C.Cartesian3(35, -43, 30));
  widget.scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
}
function view({ eye, target }) {
  const anchor = session.status().anchor,
    frame = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(
        anchor.longitude,
        anchor.latitude,
        anchor.height,
      ),
    );
  const position = C.Matrix4.multiplyByPoint(
      frame,
      C.Cartesian3.fromArray(eye),
      new C.Cartesian3(),
    ),
    direction = C.Cartesian3.normalize(
      C.Matrix4.multiplyByPointAsVector(
        frame,
        C.Cartesian3.fromArray(target.map((v, i) => v - eye[i])),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    ),
    up = C.Matrix4.multiplyByPointAsVector(
      frame,
      C.Cartesian3.UNIT_Z,
      new C.Cartesian3(),
    );
  widget.scene.camera.setView({
    destination: position,
    orientation: { direction, up },
  });
  widget.scene.requestRender();
}
async function setup() {
  session?.dispose();
  if (widget && !widget.isDestroyed()) widget.destroy();
  widget = new C.CesiumWidget("view", {
    baseLayer: false,
    terrainProvider: new C.EllipsoidTerrainProvider(),
    shadows: true,
  });
  widget.scene.atmosphere.dynamicLighting =
    C.DynamicAtmosphereLightingType.SCENE_LIGHT;
  widget.scene.globe.enableLighting = true;
  widget.scene.globe.dynamicAtmosphereLightingFromSun = false;
  widget.scene.globe.depthTestAgainstTerrain = true;
  widget.scene.highDynamicRange = true;
  widget.scene.shadowMap.enabled = true;
  widget.scene.shadowMap.size = 2048;
  widget.scene.postProcessStages.tonemapping = C.Tonemapper.ACES;
  widget.scene.postProcessStages.exposure = 1;
  session = new LumenSession({
    Cesium: C,
    scene: widget.scene,
    display,
    onDatasetCommitted: focus,
    awaitDisplay: true,
    profile:
      new URLSearchParams(location.search).get("profile") ??
      document.getElementById("profile").value,
  });
  window.pilotSession = session;
  window.pilotHost = {
    replace: (uri) => session.replaceDataset(uri ?? dataset),
    recreate: setup,
    focus,
    view,
    scene: widget.scene,
    setRenderingEnabled: (enabled) => {
      widget.useDefaultRenderLoop = enabled;
    },
  };
  await session.load(dataset);
  focus();
  return session.status();
}
async function run(action) {
  try {
    await action();
  } catch (error) {
    status.textContent = String(error);
    console.error(error);
  }
}
document.getElementById("profile").onchange = (event) =>
  run(() => session.setQuality(event.target.value));
document.getElementById("light").onclick = () =>
  run(() => {
    night = !night;
    return session.setLighting(
      night
        ? {
            sunDirection: [0.8, 0.2, 0.15],
            sunRadiance: [0.4, 0.15, 0.05],
            skyRadiance: [0.03, 0.04, 0.08],
          }
        : {
            sunDirection: [-0.8, 0.6, 1.1],
            sunRadiance: [2, 2, 2],
            skyRadiance: [0.15, 0.18, 0.22],
          },
    );
  });
document.getElementById("replace").onclick = () =>
  run(() => session.replaceDataset(dataset));
document.getElementById("failure").onclick = () =>
  run(() =>
    session.replaceDataset(
      new URL("../fixtures/missing-pilot.json", import.meta.url).href,
    ),
  );
document.getElementById("cancel").onclick = () => session.cancel();
let parentLod = false;
if (display === "tiles")
  document.getElementById("lod").onclick = () =>
    run(() => {
      parentLod = !parentLod;
      return session.setDisplayDetail(parentLod ? "parent" : "children");
    });
document.getElementById("recreate").onclick = () => run(setup);
setInterval(() => {
  if (!session) return;
  const s = session.status();
  status.textContent = JSON.stringify(
    {
      phase: s.phase,
      startup: s.startup,
      requested: s.profile,
      effective: s.effectiveProfile,
      version: s.version?.slice(0, 12),
      assets: s.audit.length,
      targets: s.targets,
      fg: {
        requested: s.fg.requestedMode,
        effective: s.fg.effectiveMode,
        receiverSize: s.fg.receiverSize,
        samples: s.fg.samples,
        drawingBuffer: s.fg.drawingBuffer,
      },
      world: s.world,
      tiles: s.tiles,
      resources: s.resources,
      error: s.error,
      fallback: s.fallbackReason,
      pilotReady: s.pilotReady,
    },
    null,
    2,
  );
}, 500);
window.addEventListener("pagehide", () => session?.dispose(), { once: true });
run(setup);
