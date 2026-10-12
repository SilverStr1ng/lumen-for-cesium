import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = {
    startedAt: new Date().toISOString(),
    version: sourceVersion(),
    scene: "fixtures/far-blocker.gltf",
    errors: [],
  },
  browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(
    "http://localhost:8090/demo/regression.html?fixture=far-blocker",
  );
  await page.waitForFunction(
    () =>
      window.lumenTest?.world?.status === "ready" ||
      window.lumenTest?.errors.length,
    null,
    { timeout: 180000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
  report.result = await page.evaluate(async () => {
    const w = lumenTest.world;
    await w.solve({ sunDirection: [0, 0, 1] });
    const g = w.packet.grid,
      hits = w._read(w._hitFB, g.rays, g.total),
      visibility = w._read(
        w._visibilityFB,
        g.rays,
        g.total,
        0,
        Cesium.PixelDatatype.UNSIGNED_BYTE,
      );
    let checked = 0,
      leaks = 0;
    for (let i = 0; i < hits.length; i += 4) {
      const triangle = w._order[Math.abs(hits[i]) - 2];
      if (triangle < 2 && hits[i] > 1 && visibility[i + 2] === 255) {
        checked++;
        if (visibility[i] !== 0 || visibility[i + 1] !== 255) leaks++;
      }
    }
    const ray = { origin: [0.1, 0.2, 0.02], direction: [0, 0, 1] };
    return {
      grid: g,
      checked,
      leaks,
      short: await w.trace([{ ...ray, maxDistance: 100 }], { anyHit: true }),
      complete: await w.trace([{ ...ray, maxDistance: 200 }], { anyHit: true }),
    };
  });
  assert.ok(report.result.checked > 0);
  assert.equal(report.result.leaks, 0);
  assert.equal(report.result.short[0].status, "Miss");
  assert.equal(report.result.complete[0].status, "Hit");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(report.result);
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  process.exitCode = 1;
  console.error(e);
} finally {
  await writeFile(
    `reports/globe-visibility-v3/visibility-far-blocker-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    "reports/globe-visibility-v3/visibility-far-blocker.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
