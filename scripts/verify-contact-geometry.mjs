import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { createBallPool, ballPoolGltf } from "../lumen/ballpool-scene.js";
import { cross, normalize } from "../lumen/math.js";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/geometry-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage(),
  report = {
    version: sourceVersion(["scripts/verify-contact-geometry.mjs"]),
    rows: [],
    errors: [],
  };
page.on("pageerror", (e) => report.errors.push(String(e)));
function plates(normal, gap, translation, sameOwner) {
  const t = normalize(
      cross(normal, Math.abs(normal[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]),
    ),
    b = cross(normal, t),
    points = [];
  for (const z of [0, gap])
    for (const corner of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [1, 1],
      [-1, 1],
    ])
      points.push(
        ...normal.map(
          (n, k) =>
            translation[k] + n * z + t[k] * corner[0] + b[k] * corner[1],
        ),
      );
  const positions = new Float32Array(points),
    bytes = Buffer.from(positions.buffer),
    uri = "data:application/octet-stream;base64," + bytes.toString("base64");
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ uri, byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteLength: bytes.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: "VEC3" },
      {
        bufferView: 0,
        byteOffset: 72,
        componentType: 5126,
        count: 6,
        type: "VEC3",
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.5, 0.5, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    meshes: sameOwner
      ? [
          {
            primitives: [
              { attributes: { POSITION: 0 }, material: 0 },
              { attributes: { POSITION: 1 }, material: 0 },
            ],
          },
        ]
      : [
          { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
          { primitives: [{ attributes: { POSITION: 1 }, material: 0 }] },
        ],
    nodes: [
      {
        mesh: 0,
        name: sameOwner
          ? "same-owner-different-faces"
          : "cross-owner-neighbour",
      },
    ],
    scenes: [{ nodes: sameOwner ? [0] : [0, 1] }],
    scene: 0,
  };
  if (!sameOwner) gltf.nodes.push({ mesh: 1, name: "separate-owner-blocker" });
  return {
    gltf,
    normal,
    gap,
    ray: {
      origin: translation.map(
        (p, k) => p + normal[k] * gap * 0.5 + t[k] * 0.17 + b[k] * 0.13,
      ),
      direction: normal.map((n) => -n),
    },
  };
}
const fixtures = [];
for (const gap of [0.001, 0.01, 0.02])
  for (const shifted of [false, true])
    fixtures.push({
      name: "parallel-" + gap + "-" + shifted,
      ...plates([0, 0, 1], gap, shifted ? [10, -7, 3] : [0, 0, 0], true),
    });
fixtures.push({
  name: "slope-same-owner",
  ...plates([0.6, 0, 0.8], 0.001, [3, 2, 1], true),
});
fixtures.push({
  name: "slope-cross-owner",
  ...plates(normalize([1, 2, 3]), 0.005, [-3, 4, 2], false),
});
for (const count of [1, 2])
  fixtures.push({
    name: count === 1 ? "sphere-ground" : "two-spheres",
    gltf: ballPoolGltf(createBallPool({ count })).gltf,
    normal: [0, 0, 1],
    gap: 0.001,
    ray: {
      origin: [count === 1 ? 0 : -0.341, 0, 0.0005],
      direction: [0, 0, -1],
    },
  });
fixtures.push({
  name: "two-spheres-gap-cross-owner",
  gltf: ballPoolGltf(createBallPool({ count: 2 })).gltf,
  normal: [1, 0, 0],
  gap: 0.002,
  ray: { origin: [0, 0, 0.341], direction: [-1, 0, 0] },
});
try {
  await page.goto(
    "http://localhost:8090/demo/ballpool.html?diagnostic=1&count=1",
  );
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  for (const f of fixtures) {
    const value = await page.evaluate(async ({ gltf, normal, ray }) => {
      const blob = new Blob([JSON.stringify(gltf)], {
          type: "model/gltf+json",
        }),
        url = URL.createObjectURL(blob);
      try {
        const w = ballPool.scene.lumen.loadWorld({
          backend: "gpu",
          url,
          workerUrl: new URL("/lumen/gpu-worker.js", location.href).href,
          axisMatrix: Cesium.Matrix4.toArray(Cesium.Matrix4.IDENTITY),
          modelMatrix: ballPool.model.modelMatrix,
          spacing: 2,
          rays: 32,
          bounces: 1,
          maxBatch: 128,
          captureFinalGather: true,
          contactTransport: true,
          sunDirection: normal,
          sunRadiance: [1, 1, 1],
          skyRadiance: [0, 0, 0],
        });
        await w.completed;
        const result = await w.diagnoseTransport([ray]);
        result.lowBudget = await w.trace([{ ...ray, budget: 1 }]);
        return result;
      } finally {
        URL.revokeObjectURL(url);
      }
    }, f);
    assert(Math.abs(value.hit[0][0]) > 1, "actual source face hit");
    assert(
      Math.abs(value.solarHit[0][0]) > 1,
      "analytic blocker above source must be hit",
    );
    assert(
      value.solarOrigin[0][3] < f.gap * 0.5,
      "spawn does not cross analytic gap",
    );
    assert(value.solarHit[0][0] !== -1, "Unknown is not sky");
    if (f.name === "two-spheres-gap-cross-owner") {
      assert(
        value.solarHit[0][0] > 1,
        "spawn stays outside other sphere and retains front entry",
      );
      assert.equal(
        value.lowBudget[0].status,
        "Unknown",
        "budget exhaustion remains Unknown",
      );
    }
    report.rows.push({
      name: f.name,
      analytic: "blocked",
      gap: f.gap,
      ray: f.ray,
      ...value,
      status: "passed",
    });
  }
} catch (e) {
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser.close();
}
report.status = report.errors.length ? "failed" : "passed";
await writeFile(
  out + "/contact-geometry.json",
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
if (report.status !== "passed") process.exitCode = 1;
