import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/preview-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  report = {
    version: sourceVersion(["scripts/benchmark-ballpool-preview.mjs"]),
    rows: [],
    errors: [],
  };
try {
  for (const count of [16, 64, 128]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    await page.goto(`http://localhost:8090/demo/ballpool.html?count=${count}`);
    await page.waitForFunction(
      () => ballPool.snapshot().phase === "static-ready",
      null,
      { timeout: 180000 },
    );
    const row = await page.evaluate(async () => {
      const { measureFrames } = await import("./benchmark.js");
      ballPool.play();
      ballPool.toss();
      const before = ballPool.physics.ticks,
        whole = await measureFrames(ballPool.scene, 120, { warmup: 20 }),
        after = ballPool.physics.ticks;
      return {
        whole,
        ticks: after - before,
        physics: ballPool.physics.metrics(),
        state: ballPool.snapshot(),
      };
    });
    row.count = count;
    row.environment = await environment(page, browser);
    report.rows.push(row);
    assert.equal(row.whole.actualFGFrames, 0);
    assert.equal(row.state.worldGeneration, null);
    assert(row.ticks > 30);
    assert(row.whole.gpuMilliseconds.samples >= 90);
    assert.equal(row.whole.disjoint, 0);
    assert(row.whole.incompleteQueries === 0);
    assert(row.physics.wasmReservedBytes > 0);
    assert(row.state.resources.peakAdditionalBytes <= 64 * 1048576);
    console.log(
      JSON.stringify({
        count,
        gpu: row.whole.gpuMilliseconds,
        cpu: row.whole.cpuMilliseconds,
        ticks: row.ticks,
      }),
    );
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  report.scope =
    "direct/solar shadows/basic IBL physics preview; local GI disabled; not an FG acceleration result";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
} finally {
  await browser.close();
  await writeFile(
    out + "/preview-performance.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify({ status: report.status, error: report.error }));
if (report.status !== "passed") process.exitCode = 1;
