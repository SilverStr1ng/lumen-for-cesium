import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../cesium-1.146/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const executablePath = [
  process.env.LUMEN_CHROME,
  chromium.executablePath(),
  "C:/Users/rakuy/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true }),
  page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const fast = process.env.LUMEN_FAST === "1";
const url =
  "http://localhost:8090/demo/index.html?backend=gpu" +
  (fast ? "&spacing=3&rays=64&gpuBudget=6&shadowSize=1024&scale=0.5" : "");
const report = {
    url,
    configuration: {
      spacing: fast ? 3 : 2,
      rays: fast ? 64 : 128,
      bounces: 3,
      gpuBudgetMs: fast ? 6 : 3,
      shadowSize: fast ? 1024 : 2048,
      scale: fast ? 0.5 : 1,
    },
    performance: {},
  },
  errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
try {
  const start = Date.now();
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.lumenDemo?.scene.lumen.world?.ready ||
      window.lumenDemo?.errors.length,
    null,
    { timeout: 180000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenDemo.errors), []);
  report.startupMilliseconds = Date.now() - start;
  await page.evaluate(async () => {
    window.measureFrames = (await import("/demo/benchmark.js")).measureFrames;
  });
  report.renderer = await page.evaluate(() => {
    const gl = lumenDemo.scene.context._gl,
      e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  await page.evaluate(() => {
    lumenDemo.scene.lumen.enabled = false;
  });
  report.performance.giDisabled = await page.evaluate(() =>
    measureFrames(lumenDemo.scene, 100),
  );
  console.log("BASELINE", JSON.stringify(report.performance.giDisabled));
  await page.evaluate(() => {
    lumenDemo.scene.lumen.enabled = true;
  });
  report.performance.giStatic = await page.evaluate(() =>
    measureFrames(lumenDemo.scene, 100),
  );
  console.log("GI", JSON.stringify(report.performance.giStatic));
  report.lightSteps = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      out = [];
    for (const sunDirection of [
      [1, 0, 0.65],
      [-1, 0, 0.65],
    ]) {
      const start = performance.now();
      await w.solve({ sunDirection });
      out.push({ sunDirection, milliseconds: performance.now() - start });
    }
    return out;
  });
  console.log("STEP", JSON.stringify(report.lightSteps));
  report.performance.giChanging = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      startUpdates = w.metrics.updates.length;
    let changes = 0;
    const timer = setInterval(() => {
      changes++;
      w.solve({
        sunDirection: [
          Math.cos(changes * 0.13),
          Math.sin(changes * 0.13),
          0.65,
        ],
      }).catch(() => {});
    }, 200);
    const result = await measureFrames(lumenDemo.scene, 150);
    clearInterval(timer);
    const started = performance.now();
    await w.completed;
    return {
      ...result,
      changes,
      latestSettleMilliseconds: performance.now() - started,
      updates: w.metrics.updates.slice(startUpdates),
    };
  });
  console.log("CHANGING", JSON.stringify(report.performance.giChanging));
  if (!fast) {
    await page.evaluate(() => {
      lumenDemo.scene.shadowMap.size = 1024;
    });
    report.performance.giShadow1024 = await page.evaluate(() =>
      measureFrames(lumenDemo.scene, 100),
    );
    await page.evaluate(() => {
      lumenDemo.widget.resolutionScale = 0.5;
    });
    report.performance.giHalfResolution = await page.evaluate(() =>
      measureFrames(lumenDemo.scene, 100),
    );
  }
  report.metrics = await page.evaluate(
    () => lumenDemo.scene.lumen.world.metrics,
  );
  assert.ok(
    Object.values(report.performance).every(
      (p) =>
        p.visibility === "visible" &&
        p.buffer[0] > 0 &&
        p.frameMilliseconds.samples > 50 &&
        p.disjoint === 0,
    ),
  );
  assert.equal(report.metrics.disjoint, 0);
  assert.equal(report.metrics.productionReadbacks, 0);
  assert.deepEqual(errors, []);
  report.errors = errors;
} finally {
  await writeFile(
    fast
      ? "artifacts/gpu-fast-performance.json"
      : "artifacts/gpu-performance.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
