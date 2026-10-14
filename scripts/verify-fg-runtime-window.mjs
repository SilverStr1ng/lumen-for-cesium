import assert from "node:assert/strict";
import { measureFrames } from "../demo/benchmark.js";

// Deterministic asynchronous GL queries keep rendering while the measurement
// drains. Only the bounded postRender window may drive sample/activity evidence.
class Event {
  listeners = new Set();
  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  removeEventListener(listener) {
    this.listeners.delete(listener);
  }
  raise() {
    for (const listener of this.listeners) listener();
  }
}
const originals = {
  Cesium: globalThis.Cesium,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  document: globalThis.document,
};
try {
  for (const requireFG of [false, true]) {
    let tick = 0,
      current,
      live = 0,
      registered = 0;
    const ext = {
      TIME_ELAPSED_EXT: 1,
      TIMESTAMP_EXT: 2,
      QUERY_COUNTER_BITS_EXT: 3,
    };
    const gl = {
      CURRENT_QUERY: 4,
      QUERY_RESULT_AVAILABLE: 5,
      QUERY_RESULT: 6,
      getExtension: () => ext,
      getQuery: (target) => (target === ext.TIME_ELAPSED_EXT ? current : 0),
      createQuery: () => {
        live++;
        return {};
      },
      beginQuery: (target, query) => {
        assert(!current);
        current = query;
      },
      endQuery: () => {
        current.readyAt = tick + 5;
        current = undefined;
      },
      deleteQuery: () => {
        live--;
      },
      getQueryParameter: (query, key) =>
        key === gl.QUERY_RESULT_AVAILABLE ? tick >= query.readyAt : 1000000,
    };
    const scene = {
      context: { _gl: gl },
      preRender: new Event(),
      postRender: new Event(),
      lumen: { finalGather: { metrics: { frames: 0 } } },
      drawingBufferWidth: 1920,
      drawingBufferHeight: 1080,
      gBuffer: { enabled: false },
      requestRender() {},
    };
    globalThis.Cesium = {
      LumenGpuTimer: {
        register: () => {
          registered++;
          return () => registered--;
        },
        poll: () => false,
      },
    };
    globalThis.document = { visibilityState: "visible" };
    globalThis.requestAnimationFrame = (callback) =>
      queueMicrotask(() => {
        tick++;
        scene.preRender.raise();
        if (![3, 7].includes(tick)) scene.lumen.finalGather.metrics.frames++;
        scene.postRender.raise();
        callback(tick);
      });
    const before = [],
      after = [],
      epochs = [];
    const result = await measureFrames(scene, 12, {
      warmup: 2,
      requireFG,
      beforeFrame: (index) => before.push(index),
      afterFrame: ({ index, executed }) => {
        after.push(index);
        if (executed) epochs.push(epochs.length);
      },
    });
    assert(tick > 12, "query drain must render additional frames");
    assert.deepEqual(
      before,
      Array.from({ length: 12 }, (_, i) => i),
    );
    assert.deepEqual(after, before);
    assert.equal(result.renderedFrames, 12);
    assert.equal(result.actualFGFrames, 10);
    assert.equal(epochs.length, result.actualFGFrames);
    assert.equal(result.gpuMilliseconds.samples, requireFG ? 8 : 10);
    assert.equal(result.excludedFallbackFrames, requireFG ? 2 : 0);
    assert.equal(result.missingQueries, 0);
    assert.equal(result.incompleteQueries, 0);
    assert.equal(live, 0);
    assert.equal(current, undefined);
    assert.equal(registered, 0);
    assert.equal(
      scene.preRender.listeners.size + scene.postRender.listeners.size,
      0,
    );
  }
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
console.log(
  "PASS bounded actual-render evidence, busy/fallback queries, asynchronous drain and timer cleanup",
);
