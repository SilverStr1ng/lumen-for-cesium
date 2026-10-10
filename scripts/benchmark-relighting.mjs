import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  launchBrowser,
  installGlObserver,
  environment,
  sourceVersion,
} from "./browser-tools.mjs";

const asset =
  process.env.LUMEN_ASSET_URL ??
  "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf";
const sponza = process.env.LUMEN_BENCH_SCENE === "sponza";
const repetitions = Number(process.env.LUMEN_REPETITIONS ?? 3);
const publicationMode = process.env.LUMEN_PUBLICATION_MODE ?? "snapshot";
const report = {
  version: sourceVersion(),
  schema: 2,
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  date: new Date().toISOString(),
  mode: "performance: no synchronous texture readback or blocking waits",
  scene: sponza ? asset : "fixtures/untextured.gltf",
  repetitions,
  publicationMode,
  errors: [],
  updates: {},
};
await mkdir("artifacts", { recursive: true });
let browser;
try {
  if (sponza)
    try {
      const r = await fetch(asset, {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      report.status = "not-run";
      report.reason = `Sponza asset unavailable: ${e.message}`;
      console.log(report.reason);
      throw e;
    }
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: sponza ? 960 : 512, height: sponza ? 640 : 384 },
  });
  await page.addInitScript(installGlObserver);
  let rejectStartup;
  const startupFailure = new Promise((resolve, reject) => {
    rejectStartup = reject;
  });
  startupFailure.catch(() => {});
  page.on("pageerror", (e) => {
    report.errors.push(String(e));
    rejectStartup(e);
  });
  page.on("console", (m) => {
    if (
      m.type() === "error" ||
      /feedback loop|INVALID_OPERATION|CONTEXT_LOST/.test(m.text())
    ) {
      report.errors.push(m.text());
      rejectStartup(new Error(m.text()));
    }
  });
  const start = Date.now();
  await page.goto(
    sponza
      ? `http://localhost:8090/demo/index.html?backend=gpu&publication=${publicationMode}&model=${encodeURIComponent(asset)}`
      : `http://localhost:8090/demo/regression.html?fixture=untextured&publication=${publicationMode}`,
  );
  const monitor = setInterval(async () => {
    try {
      console.log(
        "startup",
        JSON.stringify(
          await page.evaluate(() => {
            const w = (window.lumenTest ?? window.lumenDemo)?.scene.lumen.world;
            return {
              status: w?.status,
              progress: w?.progress,
              batches: w?.metrics.submittedBatches,
              stages: w?.metrics.initialStages,
              error: w?.error,
            };
          }),
        ),
      );
    } catch {}
  }, 30000);
  try {
    await Promise.race([
      startupFailure,
      page.waitForFunction(
        () => {
          const d = window.lumenTest ?? window.lumenDemo;
          return d?.scene.lumen.world?.status === "ready" || d?.errors.length;
        },
        null,
        { timeout: Number(process.env.LUMEN_STARTUP_TIMEOUT ?? 600000) },
      ),
    ]);
  } finally {
    clearInterval(monitor);
  }
  assert.deepEqual(
    await page.evaluate(() => (window.lumenTest ?? window.lumenDemo).errors),
    [],
  );
  report.initializationWallMilliseconds = Date.now() - start;
  console.log("initialization", report.initializationWallMilliseconds);
  report.environment = await environment(page, browser);
  report.config = await page.evaluate(() => {
    const d = window.lumenTest ?? window.lumenDemo,
      w = d.scene.lumen.world;
    return {
      options: w.options,
      grid: w.packet.grid,
      triangles: w.packet.bvh.triangles,
      bvhNodes: w.packet.bvh.nodes,
      camera: {
        position: Array.from(
          Cesium.Cartesian3.pack(d.scene.camera.positionWC, []),
        ),
        direction: Array.from(
          Cesium.Cartesian3.pack(d.scene.camera.directionWC, []),
        ),
        up: Array.from(Cesium.Cartesian3.pack(d.scene.camera.upWC, [])),
        fov: d.scene.camera.frustum.fov,
      },
      memory: w.metrics.memory,
      integration: w.packet.integration,
      initialStages: w.metrics.initialStages,
    };
  });
  await page.evaluate(async () => {
    const d = window.lumenTest ?? window.lumenDemo;
    window.measureFrames = (await import("/demo/benchmark.js")).measureFrames;
    window.applyBenchmarkLighting = (options) => {
      const o = { ...d.scene.lumen.world.options, ...options },
        C = Cesium;
      const direction = C.Cartesian3.normalize(
        C.Cartesian3.fromArray(o.sunDirection),
        new C.Cartesian3(),
      );
      C.Cartesian3.negate(direction, direction);
      C.Matrix3.multiplyByVector(
        C.Matrix4.getMatrix3(d.frame, new C.Matrix3()),
        direction,
        direction,
      );
      d.scene.light = new C.DirectionalLight({
        direction,
        color: new C.Color(...o.sunRadiance),
        intensity: 1,
      });
      d.scene.requestRender();
    };
    glObserver.phase("performance");
    d.scene.gBuffer.enabled = false;
  });
  report.display = await page.evaluate(async () => {
    const d = window.lumenTest ?? window.lumenDemo;
    d.scene.lumen.enabled = false;
    const disabled = await measureFrames(d.scene, 100);
    d.scene.lumen.enabled = true;
    const idle = await measureFrames(d.scene, 100);
    return { disabled, idle };
  });
  for (const category of [
    "warm",
    "skyOnly",
    "sunIntensityOnly",
    "sunDirection",
  ]) {
    report.updates[category] = await page.evaluate(
      async ({ category, repetitions }) => {
        const w = (window.lumenTest ?? window.lumenDemo).scene.lumen.world;
        const original = {
          sunDirection: [...w.options.sunDirection],
          sunRadiance: [...w.options.sunRadiance],
          skyRadiance: [...w.options.skyRadiance],
          bounces: w.options.bounces,
        };
        const out = [];
        for (let i = 0; i < repetitions; i++) {
          const options =
            category === "warm"
              ? original
              : category === "skyOnly"
                ? {
                    skyRadiance: original.skyRadiance.map(
                      (v) => v * (i % 2 ? 1 : 1.25),
                    ),
                  }
                : category === "sunIntensityOnly"
                  ? {
                      sunRadiance: original.sunRadiance.map(
                        (v) => v * (i % 2 ? 1 : 1.25),
                      ),
                    }
                  : { sunDirection: i % 2 ? [1, 0, 0.65] : [-1, 0, 0.65] };
          applyBenchmarkLighting(options);
          const started = performance.now(),
            p = w.solve(options);
          let preview = null;
          while (w.status !== "ready") {
            await new Promise(requestAnimationFrame);
            if (preview === null && w.packet.revision === w.revision)
              preview = performance.now() - started;
          }
          const result = await p;
          const wall = performance.now() - started;
          for (let f = 0; f < 60 && w._queries.length; f++)
            await new Promise(requestAnimationFrame);
          out.push({
            ...result,
            callToFinalSubmissionMilliseconds: wall,
            observedPreviewSubmissionMilliseconds: preview,
            metrics: structuredClone(w.metrics.updates.at(-1)),
            memory: { ...w.metrics.memory },
            queryQueue: w._queries.length,
            requestedLighting: options,
          });
        }
        return out;
      },
      { category, repetitions },
    );
    console.log(
      category,
      JSON.stringify(
        report.updates[category].map(
          (x) => x.callToFinalSubmissionMilliseconds,
        ),
      ),
    );
  }
  report.display.changing = await page.evaluate(async () => {
    const d = window.lumenTest ?? window.lumenDemo,
      w = d.scene.lumen.world;
    let changes = 0;
    const timer = setInterval(() => {
      changes++;
      const options = {
        sunDirection: [
          Math.cos(changes * 0.13),
          Math.sin(changes * 0.13),
          0.65,
        ],
      };
      applyBenchmarkLighting(options);
      w.solve(options).catch(() => {});
    }, 200);
    const frames = await measureFrames(d.scene, 150);
    clearInterval(timer);
    const stop = performance.now();
    await w.completed;
    for (let f = 0; f < 60 && w._queries.length; f++)
      await new Promise(requestAnimationFrame);
    return {
      ...frames,
      changes,
      latestFinalSubmissionAfterInputStoppedMilliseconds:
        performance.now() - stop,
    };
  });
  report.metrics = await page.evaluate(
    () => (window.lumenTest ?? window.lumenDemo).scene.lumen.world.metrics,
  );
  report.gl = await page.evaluate(() => glObserver.snapshot());
  for (const s of report.gl) {
    const p = s.phases.performance ?? {};
    for (const name of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
      "queryCollisions",
    ])
      assert.equal(p[name] ?? 0, 0, `Actual GL ${name}`);
    assert.deepEqual(s.feedback, []);
    assert.deepEqual(s.errors, []);
  }
  assert.deepEqual(report.errors, []);
  assert.equal(report.metrics.disjoint, 0);
  assert.ok(
    Object.values(report.display).every(
      (x) => x.visibility === "visible" && x.buffer.every((v) => v > 0),
    ),
  );
  report.status = "passed";
} catch (e) {
  if (report.status !== "not-run") {
    report.status = "failed";
    report.errors.push(String(e));
  }
  process.exitCode = 1;
  console.error(e);
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/relighting-performance.json",
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
}
