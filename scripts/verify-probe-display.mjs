import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
} from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } }),
  report = {
    version: sourceVersion([
      "cesium-1.146/packages/engine/Source/Scene/LumenProbeDisplay.js",
    ]),
    checks: [],
  };
await p.addInitScript(installGlObserver);
try {
  await p.goto(
    "http://localhost:8090/demo/regression.html?fixture=untextured&onDemand=1",
  );
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  report.result = await p.evaluate(async () => {
    try {
      const d = lumenTest,
        w = d.world,
        points = d.metadata.receivers,
        rawBytes = w.memoryBytes,
        checks = [];
      const delta = (a, b) =>
        Math.max(
          ...a.flatMap((p, i) =>
            p.irradiance.map((v, k) => Math.abs(v - b[i].irradiance[k])),
          ),
        );
      w.setDisplayTransition(150);
      const extraBytes = w.memoryBytes - rawBytes,
        owned = w._display.resources.map((r) => r.E);
      glObserver.phase("display-production");
      await w.solve({
        sunRadiance: [8, 8, 8],
        skyRadiance: [1, 1, 1],
        publicationMode: "snapshot",
      });
      const completedAt = performance.now(),
        initialAlpha = w._display.alpha,
        duration = w._display.duration;
      glObserver.phase("display-diagnostic");
      const raw = await w.sample(points),
        display = await w.sample(points, { display: true }),
        frozen = w.snapshot().irradiance.slice();
      glObserver.phase("display-production");
      for (let i = 0; i < 120 && !w.displaySettled; i++)
        await new Promise(requestAnimationFrame);
      const settledMilliseconds = performance.now() - completedAt,
        draws = w._display.draws;
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      const idleDraws = w._display.draws;
      glObserver.phase("display-diagnostic");
      const settled = await w.sample(points, { display: true });
      w.setDisplayTransition(0);
      const released =
        owned.every((t) => t.isDestroyed()) && w.memoryBytes === rawBytes;
      await w.solve({
        sunRadiance: [8, 8, 8],
        skyRadiance: [1, 1, 1],
        publicationMode: "snapshot",
      });
      const unfiltered = w.snapshot().irradiance;
      let rawDifference = 0;
      for (let i = 0; i < frozen.length; i++)
        rawDifference = Math.max(
          rawDifference,
          Math.abs(frozen[i] - unfiltered[i]),
        );
      w.maxMemoryBytes =
        w.memoryBytes + 3 * w.packet.grid.width * w.packet.grid.height * 16 - 1;
      let budgetRejected = false;
      try {
        w.setDisplayTransition(150);
      } catch {
        budgetRejected = true;
      }
      const rejectedClean =
        w.memoryBytes === rawBytes && w.displayTransitionMilliseconds === 0;
      w.maxMemoryBytes = 192 * 1048576;
      w.setDisplayTransition(150);
      await w.solve({
        sunRadiance: [0, 0, 0],
        skyRadiance: [0, 0, 0],
        materialOverrides: [{ id: 0, baseColorFactor: [0.2, 0.2, 0.2] }],
        publicationMode: "snapshot",
      });
      const invalidated =
        !w._display.active &&
        delta(
          await w.sample(points),
          await w.sample(points, { display: true }),
        ) < 1e-6;
      const resources = w._display.resources.map((r) => r.E);
      w.destroy();
      const destroyed = resources.every((t) => t.isDestroyed());
      return {
        extraBytes,
        expectedExtraBytes: 3 * frozen.length * 4,
        initialAlpha,
        duration,
        initialDifference: delta(raw, display),
        settledDifference: delta(raw, settled),
        settledMilliseconds,
        draws,
        idleDraws,
        released,
        rawDifference,
        budgetRejected,
        rejectedClean,
        invalidated,
        destroyed,
        gl: glObserver.snapshot(),
        errors: d.errors,
      };
    } catch (e) {
      throw new Error((e.message ?? String(e)) + "\n" + (e.stack ?? ""));
    }
  });
  const r = report.result;
  assert.equal(r.extraBytes, r.expectedExtraBytes);
  assert.ok(r.initialDifference > 1e-3);
  assert.equal(r.duration, 50);
  assert.ok(r.settledDifference < 1e-6);
  assert.ok(r.settledMilliseconds < 300);
  assert.equal(r.draws, r.idleDraws);
  assert.ok(
    r.released &&
      r.destroyed &&
      r.invalidated &&
      r.budgetRejected &&
      r.rejectedClean,
  );
  assert.equal(r.rawDifference, 0);
  assert.deepEqual(r.errors, []);
  for (const s of r.gl) {
    for (const key of [
      "readPixels",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
    ])
      assert.equal(s.phases["display-production"]?.[key] ?? 0, 0, key);
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
    "reports/ddgi-visual-quality-v4/probe-display.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
