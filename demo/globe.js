import { LightingEnvironment } from "./lighting-environment.js";
const params = new URLSearchParams(location.search);
const gallery = document.documentElement.dataset.scene === "gallery";
let galleryEmitter = !params.has("emitterOff");
const selectedAsset = () =>
  gallery
    ? galleryEmitter
      ? "earth-gi-gallery"
      : "earth-gi-gallery-off"
    : params.has("barrier")
      ? "fg-slanted-barrier"
      : currentPreset === "presentation"
        ? "earth-pavilion-presentation"
        : params.has("heldOut")
          ? "earth-pavilion-held-out"
          : "earth-pavilion";
let currentPreset =
  params.get("preset") === "presentation" || gallery
    ? "presentation"
    : "regression";
let currentQuality = params.get("quality") === "fine" ? "fine" : "original";
const C = Cesium,
  $ = (id) => document.getElementById(id);
// No Viewer default imagery/geocoder: only explicitly supplied local resources.
C.Ion.defaultAccessToken = "";
const widget = new C.CesiumWidget("view", {
  baseLayer: false,
  terrainProvider: new C.EllipsoidTerrainProvider(),
  msaaSamples: currentPreset === "presentation" ? 4 : 1,
  contextOptions: {
    webgl: {
      preserveDrawingBuffer: new URLSearchParams(location.search).has(
        "diagnostic",
      ),
    },
  },
});
const scene = widget.scene;
if (gallery && !params.has("nativeBuffer")) {
  const limitResolution = () => {
    widget.resolutionScale = Math.min(1, 1280 / innerWidth, 800 / innerHeight);
    scene.requestRender();
  };
  limitResolution();
  addEventListener("resize", limitResolution);
}
const wantsEnvironment = () =>
  currentPreset === "presentation" || params.get("ibl") === "dynamic";
const lightingEnvironment = new LightingEnvironment(wantsEnvironment());
scene.atmosphere.dynamicLighting = C.DynamicAtmosphereLightingType.SCENE_LIGHT;
scene.highDynamicRange = true;
scene.gBuffer.enabled = false;
scene.lumen.enabled = true;
scene.lumen.finalGather.mode = ["fg", "raw"].includes(params.get("fg"))
  ? params.get("fg")
  : "ddgi";
scene.lumen.finalGather.quality = [
  "auto",
  "balanced",
  "high",
  "fast",
  "roi",
].includes(params.get("fgQuality"))
  ? params.get("fgQuality")
  : "balanced";
scene.lumen.finalGather.sampling = [
  "fixed-reference",
  "scrambled-single-frame",
  "reconstructed",
].includes(params.get("fgSampling"))
  ? params.get("fgSampling")
  : "fixed-reference";
scene.lumen.finalGather.seed = Number(params.get("fgSeed") ?? 0) | 0;
scene.shadowMap.enabled = true;
scene.shadowMap.size = 2048;
scene.shadowMap.maximumDistance = 150;
scene.shadowMap.darkness = 0;
scene.globe.depthTestAgainstTerrain = true;
scene.globe.enableLighting = true;
scene.globe.dynamicAtmosphereLightingFromSun = false;
scene.sun.show = false;
scene.fog.enabled = false;
const errors = [];
function safeError(error) {
  let message = String(error).replace(
    /([?&]access_token=)[^&#\s"']+/gi,
    "$1[REDACTED]",
  );
  const token = $("token").value;
  if (token) {
    message = message.split(token).join("[REDACTED]");
    message = message.split(encodeURIComponent(token)).join("[REDACTED]");
  }
  return message;
}
const fail = (e) => {
  const message = safeError(e);
  if (/destroyed|superseded/.test(message)) return;
  errors.push(message);
  $("error").textContent = message;
};
scene.renderError.addEventListener((s, e) => fail(e));
let metadata,
  frame,
  rotation,
  model,
  generation = 0,
  networkGeneration = 0,
  pendingLighting = false;
const anchor = { longitude: 114.1, latitude: 22.3, height: 1.5, heading: 0 };
function setFrame() {
  frame = C.Transforms.headingPitchRollToFixedFrame(
    C.Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.height),
    new C.HeadingPitchRoll(C.Math.toRadians(anchor.heading), 0, 0),
  );
  rotation = C.Matrix4.getMatrix3(frame, new C.Matrix3());
}
setFrame();
const lighting = {
  sunDirection: [1, 0, 0.65],
  sunRadiance: [2, 2, 2],
  skyRadiance: [0.15, 0.18, 0.25],
  bounces: 3,
  environmentMode: "upper-hemisphere",
};
const defaultSunElevation = C.Math.toDegrees(Math.atan(0.65));
$("sunHeight").value = String(defaultSunElevation);
const lightingController = {
  update() {
    const a = C.Math.toRadians(Number($("sun").value));
    const requestedElevation = Number($("sunHeight").value);
    const elevation = Number.isFinite(requestedElevation)
      ? C.Math.clamp(requestedElevation, 1, 89)
      : defaultSunElevation;
    $("sunHeight").value = String(elevation);
    // Preserve the previous default transport vector exactly, without rounding
    // the displayed degrees or introducing a tan(atan(.65)) round-trip.
    const vertical =
      elevation === defaultSunElevation
        ? 0.65
        : Math.tan(C.Math.toRadians(elevation));
    lighting.sunDirection = [Math.cos(a), Math.sin(a), vertical];
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
    const environmentChanged = lightingEnvironment.update(lighting);
    if (environmentChanged && model?.environmentMapManager.enabled) {
      model.environmentMapManager.atmosphereScatteringIntensity =
        lightingEnvironment.sun.intensity;
      model.environmentMapManager.reset();
    }
  },
};
function options() {
  return {
    ...lighting,
    publicationMode: $("publication").value,
    displayTransitionMilliseconds: $("transition").checked ? 150 : 0,
    neutralMaterials: $("neutral").checked ? [1, 2] : [],
  };
}
function relight() {
  lightingController.update();
  const w = scene.lumen.world;
  if (w?.packet && !w.isDestroyed()) {
    pendingLighting = false;
    try {
      w.solve(options()).catch(fail);
    } catch (error) {
      fail(error);
    }
  } else pendingLighting = !w || !w.isDestroyed();
  scene.requestRender();
}
function camera(name, fly = false) {
  fly = fly && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  scene.camera.cancelFlight();
  if (name === "earth") {
    scene.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(
        anchor.longitude,
        anchor.latitude,
        22000000,
      ),
      duration: fly ? 2 : 0,
    });
    return;
  }
  const closeups = {
    boxFoot: { eye: [-6.4, -5.3, 2.0], target: [-9.7, -1.8, 0.5] },
    wallFoot: { eye: [-6.8, 5.3, 2], target: [-10.6, 7.4, 0.5] },
    pillarFoot: { eye: [-3.7, -5, 1.6], target: [-7, -2, 0.45] },
    ceiling: { eye: [-5, 5, 2], target: [-9.8, 7.3, 4.8] },
  };
  const bookmark = metadata?.cameras[name] ?? closeups[name];
  if (!bookmark) return;
  const eye = C.Cartesian3.fromArray(bookmark.eye),
    direction = C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        C.Cartesian3.fromArray(bookmark.target),
        eye,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
  const view = {
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
  };
  if (fly) scene.camera.flyTo({ ...view, duration: 2 });
  else scene.camera.setView(view);
  scene.requestRender();
}
async function localLayers() {
  const own = ++networkGeneration;
  scene.terrainProvider = new C.EllipsoidTerrainProvider();
  const provider = await C.TileMapServiceImageryProvider.fromUrl(
    C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
  );
  if (own !== networkGeneration) return false;
  scene.imageryLayers.removeAll();
  scene.imageryLayers.addImageryProvider(provider);
  if (metadata && anchor.height !== metadata.anchor.height) {
    anchor.height = metadata.anchor.height;
    await reload();
  }
  if (own !== networkGeneration) return false;
  $("network").textContent = "本地 NaturalEarthII + 椭球地形";
  return true;
}
function watchProvider(provider, own, isCurrent, label) {
  let fallingBack = false;
  provider.errorEvent.addEventListener(() => {
    if (fallingBack || own !== networkGeneration || !isCurrent()) return;
    fallingBack = true;
    localLayers()
      .then((applied) => {
        if (applied)
          $("network").textContent = `${label}瓦片请求失败；已回退本地`;
      })
      .catch(fail);
  });
}
async function enhance() {
  const token = $("token").value;
  const id = Number($("asset").value);
  const terrain = $("terrain").checked;
  if (!token) {
    $("network").textContent = "未提供 token，保留当前配置";
    return;
  }
  const own = ++networkGeneration;
  try {
    const results = await Promise.all([
      id
        ? C.IonImageryProvider.fromAssetId(id, { accessToken: token })
        : C.TileMapServiceImageryProvider.fromUrl(
            C.buildModuleUrl("Assets/Textures/NaturalEarthII"),
          ),
      terrain
        ? C.CesiumTerrainProvider.fromIonAssetId(1, { accessToken: token })
        : null,
    ]);
    if (own !== networkGeneration) return;
    // Resolve one stable placement before activating terrain, never clamp only
    // the display model. A newer UI configuration invalidates this transaction.
    const previousGeneration = generation;
    const height = results[1] ? await terrainHeight(results[1]) : undefined;
    if (own !== networkGeneration) return;
    if (previousGeneration !== generation) {
      // Reload canceled placement after this transaction invalidated the old
      // providers' listeners. Restore a configuration with valid ownership.
      if (await localLayers())
        $("network").textContent =
          "局部场景已重载；取消待应用地形并恢复本地配置";
      return;
    }
    if (results[0]) {
      scene.imageryLayers.removeAll();
      const layer = scene.imageryLayers.addImageryProvider(results[0]);
      watchProvider(
        results[0],
        own,
        () => scene.imageryLayers.contains(layer),
        "影像",
      );
    }
    if (results[1]) {
      scene.terrainProvider = results[1];
      watchProvider(
        results[1],
        own,
        () => scene.terrainProvider === results[1],
        "地形",
      );
      anchor.height = height;
      await reload();
    } else {
      scene.terrainProvider = new C.EllipsoidTerrainProvider();
      if (metadata && anchor.height !== metadata.anchor.height) {
        anchor.height = metadata.anchor.height;
        await reload();
      }
    }
    if (own !== networkGeneration) return;
    $("network").textContent = results[1]
      ? "ion 增强已启用；中心/四角采样完成，同一稳定锚点已重建"
      : "影像已应用；已使用本地椭球地形与共享高度";
  } catch (error) {
    if (own !== networkGeneration) return;
    const applied = await localLayers();
    if (!applied) return;
    $("network").textContent =
      `ion 增强失败（${Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : (error?.placementCode ?? "NETWORK_OR_CONFIGURATION")}），已回退本地影像和椭球地形（凭据不记录）`;
  }
}
async function reload() {
  if (!metadata) return;
  const own = ++generation;
  if (probePoints) {
    scene.primitives.remove(probePoints);
    probePoints = undefined;
  }
  const old = scene.lumen.world;
  if (old) old.destroy();
  if (model) {
    scene.primitives.remove(model);
    model = undefined;
  }
  setFrame();
  lightingEnvironment.specular.enabled = wantsEnvironment();
  lightingController.update();
  $("error").textContent = "";
  try {
    const assetName = selectedAsset();
    const selectedMetadata = await (
      await fetch("../fixtures/" + assetName + ".json")
    ).json();
    if (own !== generation) return;
    metadata = selectedMetadata;
    const asset = new URL("../fixtures/" + assetName + ".gltf", import.meta.url)
      .href;
    const fresh = await C.Model.fromGltfAsync({
      url: asset,
      modelMatrix: frame,
      upAxis: C.Axis.Z,
      forwardAxis: C.Axis.X,
      shadows: C.ShadowMode.ENABLED,
      incrementallyLoadTextures: false,
      environmentMapOptions: {
        enabled: wantsEnvironment(),
        generateSphericalHarmonics: false,
        mipmapLevels: 7,
        gamma: 1,
        brightness: 1,
        atmosphereScatteringIntensity: lightingEnvironment.sun.intensity,
      },
    });
    if (own !== generation) {
      fresh.destroy();
      return;
    }
    model = fresh;
    fresh.environmentMapManager.enabled = wantsEnvironment();
    if (wantsEnvironment())
      fresh.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(
        0,
        1,
      );
    scene.primitives.add(fresh);
    fresh.readyEvent.addEventListener(() => {
      if (own !== generation) return;
      const world = scene.lumen.loadWorld({
        backend: "gpu",
        url: asset,
        workerUrl: new URL("../lumen/gpu-worker.js", import.meta.url).href,
        modelMatrix: frame,
        axisMatrix: C.Matrix4.toArray(fresh._sceneGraph.axisCorrectionMatrix),
        spacing: currentQuality === "fine" ? 1.5 : metadata.spacing,
        rays: metadata.rays,
        targetGpuMilliseconds: 3,
        maxBatch: 128,
        captureFinalGather: scene.lumen.finalGather.mode !== "ddgi",
        ...options(),
      });
      scene.lumen.finalGather.model = fresh;
      world.gain = 1;
      world.completed.catch(fail);
    });
    scene.requestRender();
  } catch (e) {
    fail(e);
  }
}
async function terrainHeight(provider) {
  const points = [
    [0, 0],
    ...(metadata?.foundationCorners ?? [
      [-12, -9],
      [-12, 9],
      [12, -9],
      [12, 9],
    ]),
  ].map(([x, y]) =>
    C.Cartographic.fromCartesian(
      C.Matrix4.multiplyByPoint(
        frame,
        new C.Cartesian3(x, y, 0),
        new C.Cartesian3(),
      ),
    ),
  );
  const sampled = await C.sampleTerrainMostDetailed(provider, points);
  if (!sampled.every((p) => Number.isFinite(p.height)))
    throw Error("invalid heights");
  const relief =
    Math.max(...sampled.map((p) => p.height)) -
    Math.min(...sampled.map((p) => p.height));
  if (relief > 1.4 + 1e-9) {
    const error = new Error("terrain relief exceeds foundation clearance");
    error.placementCode = "TERRAIN_RELIEF_EXCEEDS_FOUNDATION";
    throw error;
  }
  // Foundation local z is [-1.5,0]. Bottom meets the lowest sampled point,
  // while the top clears the highest by at least 0.1m after the relief check.
  return Math.min(...sampled.map((p) => p.height)) + 1.5;
}
async function place() {
  const own = networkGeneration,
    worldGeneration = generation,
    provider = scene.terrainProvider;
  try {
    const height = await terrainHeight(provider);
    if (
      own !== networkGeneration ||
      worldGeneration !== generation ||
      provider !== scene.terrainProvider
    )
      return;
    anchor.height = height;
    await reload();
    $("network").textContent += "；中心/四角采样完成，同一稳定锚点已重建";
  } catch {
    if (
      own !== networkGeneration ||
      worldGeneration !== generation ||
      provider !== scene.terrainProvider
    )
      return;
    $("network").textContent += "；采样不可用，保留原稳定椭球高";
  }
}
$("fgMode").value = scene.lumen.finalGather.mode;
$("fgQuality").value = scene.lumen.finalGather.quality;
$("fgSampling").value = scene.lumen.finalGather.sampling;
for (const id of ["fgMode", "fgQuality", "fgSampling"])
  $(id).onchange = () => {
    scene.lumen.finalGather
      .configure({
        mode: $("fgMode").value,
        quality: $("fgQuality").value,
        sampling: $("fgSampling").value,
        model,
      })
      .catch(fail);
  };
$("enabled").onchange = () => {
  scene.lumen.enabled = $("enabled").checked;
  scene.requestRender();
};
$("mode").onchange = () => {
  scene.lumen.debugMode = Number($("mode").value);
  scene.requestRender();
};
$("exposure").onchange = () => {
  scene.postProcessStages.exposure = Number($("exposure").value);
  scene.requestRender();
};
for (const id of ["sun", "sunHeight", "publication", "neutral"])
  $(id).onchange = relight;
$("cameras").onclick = (e) => {
  if (e.target.dataset.camera) camera(e.target.dataset.camera, true);
};
$("cancel").onclick = () => scene.camera.cancelFlight();
$("reload").onclick = reload;
$("online").onclick = enhance;
$("local").onclick = () => localLayers().catch(fail);
$("place").onclick = place;
scene.postRender.addEventListener(() => {
  const w = scene.lumen.world;
  if (pendingLighting && w?.packet && !w.isDestroyed()) relight();
  if (model?.environmentMapManager._specularMapReady)
    lightingEnvironment.versions.specularPublished =
      lightingEnvironment.versions.specularRequested;
  const current = !!w && w.requestedRevision === w.settledRevision;
  const grid = w?.packet?.grid;
  $("transition").disabled = typeof w?.setDisplayTransition !== "function";
  $("saveView").disabled = !w?.ready || w.isDestroyed();
  $("status").textContent =
    `${model?.ready ? "建筑已显示" : "建筑加载中"} · ${w?.status ?? "GI 准备中"}\n${current ? "光照已完成" : "光照更新中（可能显示旧 GI）"}\n请求 ${w?.requestedRevision ?? 0} / 活动 ${w?.activeRevision ?? 0}\n发布 ${w?.publishedRevision ?? 0} / 完成 ${w?.settledRevision ?? 0}\n轮次 ${w?.publishedBounce ?? 0} / 阶段 ${w?.progress?.phase ?? w?.status ?? "loading"}\n探针 ${grid?.total ?? "…"} / 4096 · spacing ${grid?.spacing ?? "…"}m\n${grid?.rays ?? "…"} rays · ${w?.options.bounces ?? "…"} bounces · ${w?.options.targetGpuMilliseconds ?? "…"}ms预算\n自有纹理 ${((w?.memoryBytes ?? 0) / 1048576).toFixed(2)} MiB\nGPU query ${w?._timer ? "available" : "检查 metrics / 不可用"}\n${scene.drawingBufferWidth}×${scene.drawingBufferHeight} · gain 1\n锚点 ${anchor.longitude}, ${anchor.latitude}, ${anchor.height.toFixed(2)}m\n显示 ${(w?.displaySettled ?? true) ? "已稳定" : "过渡中"}\n发布时间为 CPU 提交，不等于 GPU 完成`;
  const fg = scene.lumen.finalGather,
    m = fg.metrics;
  $("fgMode").value = fg.mode;
  $("fgQuality").value = fg.quality;
  $("fgSampling").value = fg.sampling;
  if (gallery)
    $("galleryCompare").value =
      scene.lumen.debugMode === 11
        ? "without"
        : fg.mode === "raw"
          ? "raw"
          : fg.mode === "fg"
            ? "reconstructed"
            : "ddgi";
  if (gallery)
    $("gallerySummary").textContent =
      `${w?.status === "ready" ? "光照已完成" : "正在更新光照"} · ${fg.ready ? "FG：" + fg.quality + "/" + fg.sampling : "DDGI · " + m.status}\n${fg.mode === "ddgi" ? "" : `来源采样 ${m.accumulationPasses ?? 0} · 静止 ${Math.min(m.stablePasses ?? 0, 32)}/32 · `}${scene.drawingBufferWidth}×${scene.drawingBufferHeight}\n发光壁 ${galleryEmitter ? "开启" : "关闭"} · 曝光 ${scene.postProcessStages.exposure}`;
  $("status").textContent +=
    `\n请求 ${fg.mode}/${fg.quality} · 实际 ${fg.ready ? "FG（像素回退见诊断）" : "DDGI"}/${m.effectiveQuality ?? "—"} · ${m.status}\n输入 rev ${m.revision ?? "—"} / E_${(m.round ?? 1) - 1} → FG_${m.round ?? "—"}\n主视图 ${scene.drawingBufferWidth}×${scene.drawingBufferHeight} · 接收 ${m.plan?.rw ?? "—"}×${m.plan?.rh ?? "—"} / ${m.samples ?? m.plan?.samples ?? "—"} rays · traversal ${fg.traversalBudget}\nFG ${(m.memoryBytes / 1048576).toFixed(2)} MiB / 总新增 ${((m.totalAdditionalBytes ?? 0) / 1048576).toFixed(2)} MiB\n上限 ${fg.maxMemoryBytes / 1048576} MiB / ${fg.maxRayInvocations} rays\n回退码 ${fg.fallbackReason} · ${m.plan?.reason ?? "—"} · ${fg.execution}\n${fg.sampling} · 来源采样 ${m.accumulationPasses ?? 0} · 静止 ${Math.min(m.stablePasses ?? 0, 32)}/32（逐像素有效长度另测） · 原求解不读 FG`;
});
// Reproducible diagnostics deliberately omit ion credentials and URLs.
async function saveView() {
  const cam = scene.camera,
    w = scene.lumen.world;
  if (!w?.ready || w.isDestroyed())
    throw Error("wait for the GI world before saving");
  const assetName = selectedAsset();
  // Capture every mutable scene value before the first asynchronous hash operation.
  const saved = {
    scene: gallery ? "gallery" : "pavilion",
    galleryEmitter,
    assetName,
    preset: currentPreset,
    qualityPreset: currentQuality,
    diffuseResponse: scene.lumen.diffuseResponse,
    iblPolicy: scene.lumen.iblPolicy,
    finalGather: {
      mode: scene.lumen.finalGather.mode,
      quality: scene.lumen.finalGather.quality,
      sampling: scene.lumen.finalGather.sampling,
      seed: scene.lumen.finalGather.seed,
      execution: scene.lumen.finalGather.execution,
      rayOrder: scene.lumen.finalGather.rayOrder,
      reconstruction: scene.lumen.finalGather.reconstructionEnabled,
      lazyFallback: scene.lumen.finalGather.lazyFallback,
      plan: scene.lumen.finalGather.metrics.plan,
    },
    displayTransitionMilliseconds: w.displayTransitionMilliseconds,
    publicationMode: $("publication").value,
    neutralMaterials: $("neutral").checked ? [1, 2] : [],
    enabled: scene.lumen.enabled,
    debugMode: scene.lumen.debugMode,
    camera: {
      transform: C.Matrix4.toArray(cam.transform),
      position: [cam.position.x, cam.position.y, cam.position.z],
      direction: [cam.direction.x, cam.direction.y, cam.direction.z],
      up: [cam.up.x, cam.up.y, cam.up.z],
      right: [cam.right.x, cam.right.y, cam.right.z],
      fov: cam.frustum.fov,
      near: cam.frustum.near,
      far: cam.frustum.far,
    },
    anchor: { ...anchor },
    lighting: structuredClone(lighting),
    exposure: scene.postProcessStages.exposure,
    toneMapper: scene.postProcessStages.tonemapper,
    automaticExposure: false,
    resolution: [scene.drawingBufferWidth, scene.drawingBufferHeight],
    msaaSamples: scene.msaaSamples,
    fxaaEnabled: scene.postProcessStages.fxaa.enabled,
    shadows: {
      enabled: scene.shadowMap.enabled,
      size: scene.shadowMap.size,
      maximumDistance: scene.shadowMap.maximumDistance,
      normalOffset: scene.shadowMap.normalOffset,
      softShadows: scene.shadowMap.softShadows,
    },
    quality: {
      spacing: w.options.spacing,
      rays: w.options.rays,
      bounces: w.options.bounces,
      budget: w.options.targetGpuMilliseconds,
    },
    assets: {},
    worldRevision: {
      requested: w.requestedRevision,
      published: w.publishedRevision,
      settled: w.settledRevision,
    },
  };
  for (const ext of ["gltf", "bin", "json"]) {
    const data = await (
      await fetch("../fixtures/" + assetName + "." + ext)
    ).arrayBuffer();
    saved.assets[ext] = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  }
  return saved;
}
async function restoreView(saved) {
  const reloadNeeded =
    (gallery &&
      saved.galleryEmitter !== undefined &&
      saved.galleryEmitter !== galleryEmitter) ||
    (saved.preset && saved.preset !== currentPreset) ||
    (saved.qualityPreset && saved.qualityPreset !== currentQuality) ||
    Object.keys(saved.anchor).some((k) => saved.anchor[k] !== anchor[k]);
  const previous = scene.lumen.world;
  galleryEmitter = saved.galleryEmitter ?? galleryEmitter;
  if (gallery) $("emitter").checked = galleryEmitter;
  currentPreset = saved.preset ?? currentPreset;
  currentQuality = saved.qualityPreset ?? currentQuality;
  Object.assign(anchor, saved.anchor);
  $("preset").value = currentPreset;
  $("quality").value = currentQuality;
  $("publication").value = saved.publicationMode ?? $("publication").value;
  $("neutral").checked = (saved.neutralMaterials ?? []).length > 0;
  $("transition").checked = (saved.displayTransitionMilliseconds ?? 0) > 0;
  const loading = reloadNeeded ? reload() : undefined;
  const own = generation,
    started = performance.now();
  await loading;
  if (own !== generation)
    throw Error("saved view superseded by a newer reload");
  while (
    !scene.lumen.world?.ready ||
    scene.lumen.world.isDestroyed() ||
    (reloadNeeded && scene.lumen.world === previous)
  ) {
    if (own !== generation)
      throw Error("saved view superseded by a newer reload");
    if (performance.now() - started > 180000)
      throw Error("saved view world timeout");
    scene.requestRender();
    await new Promise(requestAnimationFrame);
  }
  const w = scene.lumen.world;
  await w.completed;
  if (own !== generation)
    throw Error("saved view superseded by a newer reload");
  if (saved.diffuseResponse)
    scene.lumen.diffuseResponse = saved.diffuseResponse;
  if (saved.iblPolicy) scene.lumen.iblPolicy = saved.iblPolicy;
  w.setDisplayTransition(saved.displayTransitionMilliseconds ?? 0);
  if (saved.enabled !== undefined) scene.lumen.enabled = saved.enabled;
  if (saved.debugMode !== undefined) scene.lumen.debugMode = saved.debugMode;
  if (saved.msaaSamples) scene.msaaSamples = saved.msaaSamples;
  if (saved.fxaaEnabled !== undefined)
    scene.postProcessStages.fxaa.enabled = saved.fxaaEnabled;
  scene.camera.cancelFlight();
  scene.camera.lookAtTransform(C.Matrix4.fromArray(saved.camera.transform));
  for (const key of ["position", "direction", "up", "right"])
    C.Cartesian3.fromArray(saved.camera[key], 0, scene.camera[key]);
  for (const key of ["fov", "near", "far"])
    scene.camera.frustum[key] = saved.camera[key];
  scene.postProcessStages.exposure = saved.exposure;
  scene.postProcessStages.tonemapper = saved.toneMapper;
  Object.assign(scene.shadowMap, saved.shadows);
  Object.assign(lighting, saved.lighting);
  const d = C.Cartesian3.negate(
    C.Cartesian3.normalize(
      C.Cartesian3.fromArray(lighting.sunDirection),
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  scene.light = new C.DirectionalLight({
    direction: C.Matrix3.multiplyByVector(rotation, d, new C.Cartesian3()),
    color: new C.Color(...lighting.sunRadiance),
    intensity: 1,
  });
  const environmentChanged = lightingEnvironment.update(lighting);
  if (environmentChanged && model?.environmentMapManager.enabled) {
    model.environmentMapManager.atmosphereScatteringIntensity =
      lightingEnvironment.sun.intensity;
    model.environmentMapManager.reset();
  }
  $("sun").value = String(
    C.Math.toDegrees(
      Math.atan2(lighting.sunDirection[1], lighting.sunDirection[0]),
    ),
  );
  $("sunHeight").value = String(
    C.Math.toDegrees(
      Math.atan2(
        lighting.sunDirection[2],
        Math.hypot(...lighting.sunDirection.slice(0, 2)),
      ),
    ),
  );
  $("exposure").value = String(saved.exposure);
  $("tonemapper").value = saved.toneMapper;
  $("response").value = scene.lumen.diffuseResponse;
  $("enabled").checked = scene.lumen.enabled;
  $("mode").value = String(scene.lumen.debugMode);
  $("aa").value =
    scene.msaaSamples > 1
      ? "msaa4"
      : scene.postProcessStages.fxaa.enabled
        ? "fxaa"
        : "off";
  $("shadow").value = scene.shadowMap.normalOffset ? "original" : "contact";
  const target = {
    ...options(),
    ...lighting,
    displayTransitionMilliseconds: w.displayTransitionMilliseconds,
  };
  if (
    [
      "sunDirection",
      "sunRadiance",
      "skyRadiance",
      "bounces",
      "environmentMode",
      "publicationMode",
      "neutralMaterials",
    ].some((k) => JSON.stringify(w.options[k]) !== JSON.stringify(target[k]))
  )
    await w.solve(target);
  if (saved.finalGather) {
    await scene.lumen.finalGather.configure({ ...saved.finalGather, model });
    $("fgMode").value = scene.lumen.finalGather.mode;
    $("fgQuality").value = scene.lumen.finalGather.quality;
    $("fgSampling").value = scene.lumen.finalGather.sampling;
  }
  scene.requestRender();
}
let probePoints;
function showProbePositions(show = true) {
  if (!params.has("diagnostic"))
    throw Error("probe positions require diagnostic=1");
  if (probePoints) {
    scene.primitives.remove(probePoints);
    probePoints = undefined;
  }
  if (!show) {
    scene.requestRender();
    return;
  }
  const packet = scene.lumen.world.snapshot();
  probePoints = scene.primitives.add(new C.PointPrimitiveCollection());
  // Strict interior tests for the original closed foundation, problem box and columns.
  const solids = [
    [
      [-12, -9, -1.5],
      [12, 9, 0],
    ],
    [
      [-10.6, -3, 0.15],
      [-9, -1, 1.1],
    ],
  ];
  for (const x of [-7, 7])
    for (const y of [-7, -2, 3])
      solids.push([
        [x - 0.18, y - 0.18, 0.15],
        [x + 0.18, y + 0.18, 5.2],
      ]);
  const counts = { active: 0, invalid: 0, inside: 0, activeInside: 0 };
  for (let id = 0; id < packet.grid.total; id++) {
    const p = Array.from(packet.positions.slice(id * 4, id * 4 + 3)),
      active = packet.positions[id * 4 + 3] >= 0.5;
    const inside = solids.some(([a, b]) =>
      p.every((v, i) => v > a[i] && v < b[i]),
    );
    counts[active ? "active" : "invalid"]++;
    if (inside) {
      counts.inside++;
      if (active) counts.activeInside++;
    }
    probePoints.add({
      position: C.Matrix4.multiplyByPoint(
        frame,
        C.Cartesian3.fromArray(p),
        new C.Cartesian3(),
      ),
      color: inside ? C.Color.ORANGE : active ? C.Color.LIME : C.Color.RED,
      pixelSize: inside ? 7 : 4,
      outlineColor: C.Color.BLACK,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
  scene.requestRender();
  return counts;
}
window.earthLab = {
  widget,
  scene,
  errors,
  anchor,
  lighting,
  lightingController,
  lightingEnvironment,
  get preset() {
    return currentPreset;
  },
  get quality() {
    return currentQuality;
  },
  saveView,
  restoreView,
  showProbePositions,
  camera,
  reload,
  enhance,
  localLayers,
  place,
  get frame() {
    return frame;
  },
  get model() {
    return model;
  },
  get world() {
    return scene.lumen.world;
  },
  get metadata() {
    return metadata;
  },
};
function applyDisplayPreset() {
  const presentation = currentPreset === "presentation" || gallery;
  scene.lumen.diffuseResponse = presentation ? "cesium" : "lambert";
  scene.msaaSamples = presentation ? 4 : 1;
  scene.postProcessStages.fxaa.enabled = false;
  scene.shadowMap.normalOffset = gallery || !presentation;
  scene.shadowMap.softShadows = presentation;
  scene.shadowMap.maximumDistance = presentation ? 75 : 150;
  $("preset").value = currentPreset;
  $("quality").value = currentQuality;
  $("response").value = scene.lumen.diffuseResponse;
  $("aa").value = presentation ? "msaa4" : "off";
  $("shadow").value = scene.shadowMap.normalOffset ? "original" : "contact";
}
$("preset").onchange = () => {
  currentPreset = $("preset").value;
  applyDisplayPreset();
  reload();
};
$("quality").onchange = () => {
  currentQuality = $("quality").value;
  reload();
};
$("transition").onchange = () => {
  scene.lumen.world?.setDisplayTransition?.($("transition").checked ? 150 : 0);
  scene.requestRender();
};
$("response").onchange = () => {
  scene.lumen.diffuseResponse = $("response").value;
  scene.requestRender();
};
$("aa").onchange = () => {
  scene.msaaSamples = $("aa").value === "msaa4" ? 4 : 1;
  scene.postProcessStages.fxaa.enabled = $("aa").value === "fxaa";
  scene.requestRender();
};
$("shadow").onchange = () => {
  const contact = $("shadow").value === "contact";
  scene.shadowMap.normalOffset = !contact;
  scene.shadowMap.softShadows = contact;
  scene.shadowMap.maximumDistance = contact ? 75 : 150;
  scene.requestRender();
};
$("tonemapper").onchange = () => {
  scene.postProcessStages.tonemapper = $("tonemapper").value;
  scene.requestRender();
};
let savedView;
$("saveView").onclick = async () => {
  try {
    savedView = await saveView();
  } catch (error) {
    fail(error);
    return;
  }
  $("restoreView").disabled = false;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(savedView, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "earth-gi-view.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("restoreView").onclick = () => restoreView(savedView).catch(fail);
applyDisplayPreset();
lightingController.update();
camera("earth");
localLayers().catch(fail);
fetch("../fixtures/" + selectedAsset() + ".json")
  .then((r) => r.json())
  .then((m) => {
    metadata = m;
    Object.assign(anchor, metadata.anchor);
    if (gallery || params.has("barrier")) {
      const preset =
        metadata.lightingPresets[
          params.get("light") ?? (gallery ? "day" : "night")
        ] ?? metadata.lightingPresets.day;
      Object.assign(lighting, preset);
      $("sun").value = String(
        C.Math.toDegrees(
          Math.atan2(lighting.sunDirection[1], lighting.sunDirection[0]),
        ),
      );
      $("sunHeight").value = String(
        C.Math.toDegrees(
          Math.atan2(
            lighting.sunDirection[2],
            Math.hypot(...lighting.sunDirection.slice(0, 2)),
          ),
        ),
      );
    }
    const loading = reload();
    if (gallery || params.has("barrier")) camera("overview");
    return loading;
  })
  .catch(fail);

if (gallery) {
  $("emitter").checked = galleryEmitter;
  $("emitter").onchange = () => {
    galleryEmitter = $("emitter").checked;
    reload();
  };
  $("galleryLight").value = params.get("light") ?? "day";
  $("galleryLight").onchange = () => {
    const preset = metadata?.lightingPresets?.[$("galleryLight").value];
    if (!preset) return;
    Object.assign(lighting, preset);
    $("sun").value = String(
      C.Math.toDegrees(
        Math.atan2(lighting.sunDirection[1], lighting.sunDirection[0]),
      ),
    );
    $("sunHeight").value = String(
      C.Math.toDegrees(
        Math.atan2(
          lighting.sunDirection[2],
          Math.hypot(...lighting.sunDirection.slice(0, 2)),
        ),
      ),
    );
    relight();
  };
  $("galleryCompare").onchange = () => {
    const value = $("galleryCompare").value,
      fg = scene.lumen.finalGather;
    scene.lumen.debugMode = value === "without" ? 11 : 0;
    $("mode").value = String(scene.lumen.debugMode);
    const mode =
      value === "raw" ? "raw" : value === "reconstructed" ? "fg" : "ddgi";
    fg.configure({
      mode,
      quality: $("fgQuality").value,
      sampling: value === "raw" ? "scrambled-single-frame" : "reconstructed",
      model,
    }).catch(fail);
    $("fgMode").value = mode;
    $("fgQuality").value = fg.quality;
    $("fgSampling").value = fg.sampling;
    scene.requestRender();
  };
}
