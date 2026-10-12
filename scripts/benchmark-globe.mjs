import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, installGlObserver, environment, sourceVersion } from "./browser-tools.mjs";

const report = {
  version: sourceVersion(["demo/globe.js", "fixtures/earth-pavilion.gltf", "fixtures/earth-pavilion.json"]),
  started: new Date().toISOString(),
  mode: "local Earth performance; no diagnostic readbacks or blocking waits",
  errors: [],
};
await mkdir("reports/globe-visibility-v3", { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installGlObserver);
  page.on("pageerror", error => report.errors.push(String(error)));
  const requests = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["blob:", "data:"].includes(url.protocol)) return route.continue();
    if (url.origin !== "http://localhost:8090") {
      requests.push(url.origin); // Never persist authenticated query strings.
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("http://localhost:8090/demo/globe.html");
  await page.waitForFunction(() => window.earthLab?.world?.status === "ready" || window.earthLab?.errors.length, null, { timeout: 180000 });
  assert.deepEqual(await page.evaluate(() => earthLab.errors), []);
  report.environment = await environment(page, browser);
  report.result = await page.evaluate(async () => {
    const d = earthLab, w = d.world;
    const { measureFrames } = await import("/demo/benchmark.js");
    const drain = async () => { for (let i=0;i<120&&w._queries.length;i++) await new Promise(requestAnimationFrame); };
    await drain();
    glObserver.phase("performance");
    d.camera("overview");
    d.scene.lumen.enabled = false;
    const disabled = await measureFrames(d.scene, 90);
    d.scene.lumen.enabled = true;
    const idle = await measureFrames(d.scene, 90);
    const started = performance.now();
    let firstMilliseconds, finalMilliseconds;
    document.getElementById("sun").value = "140";
    document.getElementById("sun").dispatchEvent(new Event("change"));
    const finished = w.completed.then(() => { finalMilliseconds = performance.now() - started; });
    w.firstPublished.then(() => { firstMilliseconds = performance.now() - started; });
    // Do not start a full-frame TIME_ELAPSED query on solve's first frame:
    // status may still be ready until update(), and would hide stage timings.
    const intervals = [];
    let previous;
    for (let i=0;i<90;i++) {
      const time = await new Promise(requestAnimationFrame);
      if (previous !== undefined && i>20) intervals.push(time-previous);
      previous = time;
    }
    const updating = {
      frameIntervals: intervals,
      fps: 1000 / (intervals.reduce((sum,value)=>sum+value,0)/intervals.length),
      gpuScope: "CPU rAF intervals only; world timer queries own GPU elapsed scope",
    };
    await finished;
    await drain();
    const initialMemory = { ...w.metrics.memory }, revision = w.requestedRevision, worker = w.worker;
    const resources = [];
    for (let pass=0;pass<3;pass++) {
      for (const name of ["earth", "overview", "inside", "earth"]) {
        d.camera(name);
        for(let i=0;i<30;i++) await new Promise(requestAnimationFrame);
      }
      resources.push(glObserver.snapshot().map(s => ({ ...s.live })));
    }
    return {
      options: { spacing: w.options.spacing, rays: w.options.rays, bounces: w.options.bounces, targetGpuMilliseconds: w.options.targetGpuMilliseconds },
      probes: w.packet.grid.total, disabled, idle, updating,
      firstPublishedSubmissionMilliseconds: firstMilliseconds,
      finalSubmissionMilliseconds: finalMilliseconds,
      timingScope: "Promise times are CPU submission; timer queries are GPU accumulated work; updating frame window may include settled frames",
      update: w.metrics.updates.at(-1), initialStages: w.metrics.initialStages,
      resources, initialMemory, finalMemory: w.metrics.memory,
      cameraPreservesRevision: revision === w.requestedRevision,
      cameraPreservesWorldAndWorker: d.world === w && w.worker === worker,
      pendingWorkerRequests: w._requests.size,
      pendingGpuQueries: w._queries.length,
      preserveDrawingBuffer: d.scene.context._gl.getContextAttributes().preserveDrawingBuffer,
      gBuffer: d.scene.gBuffer.enabled,
      gl: glObserver.snapshot(),
    };
  });
  assert.deepEqual(requests, [], "page requested no ion or Sponza service");
  assert.equal(report.result.preserveDrawingBuffer, false);
  assert.equal(report.result.gBuffer, false);
  assert.ok(report.result.cameraPreservesRevision);
  assert.ok(report.result.cameraPreservesWorldAndWorker);
  assert.equal(report.result.pendingWorkerRequests, 0);
  assert.equal(report.result.pendingGpuQueries, 0);
  assert.equal(report.result.initialMemory.currentBytes, report.result.finalMemory.currentBytes);
  assert.ok(Number.isFinite(report.result.firstPublishedSubmissionMilliseconds));
  assert.ok(Number.isFinite(report.result.finalSubmissionMilliseconds));
  for (const stage of Object.values(report.result.update.stages)) {
    assert.equal(stage.timerMissing ?? 0, 0, "stage GPU timing must not be lost");
  }
  // Globe imagery warms its own cache; require stable GI ownership, report whole-context counts separately.
  for (const s of report.result.gl) {
    for (const key of ["readPixels", "getBufferSubData", "finish", "waitSync", "blockingClientWaitSync", "queryCollisions"])
      assert.equal(s.phases.performance?.[key] ?? 0, 0, key);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.feedback, []);
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) { report.status = "failed"; report.errors.push(String(error)); process.exitCode = 1; }
finally {
  const stamp = report.started.replaceAll(/[:.]/g, "-");
  await writeFile(`reports/globe-visibility-v3/globe-performance-${stamp}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(report.status);
