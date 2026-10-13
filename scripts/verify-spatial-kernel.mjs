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

for (const reliability of [1, 0.1, 0.001])
  for (const x of [0.001, 0.25, 0.999]) {
    const a = f.sample([x, 0.5, 0.5], [0, 0, 1], {
      fixedFacing: reliability,
      fixedIrradiance: [2, 3, 4],
      diagnostics: true,
    });
    assert.deepEqual(
      a.irradiance.map((v) => Math.round(v * 1e6) / 1e6),
      [2, 3, 4],
    );
    assert.equal(a.coverage, 1);
  }
const ng = [0, 0, 1],
  p = [0.5, 0.5, 0.5];
g.normalBias = 0.075;
const a = f.sample(p, [1, 0, 0], { geometricNormal: ng, diagnostics: true }),
  b = f.sample(p, [-1, 0, 0], { geometricNormal: ng, diagnostics: true });
assert.deepEqual(a.biasedPosition, b.biasedPosition);
assert.deepEqual(a.kernelPosition, a.biasedPosition);
positions[3] = 0;
const left = f.sample([0.5, 0.5, 0.5], [0, 0, 1], { diagnostics: true });
assert.ok(left.coverage < 1);
assert.equal(left.candidates[0].weight, 0);
E.fill(0);
for (let i = 3; i < E.length; i += 4) E[i] = 1;
const dark = f.sample([0.5, 0.5, 0.5], [0, 0, 1]);
assert.deepEqual(dark.irradiance, [0, 0, 0]);
assert.ok(dark.coverage > 0);
positions.fill(0);
assert.equal(f.sample([0.5, 0.5, 0.5], [0, 0, 1]).coverage, 0);
console.log(
  "PASS constant field, low reliability, Ng/Ns, invalid data versus valid darkness",
);
