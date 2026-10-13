import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import LumenFinalGather from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js";
import LumenGpuWorld from "../cesium-1.146/packages/engine/Source/Scene/LumenGpuWorld.js";
import LumenGpuTimer from "../cesium-1.146/packages/engine/Source/Scene/LumenGpuTimer.js";
const ext = { GPU_DISJOINT_EXT: 1 },
  deleted = [],
  reads = [];
let disjoint = false,
  available = false;
const gl = {
  getExtension: () => ext,
  getParameter: () => {
    const v = disjoint;
    disjoint = false;
    return v;
  },
  getQueryParameter: (q, p) => {
    reads.push(q);
    return p === 2 ? available : 999000000;
  },
  deleteQuery: (q) => deleted.push(q),
  QUERY_RESULT_AVAILABLE: 2,
  QUERY_RESULT: 3,
};
const context = { _gl: gl },
  scene = { context, frameState: { frameNumber: 1 } },
  fg = new LumenFinalGather({ _scene: scene });
const w = Object.create(LumenGpuWorld.prototype);
Object.assign(w, {
  scene,
  _timer: ext,
  _queries: [],
  _costs: { trace: 1 },
  _batches: { trace: 5 },
  metrics: { disjoint: 0, timerMissing: 0, passes: {} },
});
const unregister = LumenGpuTimer.register(context, () => w._invalidateTimers());
const stage = { timerMissing: 0 };
fg._queries.push({ query: "fg-pending", stage: "trace", frame: 1 });
fg._timerFrames.set(1, {
  frame: 1,
  submitted: 1,
  received: 0,
  stages: {},
  closed: true,
  missing: 0,
});
w._queries.push({ query: "world-pending", stage, phase: "trace", count: 1 });
disjoint = true;
available = false;
fg._poll();
assert.deepEqual(new Set(deleted), new Set(["fg-pending", "world-pending"]));
available = true;
fg._poll();
w._pollTimers();
assert.equal(reads.length, 0);
assert.equal(fg.metrics.completedTimings.length, 0);
assert.equal(w._costs.trace, 1);
assert.equal(w._batches.trace, 5);
assert.equal(stage.timerMissing, 1);
fg._queries.push({ query: "fg-good", stage: "trace", frame: 2 });
fg._timerFrames.set(2, {
  frame: 2,
  submitted: 1,
  received: 0,
  stages: {},
  closed: true,
  missing: 0,
});
fg._poll();
assert.equal(fg.metrics.completedTimings[0].stages.trace, 999);
unregister();
fg.destroy();
await mkdir("reports/fg-reconstruction-showcase-v6", { recursive: true });
await writeFile(
  "reports/fg-reconstruction-showcase-v6/timers.json",
  JSON.stringify(
    {
      status: "passed",
      checks: [
        "pending unavailable disjoint dropped",
        "second owner invalidated before consuming cleared flag",
        "no contaminated scheduling cost",
        "complete frame accepted only after every query",
      ],
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual FG/world modules: shared disjoint pending invalidation and complete frames",
);
