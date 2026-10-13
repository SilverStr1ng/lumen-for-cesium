import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
} from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } }),
  report = { version: sourceVersion(), checks: [] };
await p.addInitScript(installGlObserver);
try {
  await p.goto("http://localhost:8090/demo/regression.html?fixture=untextured");
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  report.result = await p.evaluate(async () => {
    try {
      const w = lumenTest.world,
        points = lumenTest.metadata.receivers,
        initialBytes = w.memoryBytes,
        rows = [];
      w.setFinalGatherCapture(true);
      glObserver.phase("fg-production");
      await w.solve({ bounces: 1, publicationMode: "snapshot" });
      const first = w.finalGatherSnapshot.retain();
      glObserver.phase("fg-diagnostic");
      rows.push({
        k: 1,
        fg: await w.sampleFinalGather(points, {
          snapshot: first,
          samples: 256,
        }),
        exact: await w.sampleExactProbeVisibility(points, { snapshot: first }),
      });
      const fieldFirst = w
        ._read(first.resources[0].fb, first.grid.width, first.grid.height)
        .slice();
      glObserver.phase("fg-production");
      await w.solve({
        bounces: 3,
        materialOverrides: [{ id: 0, emissiveFactor: [0.8, 0.1, 0.02] }],
        sunRadiance: [0, 0, 0],
      });
      const current = w.finalGatherSnapshot;
      glObserver.phase("fg-diagnostic");
      const retained = await w.sampleFinalGather(points, {
          snapshot: first,
          samples: 256,
        }),
        currentSamples = await w.sampleFinalGather(points, { samples: 256 }),
        unknown = await w.sampleFinalGather(points, { samples: 32, budget: 1 }),
        nsMismatch = await w.sampleFinalGather(
          points.map((p) => ({
            ...p,
            geometricNormal: p.normal,
            normal: p.normal.map((v) => -v),
          })),
          { samples: 32 },
        );
      let difference = 0;
      const raw = w._read(
        first.resources[0].fb,
        first.grid.width,
        first.grid.height,
      );
      for (let i = 0; i < raw.length; i++)
        difference = Math.max(difference, Math.abs(raw[i] - fieldFirst[i]));
      const leasedBytes = w.memoryBytes - initialBytes,
        versions = { first: first.versions, current: current.versions },
        snapshots = w._fgSnapshots.size;
      first.release();
      w.setFinalGatherCapture(false);
      const released = w.memoryBytes === initialBytes;
      w.maxMemoryBytes = w.memoryBytes + 1;
      w.setFinalGatherCapture(true);
      await w.solve({ bounces: 1 });
      const budgetFallback =
        !w.finalGatherSnapshot && w.memoryBytes === initialBytes && w.ready;
      w.maxMemoryBytes = 192 * 1048576;
      await w.solve({ bounces: 2 });
      const resources = w.finalGatherSnapshot.resources.map((r) => r.texture);
      w.destroy();
      return {
        rows,
        retained,
        currentSamples,
        unknown,
        nsMismatch,
        difference,
        leasedBytes,
        versions,
        snapshots,
        released,
        budgetFallback,
        destroyed: resources.every((t) => t.isDestroyed()),
        gl: glObserver.snapshot(),
        errors: lumenTest.errors,
      };
    } catch (e) {
      throw Error((e.message ?? String(e)) + "\n" + (e.stack ?? ""));
    }
  });
  const r = report.result;
  assert.ok(r.rows[0].fg.every((p) => p.valid && p.round === 1));
  assert.deepEqual(
    r.rows[0].fg,
    r.retained,
    "old snapshot must retain old material, sun and previous E despite new solve",
  );
  assert.equal(r.difference, 0);
  assert.equal(r.snapshots, 2);
  assert.ok(r.versions.current.material > r.versions.first.material);
  assert.ok(r.unknown.every((p) => !p.valid && p.unknown));
  assert.ok(r.nsMismatch.every((p) => !p.valid));
  assert.ok(r.released && r.budgetFallback && r.destroyed);
  assert.deepEqual(r.errors, []);
  for (const s of r.gl) {
    for (const k of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
    ])
      assert.equal(s.phases["fg-production"]?.[k] ?? 0, 0, k);
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
    "reports/receiver-final-gather-v5/fg-snapshot.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
