import assert from "node:assert/strict";
import { BVH } from "../lumen/bvh.js";
import { DDGI, ProbeField } from "../lumen/ddgi.js";
import { sub, cross, dot, normalize } from "../lumen/math.js";

let seed = 734791;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const positions = Float32Array.from(
  Array.from({ length: 900 }, () => random() * 4 - 2),
);
const bvh = new BVH({ positions });
function reference(origin, direction) {
  let distance = 100,
    triangle = -1;
  for (let t = 0; t < positions.length / 9; t++) {
    const a = Array.from(positions.subarray(t * 9, t * 9 + 3)),
      b = Array.from(positions.subarray(t * 9 + 3, t * 9 + 6)),
      c = Array.from(positions.subarray(t * 9 + 6, t * 9 + 9)),
      ab = sub(b, a),
      ac = sub(c, a),
      n = cross(ab, ac),
      den = dot(n, direction);
    if (Math.abs(den) < 1e-12) continue;
    const d = dot(n, sub(a, origin)) / den;
    if (d <= 0.0001 || d >= distance) continue;
    const p = origin.map((v, i) => v + direction[i] * d),
      ap = sub(p, a);
    const d00 = dot(ab, ab),
      d01 = dot(ab, ac),
      d11 = dot(ac, ac),
      d20 = dot(ap, ab),
      d21 = dot(ap, ac),
      inv = 1 / (d00 * d11 - d01 * d01);
    const u = (d11 * d20 - d01 * d21) * inv,
      v = (d00 * d21 - d01 * d20) * inv;
    if (u >= 0 && v >= 0 && u + v <= 1) {
      distance = d;
      triangle = t;
    }
  }
  return { distance, triangle };
}
for (let i = 0; i < 500; i++) {
  const o = Array.from({ length: 3 }, () => random() * 8 - 4),
    d = normalize(Array.from({ length: 3 }, () => random() * 2 - 1)),
    actual = bvh.trace(o, d),
    expected = reference(o, d);
  assert.equal(actual.status, expected.triangle < 0 ? "Miss" : "Hit");
  if (actual.status === "Hit") {
    assert.equal(actual.triangle, expected.triangle);
    assert.ok(Math.abs(actual.distance - expected.distance) < 1e-5);
  }
}
console.log(
  "PASS 500 BVH rays agree with independent brute-force plane/barycentric reference",
);
const planes = new BVH({
  positions: Float32Array.from([
    -2, -2, 1, 2, -2, 1, 0, 2, 1, -2, -2, 2, 2, -2, 2, 0, 2, 2,
  ]),
});
assert.equal(
  planes.trace([0, 0, 0], [0, 0, 1], { accept: (t) => t !== 0 }).triangle,
  1,
);
assert.equal(bvh.trace([0, 0, 0], [0, 0, 1], { budget: 1 }).status, "Unknown");
console.log(
  "PASS alpha rejection continues traversal; exhausted traversal is Unknown",
);

// Analytic empty environment: E = pi * constant incident radiance for any normal.
const empty = {
  geometry: {
    bounds: [0, 0, 0, 1, 1, 1],
    materials: [],
    materialIds: [],
    positions: [],
    uvs: [],
    normals: [],
  },
  stats: {},
  trace: () => ({ status: "Miss", distance: 100 }),
};
const solver = new DDGI(empty, {
  spacing: 2,
  rays: 256,
  traversalBudget: 1000,
});
await solver.initialize(
  () => {},
  () => false,
);
await solver.solve(
  {
    sunDirection: [0, 0, 1],
    sunRadiance: [0, 0, 0],
    skyRadiance: [0.3, 0.5, 0.7],
    bounces: 2,
  },
  () => {},
  () => false,
  () => {},
);
const field = solver.field,
  sample = field.sample([0.5, 0.5, 0.5], [0, 0, 1]);
for (let c = 0; c < 3; c++)
  assert.ok(
    Math.abs(sample.irradiance[c] - [0.3, 0.5, 0.7][c] * Math.PI) < 0.02,
  );
assert.equal(solver.history[0].energy, solver.history[1].energy);
console.log(
  "PASS directional DDGI integration yields pi * sky radiance without bounce energy growth",
);

// A synthetic thin wall separates bright left probes from black right probes.
const grid = {
    origin: [0, 0, 0],
    counts: [2, 2, 2],
    total: 8,
    spacing: 1,
    width: 40,
    height: 20,
    normalBias: 0.075,
  },
  probePositions = new Float32Array(32),
  e = new Float32Array(40 * 20 * 4),
  m = new Float32Array(e.length);
for (let p = 0; p < 8; p++) {
  const x = p % 2,
    y = Math.floor(p / 2) % 2,
    z = Math.floor(p / 4);
  probePositions.set([x, y, z, 1], p * 4);
  for (let j = 0; j < 10; j++)
    for (let i = 0; i < 10; i++) {
      const o = ((z * 10 + j) * 40 + (x + 2 * y) * 10 + i) * 4;
      e.set([x === 0 ? 1 : 0, 0, 0, 1], o);
      m.set(x === 0 ? [0.1, 0.01001, 0, 1] : [10, 100, 0, 1], o);
    }
}
const visibilityField = new ProbeField(grid, probePositions, e, m),
  point = [0.5, 0.5, 0.5],
  normal = [0, 0, 1];
const protectedSample = visibilityField.sample(point, normal),
  leakingSample = visibilityField.sample(point, normal, false);
assert.ok(leakingSample.irradiance[0] > 0.001);
assert.ok(protectedSample.irradiance[0] < leakingSample.irradiance[0] * 0.001);
assert.equal(visibilityField.sample([5, 5, 5], normal).coverage, 0);
console.log(
  "PASS directional distance moments suppress cross-wall probe leakage by >1000x",
);
