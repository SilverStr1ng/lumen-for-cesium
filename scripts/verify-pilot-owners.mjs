import assert from "node:assert/strict";
import Owners from "../cesium-1.146/packages/engine/Source/Scene/LumenReceiverOwners.js";
const owners = new Owners(),
  a = {},
  b = {},
  p = {};
assert.notEqual(owners.surface(a, p), owners.surface(b, p));
assert.equal(owners.surface(a, p), owners.surface(a, p));
assert.equal(owners.curve(a, 1), 4097);
assert.equal(owners.curve(a, 2), 4098);
assert.notEqual(owners.curve(b, 1), owners.curve(a, 1));
assert.equal(owners.curve(b, 1), owners.curve(b, 1));
for (let i = 0; i < 5000; i++) {
  const id = owners.surface(a, {});
  assert(id < 4096 || id >= 8192);
}
const fresh = new Owners();
assert.equal(fresh.surface(a, p), 1);
assert.equal(fresh.curve(a, 1), 4097);
console.log(
  "PASS global planar and controlled-curve identities; repeated model/instance ids cannot alias",
);
