import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { newOutput, pilotBase } from "./pilot-validation.mjs";
const output = await newOutput("shader-smoke"),
  report = {
    version: sourceVersion(["scripts/verify-pilot-shader-smoke.mjs"]),
    scope:
      "Gallery/Ball Pool shared shader path only; not their full historical quality/performance matrices",
    rows: [],
    errors: [],
    status: "not-run",
  };
let browser;
try {
  browser = await launchBrowser();
  for (const name of ["gallery", "ballpool"]) {
    console.log("Shader smoke " + name);
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    await page.goto(
      pilotBase() +
        `${name}.html?nativeBuffer=1&fg=fg&fgQuality=auto&fgSampling=reconstructed`,
    );
    await page.waitForFunction(
      () => {
        const d = window.earthLab,
          w = d?.world,
          f = d?.scene?.lumen.finalGather;
        return (
          w?.ready &&
          w.publishedBounce === 3 &&
          f?._sampleWorld === w &&
          f.metrics.effectiveMode === "fg" &&
          f.metrics.history &&
          f.metrics.stablePasses >= 32 &&
          f.metrics.round === 3 &&
          f.metrics.revision === w.requestedRevision &&
          (d.scene.context._lastShaderPreparationPending ?? 0) === 0
        );
      },
      null,
      { timeout: 180000 },
    );
    const row = await page.evaluate(() => {
      const d = earthLab,
        f = d.scene.lumen.finalGather;
      return {
        buffer: [d.scene.drawingBufferWidth, d.scene.drawingBufferHeight],
        revision: d.world.requestedRevision,
        round: d.world.publishedBounce,
        models: f.models.size,
        fg: { ...f.metrics, completedTimings: undefined, stages: undefined },
        options: d.world.options,
      };
    });
    row.name = name;
    assert(row.fg.effectiveMode === "fg" && row.fg.history);
    assert(row.fg.totalAdditionalBytes <= 67108864);
    await page.screenshot({ path: `${output}/${name}.png` });
    row.passed = true;
    report.rows.push(row);
    await page.close();
  }
} catch (error) {
  report.errors.push(String(error));
  console.error(error);
} finally {
  await browser?.close();
}
report.status =
  report.rows.length === 2 &&
  report.rows.every((r) => r.passed) &&
  !report.errors.length
    ? "passed"
    : "failed";
await writeFile(
  `${output}/shader-smoke.json`,
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({ output, status: report.status, errors: report.errors }),
);
if (report.status !== "passed") process.exitCode = 1;
