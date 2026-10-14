import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  environment,
  installGlObserver,
} from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/cost-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion(["scripts/benchmark-contact-cache.mjs"]),
    limits: { relativeDDGI: 3, relativeRaw: 1, shadeReduction: 0.3 },
    rows: [],
    updates: [],
    errors: [],
    recommended: false,
  };
report.configuration = {
  count: 64,
  viewport: [1280, 800],
  qualities: (process.env.LUMEN_COST_QUALITIES ?? "auto,interactive16").split(
    ",",
  ),
  activities: (process.env.LUMEN_COST_ACTIVITIES ?? "static,moving").split(","),
  rounds: Number(process.env.LUMEN_COST_ROUNDS ?? 3),
  spacing: 0.08,
  cacheSamples: 256,
  bounces: 3,
  budget: 64 * 1048576,
};
await page.addInitScript(installGlObserver);
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") report.errors.push(m.text());
});
try {
  const start = performance.now();
  await page.goto(
    "http://localhost:8090/demo/ballpool.html?count=64&diagnostic=1",
  );
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  report.environment = await environment(page, browser);
  report.initialization = {
    wallMilliseconds: performance.now() - start,
    world: await page.evaluate(() => structuredClone(ballPool.world.metrics)),
    state: await page.evaluate(() => ballPool.snapshot()),
  };
  await page.evaluate(() => ballPool.setRadianceSource("cache"));
  await page.waitForFunction(
    () =>
      ballPool.world.surfaceCache?.ready &&
      ballPool.world.surfaceCache.metrics.pendingQueries === 0,
    null,
    { timeout: 180000 },
  );
  report.initialCache = await page.evaluate(() => ({
    ...ballPool.world.surfaceCache.metrics,
    resource: ballPool.snapshot().resources,
  }));
  const qualities = (
      process.env.LUMEN_COST_QUALITIES ?? "auto,interactive16"
    ).split(","),
    activities = (process.env.LUMEN_COST_ACTIVITIES ?? "static,moving").split(
      ",",
    );
  for (const quality of qualities)
    for (const activity of activities)
      for (
        let round = 0;
        round < Number(process.env.LUMEN_COST_ROUNDS ?? 3);
        round++
      ) {
        const rows = [];
        const modes =
          round % 2
            ? [
                "cache-reconstructed",
                "cache-raw",
                "instant-reconstructed",
                "instant-raw",
                "fixed-raw",
                "ddgi",
              ]
            : [
                "ddgi",
                "fixed-raw",
                "instant-raw",
                "instant-reconstructed",
                "cache-raw",
                "cache-reconstructed",
              ];
        for (const mode of modes) {
          const row = await page.evaluate(
            async ({ mode, quality, activity, round }) => {
              const d = ballPool,
                s = d.scene,
                f = s.lumen.finalGather,
                { measureFrames } = await import("/demo/benchmark.js");
              await d.setRadianceSource(
                mode.startsWith("cache") ? "cache" : "immediate",
              );
              d.camera("overview");
              await f.configure({
                mode: mode === "ddgi" ? "ddgi" : "fg",
                quality,
                seed: 0,
                sampling:
                  mode === "fixed-raw" ? "fixed-reference" : "reconstructed",
                reconstruction: mode.endsWith("reconstructed"),
                rayOrder: "original",
                execution: "split",
                model: d.model,
              });
              f.continuousSampling = true;
              f.profileForward = false;
              s.requestRenderMode = false;
              for (let i = 0; i < 30; i++)
                await new Promise(requestAnimationFrame);
              const origin = Cesium.Cartesian3.clone(s.camera.position),
                right = Cesium.Cartesian3.clone(s.camera.right),
                inputs = [],
                before = f.metrics.draws;
              const whole = await measureFrames(s, 100, {
                warmup: 20,
                requireFG: mode !== "ddgi",
                beforeFrame(index) {
                  f._sampleEpoch = index;
                  if (activity === "moving")
                    Cesium.Cartesian3.add(
                      origin,
                      Cesium.Cartesian3.multiplyByScalar(
                        right,
                        0.3 * Math.sin(index * 0.04),
                        new Cesium.Cartesian3(),
                      ),
                      s.camera.position,
                    );
                },
                afterFrame({ executed }) {
                  if (executed === 1)
                    inputs.push({
                      epoch: f.metrics.sampleEpoch,
                      seed: f.seed,
                      revision: f.metrics.revision,
                      round: f.metrics.round,
                      receiver: [f.resultSize.x, f.resultSize.y],
                      samples: f.samples,
                      camera: [
                        s.camera.position.x,
                        s.camera.position.y,
                        s.camera.position.z,
                      ],
                    });
                },
              });
              const componentStart = s.frameState.frameNumber;
              f.metrics.completedTimings.length = 0;
              f.profileForward = mode !== "ddgi";
              if (mode !== "ddgi") {
                const started = performance.now();
                while (
                  f.metrics.completedTimings.filter(
                    (t) => t.frame > componentStart && t.fgExecuted,
                  ).length < 60
                ) {
                  await new Promise(requestAnimationFrame);
                  if (performance.now() - started > 30000)
                    throw Error("component window timeout");
                }
              }
              f.profileForward = false;
              const times = f.metrics.completedTimings
                  .filter((t) => t.frame > componentStart && t.fgExecuted)
                  .slice(0, 60),
                keys = [
                  ...new Set(times.flatMap((t) => Object.keys(t.stages))),
                ],
                components = Object.fromEntries(
                  keys.map((k) => [
                    k,
                    times.reduce((a, t) => a + (t.stages[k] ?? 0), 0) /
                      times.length,
                  ]),
                );
              return {
                mode,
                quality,
                activity,
                round,
                whole,
                inputs,
                components,
                draws: f.metrics.draws - before,
                resource: d.snapshot().resources,
                source: d.world.surfaceCache?.metrics,
              };
            },
            { mode, quality, activity, round },
          );
          rows.push(row);
          report.rows.push(row);
          console.log(
            JSON.stringify({
              mode,
              quality,
              activity,
              round,
              gpu: row.whole.gpuMilliseconds.p95,
              cpu: row.whole.cpuMilliseconds.p95,
              components: row.components,
            }),
          );
        }
        const map = Object.fromEntries(rows.map((r) => [r.mode, r])),
          ddgi = map.ddgi.whole.gpuMilliseconds.p95,
          raw = map["fixed-raw"].whole.gpuMilliseconds.p95;
        report.backendPairs ??= [];
        for (const suffix of ["raw", "reconstructed"]) {
          const instant = map["instant-" + suffix],
            cached = map["cache-" + suffix],
            sameSamples =
              JSON.stringify(instant.inputs) === JSON.stringify(cached.inputs);
          report.backendPairs.push({
            quality,
            activity,
            round,
            mode: suffix,
            sameSamples,
            shadeReduction: sameSamples
              ? 1 - cached.components.shade / instant.components.shade
              : null,
            gpuP95Before: instant.whole.gpuMilliseconds.p95,
            gpuP95After: cached.whole.gpuMilliseconds.p95,
            receiver: instant.inputs[0]?.receiver,
            samples: instant.inputs[0]?.samples,
            revision: instant.inputs[0]?.revision,
            roundIdentity: instant.inputs[0]?.round,
          });
        }
        for (const source of ["instant", "cache"]) {
          const D = map[source + "-reconstructed"],
            C = map[source + "-raw"],
            same = JSON.stringify(D.inputs) === JSON.stringify(C.inputs),
            active =
              D.whole.actualFGFrames === 100 &&
              D.whole.gpuMilliseconds.samples === 80 &&
              !D.whole.disjoint &&
              !D.whole.missingQueries &&
              !D.whole.incompleteQueries;
          D.gates = {
            relativeDDGI: D.whole.gpuMilliseconds.p95 - ddgi,
            relativeRaw: D.whole.gpuMilliseconds.p95 - raw,
            sameSamples: same,
            active,
            status:
              active &&
              same &&
              D.whole.gpuMilliseconds.p95 - ddgi <= 3 &&
              D.whole.gpuMilliseconds.p95 - raw <= 1
                ? "passed"
                : "failed",
          };
        }
      }
  // Update costs are explicit cold work; no steady-state window includes them by implication.
  for (const source of ["immediate", "cache"]) {
    await page.evaluate((source) => ballPool.setRadianceSource(source), source);
    const started = performance.now();
    const busyFrames = await page.evaluate(async () => {
      const { measureFrames } = await import("/demo/benchmark.js"),
        start = performance.now(),
        frames = measureFrames(ballPool.scene, 150, {
          warmup: 0,
          requireFG: false,
          minimumMilliseconds: 1000,
        });
      await ballPool.relight({ sunDirection: [1, -1, 0.3] });
      const result = await frames;
      return { ...result, browserWallMilliseconds: performance.now() - start };
    });
    if (source === "cache")
      await page.waitForFunction(
        () => ballPool.world.surfaceCache?.metrics.pendingQueries === 0,
        null,
        { timeout: 10000 },
      );
    const update = await page.evaluate(() => ({
      state: ballPool.snapshot(),
      world: structuredClone(ballPool.world.metrics),
      cache: ballPool.world.surfaceCache?.metrics,
    }));
    report.updates.push({
      type: "relight",
      source,
      wallMilliseconds: performance.now() - started,
      busyFrames,
      gpuScope:
        "frame timestamps exclude between-frame cache submission; cache GPU totals reported separately, no same-source pure-overhead claim",
      ...update,
    });
    const freezeStart = performance.now();
    await page.evaluate(async () => {
      ballPool.step(8);
      ballPool.pause();
      await ballPool.freeze();
    });
    await page.waitForFunction(
      () => ballPool.snapshot().phase === "static-ready",
      null,
      { timeout: 180000 },
    );
    const freeze = await page.evaluate(() => ({
      state: ballPool.snapshot(),
      world: structuredClone(ballPool.world.metrics),
      cache: ballPool.world.surfaceCache?.metrics,
    }));
    report.updates.push({
      type: "freeze-and-converge",
      source,
      wallMilliseconds: performance.now() - freezeStart,
      ...freeze,
    });
  }
  report.gl = await page.evaluate(() => glObserver.snapshot());
} catch (e) {
  report.errors.push(String(e));
  report.lastState = await page
    .evaluate(() => ({
      state: ballPool.snapshot(),
      loop: ballPool.widget.useDefaultRenderLoop,
      domErrors: document.querySelector(".cesium-widget-errorPanel")
        ?.textContent,
      gl: glObserver.snapshot(),
    }))
    .catch(() => null);
  console.error(e);
} finally {
  await browser.close();
}
report.status =
  report.errors.length ||
  report.rows.filter((r) => r.gates).some((r) => r.gates.status !== "passed")
    ? "failed"
    : "passed";
await writeFile(out + "/contact-cost.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
if (report.status !== "passed") process.exitCode = 1;
