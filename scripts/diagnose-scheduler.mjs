import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, installGlObserver, environment, sourceVersion, demoUrl } from "./browser-tools.mjs";

const report = { startedAt: new Date().toISOString(), version: sourceVersion(["scripts/diagnose-scheduler.mjs"]), scope: "Separate scheduler instrumentation, not a performance trial. Proxy reads observe the unchanged scheduler; no readback or blocking waits.", errors: [] };
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  await page.addInitScript(installGlObserver);
  page.on("pageerror", error => report.errors.push(String(error)));
  await page.goto(demoUrl("gpu", "publication=progressive"));
  await page.waitForFunction(() => lumenDemo.scene.lumen.world?.status === "ready", null, { timeout: 180000 });
  report.environment = await environment(page, browser);
  report.result = await page.evaluate(async () => {
    const scene = lumenDemo.scene;
    const w = scene.lumen.loadWorld({ ...scene.lumen.world.options });
    const originalUpdate = w.update, originalCosts = w._costs;
    const samples = [];
    let current, sequence = "initialization";
    w._costs = new Proxy(originalCosts, {
      get(target, key) {
        const value = Reflect.get(target, key);
        // update() polls queries before submitting. Once a batch has been
        // submitted, a missing estimate makes its next loop iteration break.
        // Thus this observes the precise initial-estimate deferral branch.
        if (current && typeof key === "string" && !value && w.metrics.submittedBatches > current.startBatches) current.estimateDeferrals.push(key);
        return value;
      },
    });
    w.update = function (...args) {
      current = { sequence, frame: scene.frameState.frameNumber, phase: this._phase, startBatches: this.metrics.submittedBatches, queueBefore: this._queries.length, estimateDeferrals: [] };
      try { return originalUpdate.apply(this, args); }
      finally {
        current.submittedBatches = this.metrics.submittedBatches - current.startBatches;
        current.queueAfter = this._queries.length;
        current.phaseAfter = this._phase;
        if (current.phase !== "ready" || current.queueBefore || current.submittedBatches) samples.push(current);
        current = undefined;
      }
    };
    try {
      await w.completed;
      for (let i=0;i<120 && w._queries.length;i++) await new Promise(requestAnimationFrame);
      const initial = structuredClone(w.metrics.initialStages);
      sequence = "direction-update";
      await w.solve({ sunDirection: [0.8, 0.2, 0.6] });
      for (let i=0;i<120 && w._queries.length;i++) await new Promise(requestAnimationFrame);
      return {
        options: { rays: w.options.rays, bounces: w.options.bounces, spacing: w.options.spacing, targetGpuMilliseconds: w.options.targetGpuMilliseconds, bvhStrategy: w.options.bvhStrategy, visibilityMode: w.options.visibilityMode },
        probes: w.packet.grid.total, samples, initialStages: initial, update: structuredClone(w.metrics.updates.at(-1)), queryQueuePeak: w.metrics.queryQueuePeak, queryQueueFinal: w._queries.length,
        estimateDeferrals: Object.fromEntries(["initialization", "direction-update"].map(name => [name, { frames: samples.filter(s => s.sequence === name && s.estimateDeferrals.length).length, byStage: Object.fromEntries([...new Set(samples.filter(s => s.sequence === name).flatMap(s => s.estimateDeferrals))].map(stage => [stage, samples.filter(s => s.sequence === name).reduce((sum,s) => sum+s.estimateDeferrals.filter(k => k===stage).length,0)])) }])),
        note: "A deferral ends submission for that frame after at least one batch because the next stage has no asynchronous GPU cost estimate. It is not a blocked GPU/CPU wait. Warm direction updates can have zero such deferrals. Diagnostic wrapping overhead excludes this run from speed claims.",
      };
    } finally { w.update = originalUpdate; w._costs = originalCosts; }
  });
  report.gl = await page.evaluate(() => glObserver.snapshot());
  assert.equal(report.result.queryQueueFinal, 0);
  assert.equal(report.result.probes, 1836);
  for (const state of report.gl) {
    assert.deepEqual(state.errors, []); assert.deepEqual(state.feedback, []);
    for (const phase of Object.values(state.phases)) for (const key of ["readPixels", "finish", "waitSync", "blockingClientWaitSync"]) assert.equal(phase[key] ?? 0, 0);
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) { report.status = "failed"; report.errors.push(String(error)); process.exitCode = 1; }
finally {
  await mkdir("reports/globe-visibility-v3", { recursive: true });
  const raw = JSON.stringify(report,null,2);
  await writeFile(`reports/globe-visibility-v3/scheduler-${report.startedAt.replaceAll(/[:.]/g,"-")}.json`,raw);
  await writeFile("reports/globe-visibility-v3/scheduler.json",raw);
  await browser.close();
}
console.log(report.status);
