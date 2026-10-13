import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { sourceVersion } from "./browser-tools.mjs";
import Matrix4 from "../cesium-1.146/packages/core/Source/Matrix4.js";
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
const noTimer = new LumenFinalGather({
  _scene: {
    context: { _gl: { getExtension: () => null } },
    frameState: { frameNumber: 0 },
  },
});
for (let frame = 0; frame < 1000; frame++) {
  noTimer.scene.frameState.frameNumber = frame;
  noTimer._measure("trace", () => {});
}
assert.equal(noTimer._timerFrames.size, 0);
assert.equal(noTimer.metrics.timingUnavailable, 1000);
noTimer.destroy();
// Construct the actual world class: a failed initial clone must retain no owner.
const originalWorker = globalThis.Worker,
  originalInvalidate = LumenGpuWorld.prototype._invalidateTimers;
let created = 0,
  terminated = 0,
  retained = 0;
const failedContext = {
  webgl2: true,
  colorBufferFloat: true,
  textureFloatLinear: true,
  _gl: { getExtension: () => ext, getParameter: () => true },
};
try {
  LumenGpuWorld.prototype._invalidateTimers = function () {
    retained++;
  };
  globalThis.Worker = class {
    constructor() {
      created++;
    }
    postMessage() {
      throw Error("injected initial clone failure");
    }
    terminate() {
      terminated++;
    }
  };
  for (let i = 0; i < 10; i++)
    assert.throws(
      () =>
        new LumenGpuWorld(
          { context: failedContext },
          {
            modelMatrix: Matrix4.IDENTITY,
            workerUrl: "test-worker",
            url: "test",
          },
        ),
      /injected initial clone failure/,
    );
  LumenGpuTimer.poll(failedContext, ext);
  assert.equal(retained, 0);
  assert.equal(terminated, created);
  globalThis.Worker = class {
    constructor() {
      throw Error("injected Worker failure");
    }
  };
  assert.throws(
    () =>
      new LumenGpuWorld(
        { context: failedContext },
        {
          modelMatrix: Matrix4.IDENTITY,
          workerUrl: "test-worker",
          url: "test",
        },
      ),
    /injected Worker failure/,
  );
  LumenGpuTimer.poll(failedContext, ext);
  assert.equal(retained, 0);
} finally {
  globalThis.Worker = originalWorker;
  LumenGpuWorld.prototype._invalidateTimers = originalInvalidate;
}
// Back-pressure suppresses instrumentation for the whole frame; drawing continues.
const delayed = new LumenFinalGather({ _scene: scene });
available = false;
for (let i = 0; i < 40; i++) delayed._queries.push({ query: "delayed-" + i });
delayed.beginFrame();
let drawn = 0;
for (let i = 0; i < 24; i++)
  delayed._measure("trace", () => {
    drawn++;
  });
assert.equal(drawn, 24);
assert.equal(delayed._queries.length, 40);
assert.equal(delayed._timerFrames.size, 0);
delayed.destroy();
// Diagnostics must never keep a stale successful fallback code after disabling FG.
const fallback = new LumenFinalGather({ _scene: scene, enabled: true });
fallback.mode = "fg";
fallback.fallbackReason = 0;
fallback.executePrepared();
assert.equal(fallback.fallbackReason, 2);
fallback.model = { isDestroyed: () => false };
fallback.lumen.world = {
  ready: true,
  isDestroyed: () => false,
  requestedRevision: 1,
  finalGatherSnapshot: { revision: 1, resources: [] },
  eyeToLocal: Matrix4.IDENTITY,
};
scene.frameState.mode = 2;
scene.frameState.passes = { render: true };
fallback.fallbackReason = 0;
fallback.executePrepared();
assert.equal(fallback.fallbackReason, 1);
scene.frameState.mode = 3;
fallback.lumen.world.eyeToLocal = Matrix4.fromTranslation({
  x: 3000,
  y: 0,
  z: 0,
});
fallback.fallbackReason = 0;
fallback.executePrepared();
assert.equal(fallback.fallbackReason, 9);
fallback.destroy();
await mkdir("reports/fg-reconstruction-showcase-v6", { recursive: true });
await writeFile(
  "reports/fg-reconstruction-showcase-v6/timers.json",
  JSON.stringify(
    {
      version: sourceVersion(),
      status: "passed",
      checks: [
        "pending unavailable disjoint dropped",
        "second owner invalidated before consuming cleared flag",
        "no contaminated scheduling cost",
        "complete frame accepted only after every query",
        "missing timer extension creates no unbounded frame ledger",
        "initial postMessage and Worker failure rollback",
        "query back-pressure preserves draws and skips whole timer groups",
        "unsupported/source/outside fallback reasons are not stale success",
      ],
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual FG/world modules: shared disjoint pending invalidation and complete frames",
);
