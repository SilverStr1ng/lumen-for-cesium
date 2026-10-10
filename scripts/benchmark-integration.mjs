import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  environment,
  sourceVersion,
  demoUrl,
} from "./browser-tools.mjs";
const sponza = process.env.LUMEN_BENCH_SCENE === "sponza",
  repetitions = Number(process.env.LUMEN_REPETITIONS ?? 3);
const report = {
  version: sourceVersion(),
  mode: "no-readback performance; alternating shader arithmetic/LUT with separate adaptation",
  repetitions,
  errors: [],
};
await mkdir("artifacts", { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({
    viewport: { width: sponza ? 960 : 512, height: sponza ? 640 : 384 },
  });
await page.addInitScript(installGlObserver);
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (
    m.type() === "error" ||
    /feedback loop|INVALID_OPERATION|CONTEXT_LOST/.test(m.text())
  )
    report.errors.push(m.text());
});
try {
  if (sponza) {
    const asset =
      new URL(demoUrl("gpu")).searchParams.get("model") ??
      "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf";
    try {
      const response = await fetch(asset, {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      report.status = "not-run";
      report.reason = `Sponza asset unavailable: ${error.message}`;
      throw error;
    }
  }
  await page.goto(
    sponza
      ? demoUrl("gpu", { integrationComparison: "1" })
      : "http://localhost:8090/demo/regression.html?fixture=untextured&integrationComparison=1",
  );
  await page.waitForFunction(
    () => {
      const d = window.lumenTest ?? window.lumenDemo;
      return d?.scene.lumen.world?.status === "ready" || d?.errors.length;
    },
    null,
    { timeout: 240000 },
  );
  assert.deepEqual(
    await page.evaluate(() => (window.lumenTest ?? window.lumenDemo).errors),
    [],
  );
  report.environment = await environment(page, browser);
  report.config = await page.evaluate(() => {
    const d = window.lumenTest ?? window.lumenDemo,
      w = d.scene.lumen.world;
    return {
      options: w.options,
      grid: w.packet.grid,
      integration: w.packet.integration,
      initialStages: w.metrics.initialStages,
      memory: w.metrics.memory,
    };
  });
  report.samples = await page.evaluate(async (repetitions) => {
    const w = (window.lumenTest ?? window.lumenDemo).scene.lumen.world,
      out = [];
    glObserver.phase("performance");
    const run = async (mode) => {
      const start = performance.now(),
        result = await w.solve({
          integrationMode: mode,
          skyRadiance: [0.2, 0.2, 0.2],
        });
      const wall = performance.now() - start;
      for (let i = 0; i < 60 && w._queries.length; i++)
        await new Promise(requestAnimationFrame);
      return { mode, wallMilliseconds: wall, ...structuredClone(result) };
    };
    // Both compiled variants get warmup and scheduler calibration before scored samples.
    for (let i = 0; i < 2; i++)
      for (const mode of ["arithmetic", "lut"]) await run(mode);
    for (let i = 0; i < repetitions; i++)
      for (const mode of i % 2 ? ["lut", "arithmetic"] : ["arithmetic", "lut"])
        out.push(await run(mode));
    return out;
  }, repetitions);
  const summarize = (mode) => {
    const samples = report.samples.filter((x) => x.mode === mode),
      stats = (values) => {
        const sorted = values.toSorted((a, b) => a - b);
        return {
          median: sorted[Math.floor(sorted.length / 2)],
          range: [sorted[0], sorted.at(-1)],
          samples: values.length,
        };
      };
    return {
      wallMilliseconds: stats(samples.map((x) => x.wallMilliseconds)),
      integrateGpuMilliseconds: stats(
        samples.map((x) => x.stages.integrate.gpuMilliseconds),
      ),
      copyGpuMilliseconds: stats(
        samples.map((x) => x.stages.border.gpuMilliseconds),
      ),
      allStagesGpuMilliseconds: stats(
        samples.map((x) =>
          Object.values(x.stages).reduce(
            (sum, s) => sum + s.gpuMilliseconds,
            0,
          ),
        ),
      ),
      timerMissing: samples.reduce(
        (sum, x) =>
          sum + Object.values(x.stages).reduce((n, s) => n + s.timerMissing, 0),
        0,
      ),
    };
  };
  report.summary = {
    arithmetic: summarize("arithmetic"),
    lut: summarize("lut"),
  };
  report.gl = await page.evaluate(() => glObserver.snapshot());
  for (const s of report.gl) {
    const p = s.phases.performance;
    for (const k of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
      "queryCollisions",
    ])
      assert.equal(p[k] ?? 0, 0, k);
    assert.deepEqual(s.feedback, []);
    assert.deepEqual(s.errors, []);
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(JSON.stringify(report.summary, null, 2));
} catch (e) {
  if (report.status !== "not-run") report.status = "failed";
  report.errors.push(String(e));
  process.exitCode = 1;
  console.error(e);
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/integration-performance.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
