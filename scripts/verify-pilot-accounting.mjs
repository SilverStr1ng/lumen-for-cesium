import assert from "node:assert/strict";
import ResourceBudget from "../lumen/resource-budget.js";
import LumenSession from "../lumen/LumenSession.js";
const texture = (bytes, id) => ({
  sizeInBytes: bytes,
  _id: id,
  isDestroyed: () => false,
});
const model = (id, bytes) => ({
  _statistics: { _bufferByteLengths: { [id]: bytes } },
  isDestroyed: () => false,
  environmentMapManager: { _radianceCubeMap: texture(4) },
});
const first = model("old", 40),
  next = model("new", 20),
  budget = new ResourceBudget(100);
const session = Object.assign(Object.create(LumenSession.prototype), {
  models: [first],
  scene: { lumen: { finalGather: {} } },
  budget,
  _pendingResources: new Map(),
  _frozenCache: { allocations: () => [] },
});
budget.refresh = () => session._account();
session._nativeLease = budget.reserve(44, "native");
session._account();
const pending = { models: [next], nativeLease: budget.reserve(24, "native") };
session._pendingResources.set(1, pending);
session._account();
assert.equal(budget.committedBytes, 68);
assert.equal(budget.reservedBytes, 0);
assert.equal(session.resources.categories.environmentGpu, 8); // two ID-less CubeMaps
const worker = {},
  buffer = new ArrayBuffer(12);
session.world = {
  worker,
  packet: { bvh: { cpuRetainedBytes: 8 } },
  _order: new Uint32Array(buffer),
  _baseMaterials: new Float32Array(buffer),
};
session._account();
assert.equal(session.resources.categories.packetCpu, 12);
assert.equal(session.resources.categories.workerCpu, 8);
session.world._closed = true;
session._account();
assert.equal(session.resources.categories.workerCpu, undefined);
session._nativeLease.release();
pending.nativeLease.release();
session._pendingResources.clear();
session.disposed = true;
session._account();
assert.equal(budget.entries.size, 0);
assert.equal(budget.committedBytes, 0);
// A geometry reservation may cover only its own generation's buffers.
session.disposed = false;
session.models = [];
session.world = { worker: {}, packet: { bvh: { cpuRetainedBytes: 40 } } };
session._account();
const lease = budget.reserve(60, "new geometry");
session._pendingResources.set(2, { models: [], geometryLease: lease });
session._account();
assert.equal(budget.admittedBytes, 100);
assert.throws(() => budget.reserve(1, "over"), { name: "QuotaExceededError" });
lease.release();
console.log(
  "PASS allocation identities, native capacity consumption, generation-owned reservation, terminated worker and disposed CPU release",
);
