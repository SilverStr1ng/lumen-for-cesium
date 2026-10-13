import assert from "node:assert/strict";
import { ProbeField } from "../lumen/ddgi.js";
const g = {
  origin: [0, 0, 0],
  counts: [2, 2, 2],
  spacing: 1,
  total: 8,
  width: 40,
  height: 20,
  normalBias: 0,
};
const positions = new Float32Array(32),
  E = new Float32Array(3200),
  M = new Float32Array(3200);
for (let id = 0; id < 8; id++) {
  const x = id % 2,
    y = Math.floor(id / 2) % 2,
    z = Math.floor(id / 4);
  positions.set([x, y, z, 1], id * 4);
  for (let j = 0; j < 10; j++)
    for (let i = 0; i < 10; i++) {
      const offset = ((z * 10 + j) * 40 + (x + 2 * y) * 10 + i) * 4;
      E.set([x, 2 * x, 3 * x, 1], offset);
      M.set([10, 100, 0, 1], offset);
    }
}
const f = new ProbeField(g, positions, E, M),
  failures = [];
for (const x of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
  const actual = f.sample([x, 0.5, 0.5], [0, 0, 1], {
    fixedFacing: 1,
    diagnostics: true,
  });
  console.log(
    JSON.stringify({
      x,
      actual: actual.irradiance,
      expected: [x, 2 * x, 3 * x],
      weight: actual.totalWeight,
    }),
  );
  try {
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(actual.irradiance[c] - (c + 1) * x) < 1e-6,
        "linear E must follow trilinear space kernel",
      );
    assert.ok(Math.abs(actual.totalWeight - 1) < 1e-6);
  } catch (e) {
    failures.push(e.message);
  }
}
assert.deepEqual(failures, []);
console.log("PASS independent linear field / normalized trilinear kernel");
