import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/desktop-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  report = {
    version: sourceVersion(["scripts/verify-ballpool-desktop.mjs"]),
    rows: [],
    errors: [],
  };
try {
  for (const count of [16, 64, 128])
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", (e) => report.errors.push(String(e)));
      await page.goto(
        `http://localhost:8090/demo/ballpool.html?diagnostic=1&count=${count}&fgQuality=auto`,
      );
      await page.waitForFunction(
        () => ballPool.snapshot().phase === "static-ready",
        null,
        { timeout: 180000 },
      );
      const row = await page.evaluate(async () => {
        const { captureCurved } = await import("/demo/curved-diagnostics.js");
        const c = captureCurved(ballPool);
        return {
          state: ballPool.snapshot(),
          coverage: c,
          actualBuffer: [
            ballPool.scene.drawingBufferWidth,
            ballPool.scene.drawingBufferHeight,
          ],
          resolutionScale: ballPool.widget.resolutionScale,
          physics: ballPool.physics.metrics(),
        };
      });
      row.count = count;
      row.environment = await environment(page, browser);
      row.status = "passed";
      report.rows.push(row);
      assert.deepEqual(row.actualBuffer, [width, height]);
      assert.equal(row.resolutionScale, 1);
      assert.equal(row.state.fg.samples, 32);
      assert(row.state.resources.peakAdditionalBytes <= 64 * 1048576);
      assert(
        row.state.fg.plan.totalBytes === row.state.fg.totalAdditionalBytes,
      );
      assert(
        row.state.resources.workerCpuBytes > 0 &&
          row.state.resources.physicsWasmReservedBytes > 0,
      );
      if (count <= 64)
        assert(
          row.coverage.meanWeight >= 0.95,
          "desktop supported ball coverage",
        );
      row.qualityStatus = row.coverage.meanWeight >= 0.95 ? "passed" : "failed";
      row.recommended = false;
      await page.screenshot({
        path: `${out}/balls-${count}-${width}x${height}.png`,
      });
      console.log(
        JSON.stringify({
          count,
          buffer: row.actualBuffer,
          receiver: row.state.fg.receiverResolution,
          coverage: row.coverage.meanWeight,
          peak: row.state.resources.peakAdditionalBytes,
        }),
      );
      await page.close();
    }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
} finally {
  await browser.close();
  await writeFile(out + "/desktop.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    rows: report.rows.length,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
