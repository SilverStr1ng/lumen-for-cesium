import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { BVH } from "../lumen/bvh.js";
import { sourceVersion } from "./browser-tools.mjs";
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
  sub = (a, b) => a.map((v, i) => v - b[i]),
  cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
// Independent plane intersection + Gram-matrix barycentrics, no BVH/Moller code.
function brute(g, o, d, accept) {
  let best = Infinity,
    result;
  for (let t = 0; t < g.positions.length / 9; t++) {
    const a = Array.from(g.positions.slice(t * 9, t * 9 + 3)),
      b = sub(Array.from(g.positions.slice(t * 9 + 3, t * 9 + 6)), a),
      c = sub(Array.from(g.positions.slice(t * 9 + 6, t * 9 + 9)), a),
      n = cross(b, c),
      den = dot(n, d);
    if (Math.abs(den) < 1e-10) continue;
    const distance = dot(n, sub(a, o)) / den;
    if (distance < 0.0001 || distance >= best) continue;
    const q = sub(
        o.map((v, i) => v + d[i] * distance),
        a,
      ),
      bb = dot(b, b),
      cc = dot(c, c),
      bc = dot(b, c),
      det = bb * cc - bc * bc;
    if (Math.abs(det) < 1e-20) continue;
    const u = (dot(q, b) * cc - dot(q, c) * bc) / det,
      v = (dot(q, c) * bb - dot(q, b) * bc) / det;
    if (u < 0 || v < 0 || u + v > 1 || !accept(t, u, v)) continue;
    best = distance;
    result = { status: "Hit", distance, triangle: t };
  }
  return result ?? { status: "Miss" };
}
let seed = 91235;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const positions = [];
for (let i = 0; i < 512; i++) {
  const x = (random() - 0.5) * 200,
    y = (random() - 0.5) * 200,
    z = (random() - 0.5) * 200;
  positions.push(
    x,
    y,
    z,
    x + random() * 12,
    y + random() * 12,
    z + random() * 12,
    x - random() * 12,
    y + random() * 12,
    z - random() * 12,
  );
}
// Explicit far blocker, reversed winding and overlapping equal-distance geometry.
positions.push(
  -20,
  -20,
  150,
  20,
  -20,
  150,
  0,
  20,
  150,
  -20,
  -20,
  150,
  0,
  20,
  150,
  20,
  -20,
  150,
);
const g = { positions: Float32Array.from(positions) },
  accept = (t, u, v) => t % 7 !== 0 || u + v > 0.5;
const rays = Array.from({ length: 3000 }, () => {
  const d = [random() - 0.5, random() - 0.5, random() - 0.5],
    l = Math.hypot(...d);
  return {
    origin: [
      (random() - 0.5) * 240,
      (random() - 0.5) * 240,
      (random() - 0.5) * 240,
    ],
    direction: d.map((v) => v / l),
  };
});
rays.push(
  { origin: [0, 0, 0], direction: [0, 0, 1] },
  { origin: [0, 0, 151], direction: [1e-13, 0, -1] },
);
const expected = rays.map((r) => brute(g, r.origin, r.direction, accept));
const originalSource = execFileSync(
  "git",
  ["show", "39529256309070aae6e67518b3f17fed4855a9fb:lumen/bvh.js"],
  { encoding: "utf8" },
);
const { BVH: OriginalBVH } = await import(
  "data:text/javascript;base64," +
    Buffer.from(originalSource).toString("base64")
);
const original = new OriginalBVH(g),
  median = new BVH(g);
assert.deepEqual(median.order, original.order);
assert.deepEqual(median.children, original.children);
assert.deepEqual(median.bounds, original.bounds);
const report = {
  startedAt: new Date().toISOString(),
  version: sourceVersion(["lumen/bvh.js", "scripts/verify-visibility.mjs"]),
  schema: 1,
  tolerance: 1e-7,
  tieRule:
    "equal-distance triangles may differ; status and distance must agree",
  rays: rays.length,
  results: [],
};
try {
  for (const strategy of ["median", "sah"])
    for (const bins of strategy === "median" ? [12] : [8, 12, 16, 32]) {
      const start = performance.now(),
        bvh = new BVH(g, { strategy, bins }),
        counters = {};
      for (let i = 0; i < rays.length; i++) {
        const r = rays[i],
          h = bvh.trace(r.origin, r.direction, {
            maxDistance: Infinity,
            accept,
            counters,
          }),
          any = bvh.trace(r.origin, r.direction, {
            maxDistance: Infinity,
            accept,
            anyHit: true,
          });
        assert.equal(h.status, expected[i].status, `${strategy} ray ${i}`);
        assert.equal(any.status, h.status);
        if (h.status === "Hit")
          assert.ok(Math.abs(h.distance - expected[i].distance) < 1e-7);
      }
      assert.equal(
        bvh.trace([0, 0, 0], [0, 0, 1], { budget: 0 }).status,
        "Unknown",
      );
      assert.equal(
        bvh.trace([0, 0, 0], [0, 0, 1], { maxDistance: 200 }).status,
        "Hit",
      );
      const repeated = new BVH(g, { strategy, bins });
      assert.deepEqual(repeated.order, bvh.order);
      report.results.push({
        strategy,
        bins,
        stats: bvh.stats,
        counters,
        milliseconds: performance.now() - start,
      });
    }
  const degenerate = new BVH(
    { positions: new Float32Array(9 * 100) },
    { strategy: "sah" },
  );
  assert.ok(degenerate.stats.maxDepth < 10);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await mkdir("reports/globe-visibility-v3", { recursive: true });
  await writeFile(
    `reports/globe-visibility-v3/visibility-cpu-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    "reports/globe-visibility-v3/visibility-cpu.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report.results));
