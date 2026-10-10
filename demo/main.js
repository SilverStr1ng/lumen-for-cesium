const C = window.Cesium;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const constantMode = params.get("backend") === "constant";
const gpuMode = !constantMode && params.get("backend") !== "cpu";
const asset =
  params.get("model") ??
  "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf";
const widget = new C.CesiumWidget("view", {
  globe: false,
  skyBox: false,
  skyAtmosphere: false,
  useDefaultRenderLoop: params.get("manual") !== "1",
  contextOptions: { webgl: { preserveDrawingBuffer: true } },
  msaaSamples: 1,
});
const scene = widget.scene;
scene.rethrowRenderErrors = true;
scene.highDynamicRange = true;
scene.fog.enabled = false;
scene.backgroundColor = C.Color.fromCssColorString("#171d24");
scene.lumen.enabled = true;
$("capture").checked = params.get("capture") === "1" || !gpuMode;
scene.gBuffer.enabled = $("capture").checked;
scene.shadowMap.enabled = true;
scene.shadowMap.maximumDistance = 150;
scene.shadowMap.darkness = 0.0;
scene.shadowMap.size = Number(params.get("shadowSize") ?? 2048);
widget.resolutionScale = Number(params.get("scale") ?? 1);
const origin = C.Cartesian3.fromDegrees(114.1, 22.3, 50);
const frame = C.Transforms.eastNorthUpToFixedFrame(origin);
const rotation = C.Matrix4.getMatrix3(frame, new C.Matrix3());
let sunDegrees,
  relightTimer,
  pendingLighting = false;
function worldLighting() {
  const a = C.Math.toRadians(sunDegrees);
  return {
    sunDirection: [Math.cos(a), Math.sin(a), 0.65],
    sunRadiance: [2, 2, 2],
    skyRadiance: [0.15, 0.18, 0.25].map((v) => v * Number($("sky").value)),
    bounces: Number($("bounces").value),
    neutralMaterials: $("neutral").checked ? [16, 18] : [],
  };
}
function relight() {
  pendingLighting = true;
  clearTimeout(relightTimer);
  relightTimer = setTimeout(
    () => {
      relightTimer = undefined;
      if (
        scene.lumen.world?.packet &&
        !scene.lumen.world.error &&
        scene.lumen.world.status !== "destroyed"
      ) {
        pendingLighting = false;
        scene.lumen.world.solve(worldLighting()).catch(reportError);
      }
    },
    gpuMode ? 0 : 400,
  );
}
function sun(degrees) {
  const changed = sunDegrees !== degrees;
  sunDegrees = degrees;
  const a = C.Math.toRadians(degrees);
  const direction = C.Cartesian3.normalize(
    new C.Cartesian3(-Math.cos(a), -Math.sin(a), -0.65),
    new C.Cartesian3(),
  );
  C.Matrix3.multiplyByVector(rotation, direction, direction);
  scene.light = new C.DirectionalLight({ direction, intensity: 2.0 });
  scene.requestRender();
  if (changed && scene.lumen.world) relight();
}
sun(40);

const gbufferView = new C.PostProcessStage({
  name: "lumen-material-debug",
  fragmentShader: `uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_position;
uniform sampler2D u_emissive;
uniform int u_mode;
in vec2 v_textureCoordinates;
void main() {
  vec4 a = texture(u_albedo, v_textureCoordinates);
  vec4 n = texture(u_normal, v_textureCoordinates);
  vec4 p = texture(u_position, v_textureCoordinates);
  vec3 c = vec3(0.0);
  if (u_mode == 1) c = czm_linearToSrgb(a.rgb);
  if (u_mode == 2) c = n.xyz * 0.5 + 0.5;
  if (u_mode == 3) c = vec3(n.a);
  if (u_mode == 4) c = vec3(log2(1.0 + p.a) / 8.0);
  if (u_mode == 5) c = vec3(a.a);
  if (u_mode == 6) c = czm_linearToSrgb(texture(u_emissive, v_textureCoordinates).rgb);
  out_FragColor = vec4(a.a > 0.5 ? c : vec3(0.03, 0.04, 0.05), 1.0);
}`,
  uniforms: {
    u_albedo: () => scene.gBuffer.albedoTexture ?? scene.context.defaultTexture,
    u_normal: () => scene.gBuffer.normalTexture ?? scene.context.defaultTexture,
    u_position: () =>
      scene.gBuffer.positionTexture ?? scene.context.defaultTexture,
    u_emissive: () =>
      scene.gBuffer.emissiveTexture ?? scene.context.defaultTexture,
    u_mode: () =>
      ({ albedo: 1, normal: 2, roughness: 3, depth: 4, validity: 5 })[
        $("mode").value
      ] ?? 0,
  },
});
scene.postProcessStages.add(gbufferView);
gbufferView.enabled = false;
function apply() {
  scene.lumen.enabled = $("enabled").checked;
  scene.shadowMap.enabled = $("shadows").checked;
  const energy = Number($("energy").value);
  scene.lumen.irradiance = new C.Cartesian3(energy, energy, energy);
  if (scene.lumen.world) scene.lumen.world.gain = energy * 2;
  $("energyValue").value = (constantMode ? energy : energy * 2).toFixed(2);
  scene.lumen.coverage = Number($("coverage").value);
  scene.postProcessStages.exposure = Number($("exposure").value);
  scene.lumen.debugMode =
    { direct: 1, indirect: 2, emission: 3 }[$("mode").value] ?? 0;
  const wantsCapture = [
    "albedo",
    "normal",
    "roughness",
    "depth",
    "validity",
  ].includes($("mode").value);
  if (wantsCapture) $("capture").checked = true;
  scene.gBuffer.enabled = $("capture").checked;
  gbufferView.enabled = wantsCapture;
  sun(Number($("sun").value));
  scene.requestRender();
}
for (const id of [
  "enabled",
  "shadows",
  "energy",
  "coverage",
  "exposure",
  "sun",
  "mode",
  "capture",
])
  $(id).addEventListener("input", apply);
for (const id of ["bounces", "sky", "neutral"])
  $(id).addEventListener("input", relight);
apply();
function outside() {
  const sphere = model.boundingSphere;
  scene.camera.lookAt(
    sphere.center,
    new C.HeadingPitchRange(
      C.Math.toRadians(35),
      C.Math.toRadians(-25),
      sphere.radius * 1.55,
    ),
  );
  scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
  scene.requestRender();
}
function inside() {
  const radius = model.boundingSphere.radius;
  const center = C.Matrix4.multiplyByPoint(
    C.Matrix4.inverse(frame, new C.Matrix4()),
    model.boundingSphere.center,
    new C.Cartesian3(),
  );
  const target = new C.Cartesian3(center.x + radius * 0.3, center.y, 3.0);
  const eye = new C.Cartesian3(center.x - radius * 0.35, center.y, 1.7);
  const direction = C.Cartesian3.normalize(
    C.Cartesian3.subtract(target, eye, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  scene.camera.setView({
    destination: C.Matrix4.multiplyByPoint(frame, eye, new C.Cartesian3()),
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
}
$("outside").onclick = () => outside();
$("inside").onclick = () => inside();
$("reset").onclick = () => {
  $("enabled").checked = $("shadows").checked = true;
  $("capture").checked = !gpuMode;
  $("energy").value = 0.5;
  $("coverage").value = $("exposure").value = 1;
  $("sun").value = 40;
  $("mode").value = "final";
  $("sky").value = 1;
  $("bounces").value = 3;
  $("neutral").checked = false;
  apply();
  if (scene.lumen.world) relight();
  outside();
};

let model;
let lastFrameTime;
const frameIntervals = [];
const errors = [];
function reportError(error) {
  if (String(error).includes("superseded")) return;
  errors.push(String(error));
  $("error").textContent = String(error);
}
scene.renderError.addEventListener((s, error) => {
  errors.push(String(error));
  $("error").textContent = String(error);
});
scene.postRender.addEventListener(() => {
  const now = performance.now();
  if (lastFrameTime !== undefined && document.visibilityState === "visible")
    frameIntervals.push(now - lastFrameTime);
  lastFrameTime = now;
  if (frameIntervals.length > 60) frameIntervals.shift();
  const fps = frameIntervals.length
    ? (1000 * frameIntervals.length) / frameIntervals.reduce((a, b) => a + b, 0)
    : 0;
  const g = scene.gBuffer;
  const wantsDebug = [
    "albedo",
    "normal",
    "roughness",
    "depth",
    "validity",
  ].includes($("mode").value);
  const canDisplay =
    wantsDebug && g.status === "ready" && Boolean(g.framebuffer);
  if (gbufferView.enabled !== canDisplay) {
    gbufferView.enabled = canDisplay;
    scene.requestRender();
  }
  $("status").textContent =
    `${model?.ready ? "Sponza 已就绪" : "载入纹理…"}\n${fps.toFixed(1)} FPS · ${scene.drawingBufferWidth}×${scene.drawingBufferHeight}\nGBuffer: ${g.status} · ${(g.memoryBytes / 1048576).toFixed(1)} MiB\n${g.drawCommands} draws · ${g.frustums} frustums\nWebGL2: ${scene.context.webgl2} · HDR: ${scene.highDynamicRange}`;
  const w = scene.lumen.world;
  if (
    pendingLighting &&
    !relightTimer &&
    w?.packet &&
    !w.error &&
    w.status !== "destroyed"
  )
    relight();
  if (w?.error && !errors.includes(w.error)) reportError(w.error);
  if (w)
    $("status").textContent +=
      `\nDDGI: ${w.status} · ${w.progress?.completed ?? 0}/${w.progress?.total ?? "…"}\nBVH: ${w.packet?.bvh.triangles ?? "…"} tris · Cache: ${w.packet?.cache.surfels ?? "…"} ${gpuMode ? "slots" : "surfels"}\nProbes: ${gpuMode ? (w.packet?.grid.total ?? "…") : `${w.packet?.active ?? "…"}/${w.packet?.grid.total ?? "…"}`} · bounce ${w.packet?.bounce ?? 0}\nGPU textures: ${(w.memoryBytes / 1048576).toFixed(2)} MiB${w.metrics?.updates.length ? `\n上次 GI 更新 ${(w.metrics.updates.at(-1).milliseconds / 1000).toFixed(2)} s` : ""}`;
});
window.lumenDemo = {
  widget,
  scene,
  frame,
  errors,
  gbufferView,
  outside,
  inside,
  sun,
  apply,
  get model() {
    return model;
  },
};
try {
  model = await C.Model.fromGltfAsync({
    url: asset,
    modelMatrix: frame,
    forwardAxis: C.Axis.X,
    shadows: C.ShadowMode.ENABLED,
    incrementallyLoadTextures: false,
  });
  model.environmentMapManager.enabled = false;
  scene.primitives.add(model);
  model.readyEvent.addEventListener(() => {
    inside();
    window.lumenDemo.ready = true;
    if (!constantMode) {
      const world = scene.lumen.loadWorld({
        backend: gpuMode ? "gpu" : "cpu",
        url: asset,
        workerUrl: new URL(
          gpuMode ? "../lumen/gpu-worker.js" : "../lumen/worker.js",
          import.meta.url,
        ).href,
        modelMatrix: frame,
        axisMatrix: C.Matrix4.toArray(model._sceneGraph.axisCorrectionMatrix),
        spacing: Number(params.get("spacing") ?? 2),
        rays: Number(params.get("rays") ?? 128),
        targetGpuMilliseconds: Number(params.get("gpuBudget") ?? 3),
        maxBatch: Number(params.get("batch") ?? 128),
        ...worldLighting(),
        diagnosticIntegrationLut: params.has("integrationComparison"),
      });
      world.completed.catch(reportError);
      world.gain = Number($("energy").value) * 2;
    }
  });
  scene.requestRender();
} catch (error) {
  errors.push(String(error));
  $("error").textContent = `Sponza 加载失败：${error}`;
}
