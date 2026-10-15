import assert from "node:assert/strict";
import { sameDiagnosticCamera as same } from "../lumen/session-diagnostics.js";
const pose = {
  position: [1000000, 2000000, 6000000],
  direction: [0, 0, -1],
  up: [0, 1, 0],
  right: [1, 0, 0],
  projection: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
  buffer: [1920, 1080],
};
assert(same(pose, structuredClone(pose)));
const noise = structuredClone(pose);
noise.position[0] += 3e-9;
noise.direction[0] += 3e-15;
assert(same(pose, noise));
let rejected = 0;
const reject = (change) => {
  const other = structuredClone(pose);
  change(other);
  assert.equal(same(pose, other), false);
  rejected++;
};
reject((p) => (p.position[0] += 0.001));
reject((p) => (p.direction[0] += 1e-8));
reject((p) => (p.up[0] += 1e-8));
reject((p) => (p.right[0] += 1e-8));
reject((p) => (p.projection[0] += 0.000001));
reject((p) => p.buffer[0]++);
reject((p) => (p.direction[0] = NaN));
reject((p) => delete p.position);
console.log(
  JSON.stringify({
    status: "passed",
    roundoffFactor: 64,
    rejected,
    positionBoundMetres: 64 * Number.EPSILON * 6000000,
    scope: "double pose roundoff only; quality thresholds unchanged",
  }),
);
