import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
} from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion(),
    mode: "production display draws; asynchronous GPU queries, no synchronous readback",
  };
await p.addInitScript(installGlObserver);
try {
  await p.goto("http://localhost:8090/demo/globe.html");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.result = await p.evaluate(async () => {
    const w = earthLab.world,
      g = w.packet.grid,
      gl = w.scene.context._gl,
      ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const original = w._draw,
      queries = [],
      times = [];
    let draws = 0,
      collisions = 0,
      disjoint = 0;
    const collect = () => {
      if (!ext) return;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        disjoint++;
        for (const q of queries) gl.deleteQuery(q);
        queries.length = 0;
        times.length = 0;
        return;
      }
      while (
        queries.length &&
        gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
      ) {
        const q = queries.shift();
        times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    };
    w._draw = function (...args) {
      if (args[0] !== "displayBlend") return original.apply(this, args);
      draws++;
      let q;
      if (ext) {
        if (gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) collisions++;
        else {
          q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        }
      }
      try {
        return original.apply(this, args);
      } finally {
        if (q) {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(q);
        }
      }
    };
    const before = w.memoryBytes;
    glObserver.phase("performance");
    try {
      w.setDisplayTransition(150);
      const extraBytes = w.memoryBytes - before;
      const started = performance.now();
      await w.solve({
        sunRadiance: [4, 4, 4],
        skyRadiance: [0.3, 0.36, 0.5],
        publicationMode: "progressive",
      });
      const completed = performance.now();
      for (let i = 0; i < 240 && (!w.displaySettled || queries.length); i++) {
        await new Promise(requestAnimationFrame);
        collect();
      }
      const elapsed = performance.now() - completed,
        sorted = [...times].sort((a, b) => a - b),
        idleDraws = draws;
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      return {
        extraBytes,
        expectedExtraBytes: 3 * g.width * g.height * 16,
        draws,
        idleDraws,
        samples: times.length,
        totalGpuMilliseconds: ext ? times.reduce((s, v) => s + v, 0) : null,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
        duration: w._display.duration,
        requestToRawCompleted: completed - started,
        rawCompletedToDisplaySettled: elapsed,
        collisions,
        disjoint,
        gl: glObserver.snapshot(),
        errors: earthLab.errors,
      };
    } finally {
      w._draw = original;
      for (const q of queries) gl.deleteQuery(q);
      w.setDisplayTransition(0);
    }
  });
  assert.equal(report.result.extraBytes, report.result.expectedExtraBytes);
  assert.equal(report.result.draws, report.result.idleDraws);
  assert.equal(report.result.collisions, 0);
  assert.deepEqual(report.result.errors, []);
  for (const s of report.result.gl) {
    for (const k of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
    ])
      assert.equal(s.phases.performance?.[k] ?? 0, 0);
    assert.deepEqual(s.feedback, []);
    assert.deepEqual(s.errors, []);
  }
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(
    "reports/ddgi-visual-quality-v4/performance-display.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
