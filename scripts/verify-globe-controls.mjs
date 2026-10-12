import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile("demo/globe.js", "utf8");
const functions =
  source.slice(
    source.indexOf("async function localLayers()"),
    source.indexOf("async function reload()"),
  ) +
  source.slice(
    source.indexOf("async function terrainHeight("),
    source.indexOf("async function place()"),
  );
const provider = () => {
  const callbacks = [];
  return {
    errorEvent: { addEventListener: (f) => callbacks.push(f) },
    raise: () => callbacks.forEach((f) => f()),
  };
};
const elements = {
  token: { value: "example-sensitive" },
  asset: { value: "7" },
  terrain: { checked: true },
  network: { textContent: "" },
};
let reloads = 0,
  localRequests = 0,
  heights = [10, 10.2, 10.5, 11, 11.4];
let imagery = provider(),
  terrain = provider();
const layers = [];
const context = vm.createContext({
  console,
  Promise,
  Number,
  Math,
  Error,
  String,
  encodeURIComponent,
  $: (id) => elements[id],
  C: {
    EllipsoidTerrainProvider: class Ellipsoid {},
    TileMapServiceImageryProvider: {
      fromUrl: async () => {
        localRequests++;
        return provider();
      },
    },
    buildModuleUrl: (x) => x,
    IonImageryProvider: { fromAssetId: async () => imagery },
    CesiumTerrainProvider: { fromIonAssetId: async () => terrain },
    sampleTerrainMostDetailed: async () =>
      heights.map((height) => ({ height })),
    Cartographic: { fromCartesian: (x) => x },
    Matrix4: { multiplyByPoint: () => ({}) },
    Cartesian3: class {},
  },
  scene: {
    terrainProvider: null,
    imageryLayers: {
      removeAll: () => layers.splice(0),
      addImageryProvider: (p) => {
        const l = { provider: p };
        layers.push(l);
        return l;
      },
      contains: (l) => layers.includes(l),
    },
  },
  anchor: { height: 1.5 },
  metadata: { anchor: { height: 1.5 } },
  frame: {},
  reload: async () => {
    reloads++;
  },
  fail: (e) => {
    throw e;
  },
  networkGeneration: 0,
  generation: 0,
});
vm.runInContext(
  functions +
    source.slice(
      source.indexOf("function safeError("),
      source.indexOf("const fail ="),
    ),
  context,
);
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
await context.enhance();
assert.equal(context.anchor.height, 11.5);
assert.equal(context.scene.terrainProvider, terrain);
assert.ok(context.anchor.height - 1.5 <= Math.min(...heights));
assert.ok(context.anchor.height >= Math.max(...heights) + 0.099);
const oldImage = imagery,
  oldTerrain = terrain;
imagery = provider();
terrain = provider();
await context.enhance();
const requests = localRequests;
oldImage.raise();
oldTerrain.raise();
await tick();
assert.equal(
  localRequests,
  requests,
  "old imagery/terrain events cannot reset current configuration",
);
layers.splice(0);
imagery.raise();
await tick();
assert.equal(
  localRequests,
  requests,
  "detached current-generation imagery is ignored",
);
terrain.raise();
terrain.raise();
await tick();
assert.equal(
  localRequests,
  requests + 1,
  "one fallback per active provider generation",
);
assert.ok(
  context.scene.terrainProvider instanceof context.C.EllipsoidTerrainProvider,
);
imagery = provider();
terrain = provider();
elements.terrain.checked = true;
await context.enhance();
elements.terrain.checked = false;
await context.enhance();
assert.equal(context.anchor.height, 1.5);
assert.ok(
  context.scene.terrainProvider instanceof context.C.EllipsoidTerrainProvider,
  "terrain=false explicitly restores ellipsoid",
);
const before = reloads;
let resolveLocal;
context.C.TileMapServiceImageryProvider.fromUrl = () =>
  new Promise((r) => (resolveLocal = r));
const local = context.localLayers();
context.networkGeneration++;
elements.network.textContent = "newer configuration";
resolveLocal(provider());
assert.equal(await local, false);
assert.equal(elements.network.textContent, "newer configuration");
assert.equal(reloads, before);
context.C.TileMapServiceImageryProvider.fromUrl = async () => provider();
context.anchor.height = 20;
let resolveReload;
context.reload = () =>
  new Promise((resolve) => {
    resolveReload = resolve;
  });
const reloadPending = context.localLayers();
await tick();
context.networkGeneration++;
elements.network.textContent = "newer configuration after reload";
resolveReload();
assert.equal(await reloadPending, false);
assert.equal(elements.network.textContent, "newer configuration after reload");
heights = [10, 10, 10, 10, 11.40001];
await assert.rejects(
  () => context.terrainHeight(terrain),
  (e) => e.placementCode === "TERRAIN_RELIEF_EXCEEDS_FOUNDATION",
);
heights = [10, 10, 10, 10, NaN];
await assert.rejects(() => context.terrainHeight(terrain));
const sanitized = context.safeError(
  "https://example.test/a?access_token=other-token&x=1 example-sensitive",
);
assert.ok(
  !sanitized.includes("other-token") &&
    !sanitized.includes("example-sensitive"),
);
const html = await readFile("demo/globe.html", "utf8");
assert.ok(
  html.lastIndexOf('href="globe.css"') > html.indexOf("</style>"),
  "responsive rules follow base styles",
);
console.log(
  "PASS provider identity/generation guards, single fallback, terrain disable, stale status, foundation range, redaction and CSS order",
);
