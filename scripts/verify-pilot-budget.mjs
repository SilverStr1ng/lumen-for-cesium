import assert from "node:assert/strict";
import ResourceBudget from "../lumen/resource-budget.js";
const budget = new ResourceBudget(100),
  texture = {};
budget.observe([
  { key: texture, bytes: 40, category: "snapshotGpu" },
  { key: texture, bytes: 40, category: "giGpu" },
]);
assert.equal(budget.committedBytes, 40);
assert.equal(budget.planBase, 0);
const allocation = budget.reserve(50, "replacement");
assert.equal(budget.admittedBytes, 90);
let allocated = false;
assert.throws(
  () => {
    budget.reserve(11, "over-limit");
    allocated = true;
  },
  { name: "QuotaExceededError" },
);
assert.equal(allocated, false);
allocation.release();
assert.equal(budget.reservedBytes, 0);
const shared = {};
budget.observe([
  { key: texture, bytes: 40, category: "snapshotGpu" },
  { key: shared, bytes: 10, category: "cpu" },
  { key: shared, bytes: 10, category: "cpu" },
]);
assert.equal(budget.committedBytes, 50);
assert.equal(budget.planBase, 10);
assert.throws(() =>
  budget.observe([
    { key: shared, bytes: 1 },
    { key: shared, bytes: 2 },
  ]),
);
budget.observe([]);
assert.equal(budget.committedBytes, 0);
assert.equal(budget.report().peakAdmittedBytes, 90);
console.log(
  "PASS shared allocation identities, disjoint snapshot class, pre-allocation rejection and reservation rollback",
);
const atomic = new ResourceBudget(100),
  old = {},
  live = {};
atomic.observe([{ key: old, bytes: 80, category: "cpu" }]);
const capacity = atomic.reserve(20, "native");
capacity.cover(20);
atomic.observe([
  { key: old, bytes: 80, category: "cpu" },
  { key: live, bytes: 20, category: "displayGpu" },
]);
capacity.cover(0);
atomic.observe([{ key: old, bytes: 80, category: "cpu" }]);
assert.equal(atomic.report().peakAdmittedBytes, 100);
capacity.release();
