const C = Cesium,
  $ = (id) => document.getElementById(id);
// No Viewer default imagery/geocoder: only explicitly supplied local resources.
C.Ion.defaultAccessToken = "";
const widget = new C.CesiumWidget("view", {
  baseLayer: false,
  terrainProvider: new C.EllipsoidTerrainProvider(),
  msaaSamples: 1,
  contextOptions: {
    webgl: {
      preserveDrawingBuffer: new URLSearchParams(location.search).has(
        "diagnostic",
      ),
    },
  },
});
const scene = widget.scene;
scene.highDynamicRange = true;
scene.gBuffer.enabled = false;
scene.lumen.enabled = true;
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
      intensity: 2,
    });
  },
};
function options() {
  return {
    ...lighting,
    publicationMode: $("publication").value,
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
  const bookmark = metadata?.cameras[name];
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
        $("network").textContent = "局部场景已重载；取消待应用地形并恢复本地配置";
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
  const old = scene.lumen.world;
  if (old) old.destroy();
  if (model) {
    scene.primitives.remove(model);
    model = undefined;
  }
  setFrame();
  lightingController.update();
  $("error").textContent = "";
  try {
    const asset = new URL("../fixtures/earth-pavilion.gltf", import.meta.url)
      .href;
    const fresh = await C.Model.fromGltfAsync({
      url: asset,
      modelMatrix: frame,
      upAxis: C.Axis.Z,
      forwardAxis: C.Axis.X,
      shadows: C.ShadowMode.ENABLED,
      incrementallyLoadTextures: false,
    });
    if (own !== generation) {
      fresh.destroy();
      return;
    }
    model = fresh;
    fresh.environmentMapManager.enabled = false;
    scene.primitives.add(fresh);
    fresh.readyEvent.addEventListener(() => {
      if (own !== generation) return;
      const world = scene.lumen.loadWorld({
        backend: "gpu",
        url: asset,
        workerUrl: new URL("../lumen/gpu-worker.js", import.meta.url).href,
        modelMatrix: frame,
        axisMatrix: C.Matrix4.toArray(fresh._sceneGraph.axisCorrectionMatrix),
        spacing: metadata.spacing,
        rays: metadata.rays,
        targetGpuMilliseconds: 3,
        maxBatch: 128,
        ...options(),
      });
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
    [-12, -9],
    [-12, 9],
    [12, -9],
    [12, 9],
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
  const current = !!w && w.requestedRevision === w.settledRevision;
  const grid = w?.packet?.grid;
  $("status").textContent =
    `${model?.ready ? "建筑已显示" : "建筑加载中"} · ${w?.status ?? "GI 准备中"}\n${current ? "光照已完成" : "光照更新中（可能显示旧 GI）"}\n请求 ${w?.requestedRevision ?? 0} / 活动 ${w?.activeRevision ?? 0}\n发布 ${w?.publishedRevision ?? 0} / 完成 ${w?.settledRevision ?? 0}\n轮次 ${w?.publishedBounce ?? 0} / 阶段 ${w?.progress?.phase ?? w?.status ?? "loading"}\n探针 ${grid?.total ?? "…"} / 4096 · spacing 2m\n128 rays · 3 bounces · 3ms预算\n自有纹理 ${((w?.memoryBytes ?? 0) / 1048576).toFixed(2)} MiB\nGPU query ${w?._timer ? "available" : "检查 metrics / 不可用"}\n${scene.drawingBufferWidth}×${scene.drawingBufferHeight} · gain 1\n锚点 ${anchor.longitude}, ${anchor.latitude}, ${anchor.height.toFixed(2)}m\n发布时间为 CPU 提交，不等于 GPU 完成`;
});
window.earthLab = {
  widget,
  scene,
  errors,
  anchor,
  lighting,
  lightingController,
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
lightingController.update();
camera("earth");
localLayers().catch(fail);
fetch("../fixtures/earth-pavilion.json")
  .then((r) => r.json())
  .then((m) => {
    metadata = m;
    Object.assign(anchor, metadata.anchor);
    return reload();
  })
  .catch(fail);
