import assert from "node:assert/strict";
import { referenceIrradiance } from "../lumen/path-reference.js";

// Analytic integral, independent of the production sampler and estimator.
// Empty geometry isolates receiver-side normal transport from DDGI and BVH.
const miss = {
  geometry: { bounds: [-1, -1, -1, 1, 1, 1] },
  trace: () => ({ status: "Miss" }),
};
const lighting = {
  sunDirection: [0, 0, 1], sunRadiance: [0, 0, 0],
  skyRadiance: [1, 1, 1], bounces: 1,
};
for (const degrees of [0, 5, 15, 30]) {
  const a = degrees * Math.PI / 180, ns = [Math.sin(a), 0, Math.cos(a)];
  for (const seed of [0, 5, 19]) {
    const r = referenceIrradiance(miss, [0, 0, 0], ns, lighting,
      65536, seed, [0, 0, 1]);
    const expected = Math.PI * (1 + Math.cos(a)) / 2;
    assert(Math.abs(r.irradiance[0] - expected) < .012,
      `white furnace ${degrees}deg seed ${seed}: ${r.irradiance[0]} != ${expected}`);
    assert(r.irradiance.every(x => x <= Math.PI + 1e-6 && x >= 0));
    const black = referenceIrradiance(miss, [0, 0, 0], ns,
      { ...lighting, skyRadiance: [0, 0, 0] }, 1024, seed, [0, 0, 1]);
    assert.deepEqual(black.irradiance, [0, 0, 0]);
  }
}
console.log("curved receiver independent white/black contract passed");
