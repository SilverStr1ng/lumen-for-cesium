import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
  environment,
} from "./browser-tools.mjs";
import { installGpuAllocationObserver } from "./gpu-allocation-tools.mjs";
const out = "reports/receiver-final-gather-v5";
await mkdir(out, { recursive: true });
const report = {
  started: new Date().toISOString(),
  version: sourceVersion([
    "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenReceiverPass.js",
    "cesium-1.146/packages/engine/Source/Scene/Scene.js",
    "demo/globe.js",
  ]),
  errors: [],
  cases: [],
  mode: "production GL observation and nonblocking GPU timers; no synchronous reads",
};
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => report.errors.push(String(e)));
await page.addInitScript(installGlObserver);
await page.addInitScript(installGpuAllocationObserver);
try {
  for (const preset of ["regression", "presentation"]) {
    await page.goto("http://localhost:8090/demo/globe.html?preset=" + preset);
    await page.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    await page.evaluate(() => earthLab.camera("boxFoot"));
    await page.waitForFunction(() => earthLab.scene.globe.tilesLoaded);
    await page.waitForTimeout(250);
    report.environment = await environment(page, browser);
    for (const quality of [
      "ddgi",
      "fast",
      "balanced",
      "high",
      ...(preset === "regression" ? ["roi"] : []),
    ]) {
      const data = await page.evaluate(async (quality) => {
        const d = earthLab,
          s = d.scene,
          w = d.world,
          fg = s.lumen.finalGather,
          { measureFrames } = await import("./benchmark.js");
        await fg.configure({
          mode: quality === "ddgi" ? "ddgi" : "fg",
          quality: quality === "ddgi" ? "balanced" : quality,
          model: d.model,
        });
        const drain = async () => {
          for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
        };
        await drain();
        glObserver.phase("performance");
        fg.profileForward = true;
        fg.metrics.stages = {};
        // Stage samples are collected in a separate window from whole-frame timers.
        for (let i = 0; i < 70; i++) await new Promise(requestAnimationFrame);
        await drain();
        fg.profileForward = false;
        const stages = structuredClone(fg.metrics.stages),
          metrics = { ...fg.metrics, stages: undefined },
          allocation = gpuAllocationEstimate();
        const frame = await measureFrames(s, 110);
        let noComposite;
        if (quality !== "ddgi") {
          fg._compositeEnabled = false;
          fg.profileForward = true;
          fg.metrics.stages = {};
          for (let i = 0; i < 70; i++) await new Promise(requestAnimationFrame);
          await drain();
          noComposite = structuredClone(fg.metrics.stages);
          fg.profileForward = false;
          fg._compositeEnabled = true;
        }
        return {
          quality,
          stages,
          noComposite,
          frame,
          metrics,
          allocation,
          gl: glObserver.snapshot(),
          settings: {
            msaa: s.msaaSamples,
            actualHdrSamples:
              s._view.sceneFramebuffer._colorFramebuffer.numSamples,
            shadowNormalOffset: s.shadowMap.normalOffset,
            exposure: s.postProcessStages.exposure,
            grid: {
              spacing: w.spacing,
              probes: w.packet.grid.total,
              rays: w.options.rays,
              bounces: w.options.bounces,
            },
            iblReady: !!d.model.environmentMapManager.radianceCubeMap,
          },
          worldBytes: w.memoryBytes,
        };
      }, quality);
      const stats = (a) => {
        const b = a.toSorted((x, y) => x - y);
        return {
          samples: a.length,
          mean: a.length ? a.reduce((s, v) => s + v, 0) / a.length : null,
          p50: b[Math.floor(b.length * 0.5)] ?? null,
          p95: b[Math.floor(b.length * 0.95)] ?? null,
        };
      };
      const aggregate = (stages) =>
        Object.fromEntries(
          Object.entries(stages ?? {}).map(([name, records]) => {
            const frames = new Map();
            for (const r of records)
              frames.set(r.frame, (frames.get(r.frame) ?? 0) + r.milliseconds);
            return [name, stats([...frames.values()].slice(12))];
          }),
        );
      data.stageStatistics = aggregate(data.stages);
      data.noCompositeStatistics = aggregate(data.noComposite);
      report.cases.push({ preset, ...data });
      console.log(
        preset,
        quality,
        JSON.stringify({
          gpu: data.frame.gpuMilliseconds,
          stages: data.stageStatistics,
          bytes: data.metrics.totalAdditionalBytes,
        }),
      );
      await writeFile(
        out + "/performance.json",
        JSON.stringify(report, null, 2),
      );
    }
    // Scene+environment and world solve change together; timestamp pairs are used when available.
    const relight = await page.evaluate(async () => {
      const d = earthLab,
        w = d.world,
        s = d.scene,
        fg = s.lumen.finalGather,
        { measureFrames } = await import("./benchmark.js");
      await fg.configure({ mode: "fg", quality: "balanced", model: d.model });
      const samples = measureFrames(s, 150),
        start = performance.now();
      document.getElementById("sun").value = "140";
      document.getElementById("sun").dispatchEvent(new Event("change"));
      await w.completed;
      const completion = performance.now() - start;
      for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
      return {
        frame: await samples,
        completionSubmissionMilliseconds: completion,
        update: w.metrics.updates.at(-1),
        iblReady: !!d.model.environmentMapManager.radianceCubeMap,
        scope:
          "real Scene direct + IBL controller + same world sun solve; idle-only timer cannot measure busy solver frames without timestamps",
      };
    });
    report.cases.push({ preset, relight });
  }
  for (const c of report.cases)
    for (const o of c.gl ?? []) {
      assert.deepEqual(o.feedback, []);
      assert.deepEqual(o.errors, []);
      for (const key of [
        "readPixels",
        "getBufferSubData",
        "finish",
        "waitSync",
        "blockingClientWaitSync",
        "queryCollisions",
      ])
        assert.equal(o.phases.performance?.[key] ?? 0, 0);
    }
  report.acceptance = report.cases
    .filter((x) => x.frame)
    .map((c) => {
      const base = report.cases.find(
          (x) => x.preset === c.preset && x.quality === "ddgi",
        ),
        incremental =
          c.frame.gpuMilliseconds.p95 - base.frame.gpuMilliseconds.p95;
      return {
        preset: c.preset,
        quality: c.quality,
        incrementalGpuP95: incremental,
        gpu: c.frame.gpuMilliseconds.samples
          ? incremental <= 3
            ? "passed"
            : "failed"
          : "not-run",
        memory:
          c.quality === "ddgi" || c.metrics.totalAdditionalBytes <= 64 * 1048576
            ? "passed"
            : "failed",
        threshold: { incrementalGpuP95: 3, additionalBytes: 64 * 1048576 },
      };
    });
  report.status = "executed";
} catch (e) {
  report.errors.push(e.stack ?? String(e));
  report.status = "failed";
  process.exitCode = 1;
} finally {
  await browser.close();
  report.finished = new Date().toISOString();
  await writeFile(out + "/performance.json", JSON.stringify(report, null, 2));
}
