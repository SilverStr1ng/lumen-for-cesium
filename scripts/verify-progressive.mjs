import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  environment,
  sourceVersion,
} from "./browser-tools.mjs";
await mkdir("artifacts", { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 512, height: 384 } });
await page.addInitScript(installGlObserver);
const report = {
  version: sourceVersion(),
  mode: "numerical readback and diagnostic nonblocking fences",
  tolerance: { absolute: 2e-4, relative: 1e-3 },
  checks: [],
  errors: [],
};
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (
    m.type() === "error" ||
    /feedback loop|INVALID_OPERATION|CONTEXT_LOST/.test(m.text())
  )
    report.errors.push(m.text());
});
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details });
  assert.ok(passed, name);
  console.log("PASS", name);
};
try {
  await page.goto(
    "http://localhost:8090/demo/regression.html?fixture=untextured&onDemand=1",
  );
  await page.waitForFunction(
    () => lumenTest.world?.status === "ready" || lumenTest.errors.length,
    null,
    { timeout: 120000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
  report.environment = await environment(page, browser);
  const result = await page.evaluate(async (tolerance) => {
    const d = lumenTest,
      w = d.world,
      C = Cesium;
    glObserver.phase("numerical");
    d.scene.lumen.debugMode = 2;
    const point = C.Matrix4.multiplyByPoint(
      d.frame,
      C.Cartesian3.fromArray(d.metadata.receivers[0].position),
      new C.Cartesian3(),
    );
    const pixel = C.SceneTransforms.worldToWindowCoordinates(d.scene, point);
    const hdr = () => {
      const data = w._read(
        d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
        d.scene.drawingBufferWidth,
        d.scene.drawingBufferHeight,
      );
      const offset =
        ((d.scene.drawingBufferHeight - 1 - Math.floor(pixel.y)) *
          d.scene.drawingBufferWidth +
          Math.floor(pixel.x)) *
        4;
      return { data, pixel: Array.from(data.slice(offset, offset + 4)) };
    };
    const compare = (a, b) => {
      let maximum = 0,
        failures = 0;
      for (let i = 0; i < a.length; i++) {
        const error = Math.abs(a[i] - b[i]);
        maximum = Math.max(maximum, error);
        if (error > tolerance.absolute + tolerance.relative * Math.abs(a[i]))
          failures++;
      }
      return { maximum, failures };
    };
    const fence = async () => {
      const gl = d.scene.context._gl,
        sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0),
        started = performance.now();
      gl.flush();
      try {
        for (;;) {
          const status = gl.clientWaitSync(sync, 0, 0);
          if (status === gl.WAIT_FAILED)
            throw new Error("Diagnostic fence failed");
          if (
            status === gl.ALREADY_SIGNALED ||
            status === gl.CONDITION_SATISFIED
          )
            return performance.now() - started;
          if (performance.now() - started > 10000)
            throw new Error("Diagnostic fence timeout");
          await new Promise(requestAnimationFrame);
        }
      } finally {
        gl.deleteSync(sync);
      }
    };
    const options = {
      sunRadiance: [0, 0, 0],
      skyRadiance: [0.8, 0.8, 0.8],
      materialOverrides: [{ id: 1, emissiveFactor: [0, 0, 0] }],
      bounces: 3,
    };
    await w.solve({ ...options, bounces: 1, publicationMode: "snapshot" });
    d.widget.render();
    const single = w.snapshot(),
      singleHdr = hdr();
    await w.solve({
      ...options,
      skyRadiance: [6, 6, 6],
      publicationMode: "snapshot",
    });
    const oldHdr = hdr();
    const events = [],
      frames = [];
    const remove = w.publicationEvent.addEventListener((e) =>
      events.push({ ...e, frameNumber: d.scene.frameState.frameNumber }),
    );
    const removeFrame = d.scene.postRender.addEventListener(() =>
      frames.push({
        revision: w.publishedRevision,
        bounce: w.publishedBounce,
        frameNumber: d.scene.frameState.frameNumber,
      }),
    );
    let completed = false;
    const started = performance.now(),
      p = w.solve({ ...options, publicationMode: "progressive" });
    p.then(() => (completed = true));
    const first = await w.firstPublished,
      state = w.atlasState(),
      field = w.snapshot(),
      firstHdr = hdr(),
      firstTime = performance.now() - started;
    const atFirst = {
      first,
      state,
      completed,
      pointerMatches: w.irradianceTexture === w._atlases[w._published].E,
      E: compare(single.irradiance, field.irradiance),
      HDR: compare(singleHdr.data, firstHdr.data),
      oldPixel: oldHdr.pixel,
      firstPixel: firstHdr.pixel,
      expectedPixel: singleHdr.pixel,
      firstTime,
    };
    atFirst.gpuFenceAfterReadbackMilliseconds = await fence();
    const final = await p,
      finalTime = performance.now() - started;
    const finalFenceAfterSubmissionMilliseconds = await fence();
    const progressive = w.snapshot(),
      progressiveHdr = hdr();
    await w.solve({ ...options, publicationMode: "snapshot" });
    d.widget.render();
    const snapshot = w.snapshot(),
      snapshotHdr = hdr();
    remove();
    removeFrame();
    const monotonic = events.every(
      (e, i) =>
        !i ||
        e.revision > events[i - 1].revision ||
        (e.revision === events[i - 1].revision &&
          e.bounce > events[i - 1].bounce),
    );
    const progressiveFrames = frames.filter(
      (f) => f.revision === first.revision,
    );
    const shownBounces = [...new Set(progressiveFrames.map((f) => f.bounce))];
    return {
      atFirst,
      final,
      finalTime,
      finalFenceAfterSubmissionMilliseconds,
      events,
      shownBounces,
      monotonic,
      finalE: compare(snapshot.irradiance, progressive.irradiance),
      finalM: compare(snapshot.moments, progressive.moments),
      finalHDR: compare(snapshotHdr.data, progressiveHdr.data),
    };
  }, report.tolerance);
  check(
    "first complete round is usable before completed resolves",
    !result.atFirst.completed &&
      result.atFirst.first.bounce === 1 &&
      result.final.bounces === 3 &&
      result.finalTime > result.atFirst.firstTime,
    result,
  );
  check(
    "forward HDR uses the new first-round texture without old-field warm start",
    result.atFirst.pointerMatches &&
      result.atFirst.E.failures === 0 &&
      result.atFirst.HDR.failures === 0 &&
      result.atFirst.firstPixel[0] < result.atFirst.oldPixel[0] * 0.5 &&
      result.atFirst.firstPixel[0] > 0.01,
    result.atFirst,
  );
  check(
    "each completed progressive round is displayed in a distinct frame",
    result.monotonic && [1, 2, 3].every((b) => result.shownBounces.includes(b)),
    { events: result.events, shownBounces: result.shownBounces },
  );
  check(
    "published/read/write ownership refers only to completed reads and separate writes",
    result.atFirst.state.atlases[result.atFirst.state.published].complete &&
      result.atFirst.state.read === result.atFirst.state.published &&
      result.atFirst.state.write !== result.atFirst.state.published,
    result.atFirst.state,
  );
  check(
    "same N-bounce progressive and snapshot E/moments/final HDR agree",
    result.finalE.failures === 0 &&
      result.finalM.failures === 0 &&
      result.finalHDR.failures === 0,
    { E: result.finalE, M: result.finalM, HDR: result.finalHDR },
  );
  report.rounds = result;
  const rapid = await page.evaluate(async () => {
    const d = lumenTest,
      w = d.world,
      events = [],
      rejected = [];
    const remove = w.publicationEvent.addEventListener((e) =>
      events.push({ ...e, at: performance.now() }),
    );
    for (let i = 0; i < 90 && w._queries.length; i++)
      await new Promise(requestAnimationFrame);
    const actualBefore = glObserver.snapshot().map((s) => s.live);
    const before = { ...w.metrics.memory },
      started = performance.now();
    const promises = [];
    for (let i = 0; i < 60; i++) {
      promises.push(
        w
          .solve({
            publicationMode: "progressive",
            maxBatch: 16,
            bounces: 3,
            skyRadiance: [0.1 + i / 100, 0.2, 0.3],
          })
          .catch((e) => rejected.push(String(e))),
      );
      w.firstPublished.catch(() => {});
      await new Promise(requestAnimationFrame);
    }
    const stopped = performance.now(),
      final = await w.completed;
    const finalAfterInputMilliseconds = performance.now() - stopped;
    await Promise.all(promises);
    for (let i = 0; i < 90 && w._queries.length; i++)
      await new Promise(requestAnimationFrame);
    const field = w.snapshot();
    const updates = structuredClone(w.metrics.updates),
      latestRevision = w.revision,
      state = w.atlasState(),
      peak = w.metrics.queryQueuePeak;
    remove();
    const duringInput = events.filter((e) => e.at < stopped).length;
    const counter = w.metrics.submittedBatches;
    const frame = d.scene.frameState.frameNumber;
    for (let i = 0; i < 40; i++) await new Promise(requestAnimationFrame);
    const idle = {
      batches: w.metrics.submittedBatches - counter,
      frames: d.scene.frameState.frameNumber - frame,
    };
    await w.solve({ publicationMode: "snapshot", bounces: 3 });
    const full = w.snapshot();
    for (let i = 0; i < 90 && w._queries.length; i++)
      await new Promise(requestAnimationFrame);
    let difference = 0;
    for (let i = 0; i < full.irradiance.length; i++)
      difference = Math.max(
        difference,
        Math.abs(full.irradiance[i] - field.irradiance[i]),
      );
    return {
      events,
      rejected,
      updates,
      latestRevision,
      state,
      final,
      peak,
      before,
      after: { ...w.metrics.memory },
      duringInput,
      inputMilliseconds: stopped - started,
      finalAfterInputMilliseconds,
      difference,
      idle,
      actualBefore,
      actualAfter: glObserver.snapshot().map((s) => s.live),
      queryQueue: w._queries.length,
      gl: glObserver.snapshot(),
    };
  });
  check(
    "rapid requests publish during input and settle the newest revision",
    rapid.duringInput > 0 &&
      rapid.final.revision === rapid.latestRevision &&
      rapid.state.settledRevision === rapid.latestRevision &&
      rapid.state.publishedBounce === 3 &&
      rapid.difference <= 2e-4,
    rapid,
  );
  check(
    "superseded promises reject and obsolete deeper rounds are skipped",
    rapid.rejected.length > 0 &&
      rapid.rejected.every((e) => e.includes("superseded")) &&
      rapid.updates.some(
        (u) => u.supersededAtRoundBoundary && u.bounces < u.requestedBounces,
      ),
    { rejected: rapid.rejected.length, updates: rapid.updates },
  );
  check(
    "publication versions are monotonic and pending work is bounded",
    rapid.events.every(
      (e, i) =>
        !i ||
        e.revision > rapid.events[i - 1].revision ||
        (e.revision === rapid.events[i - 1].revision &&
          e.bounce > rapid.events[i - 1].bounce),
    ) &&
      rapid.state.pending === undefined &&
      rapid.peak <= 32 &&
      rapid.updates.length <= 100 &&
      rapid.before.currentBytes === rapid.after.currentBytes,
    rapid.state,
  );
  check(
    "on-demand rendering stops GI submissions and frames after settling",
    rapid.idle.batches === 0 && rapid.idle.frames === 0,
    rapid.idle,
  );
  check(
    "actual GL texture/FBO resources remain stable and shader cache does not grow",
    rapid.actualAfter.every(
      (s, i) =>
        ["textures", "framebuffers", "syncs"].every(
          (k) => s[k] === rapid.actualBefore[i][k],
        ) &&
        s.programs <= rapid.actualBefore[i].programs &&
        s.queries === 0,
    ),
    { before: rapid.actualBefore, after: rapid.actualAfter },
  );
  report.rapid = rapid;
  const cleanup = await page.evaluate(async () => {
    const d = lumenTest,
      w = d.world;
    const completed = w
      .solve({ skyRadiance: [0.2, 0.3, 0.4], publicationMode: "progressive" })
      .then(
        () => "resolved",
        (e) => String(e),
      );
    const first = w.firstPublished.then(
      () => "resolved",
      (e) => String(e),
    );
    const reference = w
      .referenceTrace([{ origin: [-3, 0, 1], direction: [1, 0, 0] }])
      .then(
        () => "resolved",
        (e) => String(e),
      );
    w.destroy();
    const destroyed = {
      completed: await completed,
      first: await first,
      reference: await reference,
      memory: { ...w.metrics.memory },
      queries: w._queries.length,
      requests: w._requests.size,
    };
    const failed = d.load({ maxMemoryBytes: 1024 });
    const failure = await Promise.all([
      failed.completed.catch((e) => String(e)),
      failed.firstPublished.catch((e) => String(e)),
    ]);
    const failureCleanup = {
      memory: { ...failed.metrics.memory },
      closed: failed.isDestroyed(),
    };
    const recovered = d.load({ publicationMode: "progressive" });
    await recovered.completed;
    for (let i = 0; i < 90 && recovered._queries.length; i++)
      await new Promise(requestAnimationFrame);
    return {
      destroyed,
      failure,
      failureCleanup,
      recovered: {
        ready: recovered.ready,
        bounce: recovered.publishedBounce,
        settled: recovered.settledRevision,
        memory: recovered.metrics.memory,
      },
      gl: glObserver.snapshot(),
    };
  });
  check(
    "destroy rejects both lighting promises and pending worker requests",
    cleanup.destroyed.completed.includes("destroyed") &&
      cleanup.destroyed.first.includes("destroyed") &&
      cleanup.destroyed.reference.includes("closed") &&
      cleanup.destroyed.memory.currentBytes === 0 &&
      cleanup.destroyed.requests === 0 &&
      cleanup.destroyed.queries === 0,
    cleanup.destroyed,
  );
  check(
    "initialization failure rejects preview/final and releases resources",
    cleanup.failure.every(
      (e) => typeof e === "string" && e.includes("budget"),
    ) &&
      cleanup.failureCleanup.closed &&
      cleanup.failureCleanup.memory.currentBytes === 0,
    cleanup.failure,
  );
  check(
    "reload restores all rounds without GL feedback, errors or blocking waits",
    cleanup.recovered.ready &&
      cleanup.recovered.bounce === 3 &&
      cleanup.gl.every(
        (s) =>
          s.feedback.length === 0 &&
          s.errors.length === 0 &&
          !s.phases.numerical?.blockingClientWaitSync,
      ),
    cleanup,
  );
  report.cleanup = cleanup;
  // The budget rejection above is deliberately induced; it is the only accepted fixture error.
  const errors = await page.evaluate(() => lumenTest.errors);
  check(
    "no unexpected render/worker/browser errors",
    report.errors.length === 0 && errors.every((e) => e.includes("budget")),
    { browser: report.errors, fixture: errors },
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/progressive-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
