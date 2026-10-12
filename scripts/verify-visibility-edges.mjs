import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const browser = await launchBrowser(),
  report = {
    startedAt: new Date().toISOString(),
    version: sourceVersion(),
    scene: "alpha-mask",
    errors: [],
  };
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(
    "http://localhost:8090/demo/regression.html?fixture=alpha-mask",
  );
  await page.waitForFunction(
    () =>
      window.lumenTest?.world?.status === "ready" ||
      window.lumenTest?.errors.length,
    null,
    { timeout: 180000 },
  );
  report.runs = await page.evaluate(async () => {
    const d = lumenTest,
      out = [];
    for (const mode of ["reference", "optimized"]) {
      const w = d.load({ bvhStrategy: "sah", visibilityMode: mode });
      await w.completed;
      const rays = [
        ...d.metadata.rays.map((r) => ({ ...r, maxDistance: 10 })),
        { origin: [-1, 0.5, 1], direction: [1, 1e-12, 0], maxDistance: 10 },
        { origin: [1.5, 0.5, 1], direction: [-1, 0, 0], maxDistance: 10 },
        { origin: [1, 0.5, 1], direction: [1, 0, 0], maxDistance: 10 },
        { origin: [1 - 1e-6, 0.5, 1], direction: [1, 0, 0], maxDistance: 10 },
      ];
      rays.push(...d.metadata.rays.map((r) => ({ ...r, maxDistance: 1.5 })));
      const hits = await w.trace(rays),
        any = await w.trace(rays, { anyHit: true }),
        cpu = await w.referenceTrace(rays),
        stats = await w.trace(rays, { anyHit: true, statistics: true });
      out.push({ mode, rays, hits, any, cpu, stats });
    }
    return out;
  });
  for (const run of report.runs) {
    assert.ok(Math.abs(run.hits[0].distance - 2) < 1e-5);
    assert.ok(Math.abs(run.hits[1].distance - 1) < 1e-5);
    assert.ok(Math.abs(run.hits[2].distance - 1) < 1e-5);
    assert.equal(run.any[6].status, "Miss");
    assert.equal(run.any[7].status, "Hit");
    assert.ok(run.stats[6].alphaTests > 0 && run.stats[7].alphaTests > 0);
    for (let i = 0; i < run.rays.length; i++) {
      assert.equal(run.hits[i].status, run.any[i].status);
      assert.equal(run.cpu[i].status, run.hits[i].status);
    }
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(report.runs);
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  process.exitCode = 1;
  console.error(e);
} finally {
  await writeFile(
    `reports/globe-visibility-v3/visibility-edges-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    "reports/globe-visibility-v3/visibility-edges.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
