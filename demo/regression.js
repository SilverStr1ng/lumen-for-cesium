const C = Cesium,
  params = new URLSearchParams(location.search);
const fixture = params.get("fixture") ?? "untextured";
const metadata = await (await fetch(`/fixtures/${fixture}.json`)).json();
const widget = new C.CesiumWidget("view", {
  globe: false,
  skyBox: false,
  skyAtmosphere: false,
  msaaSamples: 1,
  contextOptions: { webgl: { preserveDrawingBuffer: true } },
  requestRenderMode: params.get("onDemand") === "1",
  maximumRenderTimeChange: Infinity,
});
const scene = widget.scene;
scene.highDynamicRange = true;
scene.fog.enabled = false;
scene.rethrowRenderErrors = true;
scene.shadowMap.enabled = true;
scene.shadowMap.size = 2048;
scene.shadowMap.darkness = 0;
scene.lumen.enabled = true;
scene.gBuffer.enabled = false;
const frame = C.Transforms.eastNorthUpToFixedFrame(
  C.Cartesian3.fromDegrees(114.1, 22.3, 50),
);
const rotation = C.Matrix4.getMatrix3(frame, new C.Matrix3());
const errors = [];
scene.renderError.addEventListener((_, e) => errors.push(String(e)));
const test = (window.lumenTest = {
  widget,
  scene,
  frame,
  metadata,
  errors,
  ready: false,
});
test.camera = (eye, target) => {
  const direction = C.Cartesian3.normalize(
    C.Cartesian3.subtract(
      C.Cartesian3.fromArray(target),
      C.Cartesian3.fromArray(eye),
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  scene.camera.setView({
    destination: C.Matrix4.multiplyByPoint(
      frame,
      C.Cartesian3.fromArray(eye),
      new C.Cartesian3(),
    ),
    orientation: {
      direction: C.Matrix3.multiplyByVector(
        rotation,
        direction,
        new C.Cartesian3(),
      ),
      up: C.Matrix3.multiplyByVector(
        rotation,
        C.Cartesian3.UNIT_Z,
        new C.Cartesian3(),
      ),
    },
  });
  scene.requestRender();
};
const lighting = {
  sunDirection: [1, 0, 0.65],
  sunRadiance: [2, 2, 2],
  skyRadiance: [0.15, 0.18, 0.25],
  bounces: 3,
};
test.light = (options) => {
  Object.assign(lighting, options);
  const d = C.Cartesian3.normalize(
    C.Cartesian3.fromArray(lighting.sunDirection),
    new C.Cartesian3(),
  );
  C.Cartesian3.negate(d, d);
  scene.light = new C.DirectionalLight({
    direction: C.Matrix3.multiplyByVector(rotation, d, new C.Cartesian3()),
    color: new C.Color(...lighting.sunRadiance),
    intensity: 1,
  });
};
test.light({});
try {
  const model = await C.Model.fromGltfAsync({
    url: `/fixtures/${fixture}.gltf`,
    modelMatrix: frame,
    upAxis: C.Axis.Z,
    forwardAxis: C.Axis.X,
    incrementallyLoadTextures: false,
    shadows: C.ShadowMode.ENABLED,
  });
  model.environmentMapManager.enabled = false;
  scene.primitives.add(model);
  test.model = model;
  test.load = (extra = {}) => {
    const world = scene.lumen.loadWorld({
      url: new URL(`/fixtures/${fixture}.gltf`, location.href).href,
      backend: "gpu",
      workerUrl: new URL("../lumen/gpu-worker.js", import.meta.url).href,
      modelMatrix: frame,
      axisMatrix: C.Matrix4.toArray(model._sceneGraph.axisCorrectionMatrix),
      spacing: 1,
      rays: 128,
      targetGpuMilliseconds: 3,
      maxBatch: 128,
      diagnosticIntegrationLut: new URLSearchParams(location.search).has(
        "integrationComparison",
      ),
      ...lighting,
      ...extra,
    });
    world.completed.catch((e) => {
      if (!String(e).includes("superseded") && !String(e).includes("destroyed"))
        errors.push(String(e));
    });
    return (test.world = world);
  };
  model.readyEvent.addEventListener(() => {
    test.camera(metadata.camera.eye, metadata.camera.target);
    test.load();
    test.ready = true;
  });
  scene.postRender.addEventListener(() => {
    document.getElementById("status").textContent =
      `${fixture} · ${test.world?.status ?? "loading"} · revision ${test.world?.packet?.revision ?? 0} / bounce ${test.world?.packet?.bounce ?? 0}`;
  });
  scene.requestRender();
} catch (e) {
  errors.push(String(e));
  document.getElementById("status").textContent = String(e);
}
