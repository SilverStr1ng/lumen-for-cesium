import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const base =
  process.env.LUMEN_FG_REPORT ?? "reports/fg-reconstruction-showcase-v6";
const auto = process.env.LUMEN_FG_AUTO === "1";
const viewport = {
  width: Number(process.env.LUMEN_FG_WIDTH ?? 960),
  height: Number(process.env.LUMEN_FG_HEIGHT ?? 600),
};
const out = base + "/temporal";
await mkdir(out, { recursive: true });
const report = {
  version: sourceVersion(["scripts/verify-fg-temporal.mjs"]),
  configuration: { auto, viewport },
  errors: [],
  steps: [],
  checks: [],
  notRun: [],
};
const b = await launchBrowser(),
  p = await b.newPage({ viewport });
p.on("pageerror", (e) => report.errors.push(String(e)));
await p.addInitScript(installGlObserver);
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=" +
      (auto ? "auto" : "high") +
      "&fgSampling=reconstructed",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.addStyleTag({
    content: "aside,footer,.cesium-widget-credits{display:none!important}",
  });
  await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather;
    d.widget.useDefaultRenderLoop = false;
    d.world.setDisplayTransition(0);
    d.camera("pillarFoot");
    f._historyWorld = undefined;
    f._stableFrames = 0;
    f._sampleEpoch = 0;
    window.tdiag = await import("./fg-reconstruction-diagnostics.js");
    window.oldDiag = await import("./receiver-diagnostics.js");
    window.tickCounts = { render: 0, raf: 0 };
    d.scene.postRender.addEventListener(() => tickCounts.render++);
    window.stepSnapshot = async (name) => {
      const f = d.scene.lumen.finalGather,
        r = f.reconstruction,
        m = f.metrics;
      if (!f.ready || !r)
        return {
          name,
          ready: false,
          status: m.status,
          requested: d.world.requestedRevision,
          historyUsable: false,
          ...tickCounts,
          actualFG: m.frames,
        };
      const a = d.world._read(
          r.history[r._index].framebuffer,
          r.width,
          r.height,
          0,
        ),
        mom = d.world._read(
          r.history[r._index].framebuffer,
          r.width,
          r.height,
          1,
        );
      const lengths = [],
        reasons = {};
      let max = 0,
        min = Infinity,
        nearOne = 0,
        sum = 0,
        valid = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i + 3] > 0.5) {
          max = Math.max(max, a[i + 3]);
          min = Math.min(min, a[i + 3]);
          sum += a[i + 3];
          valid++;
          if (a[i + 3] <= 1.01) nearOne++;
          const reason = String(mom[i + 3]);
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
      // The mean error is measured at current physical local receiver positions.
      const q = tdiag.readReconstruction(d),
        points = [];
      for (let gy = 0; gy < 4; gy++)
        for (let gx = 0; gx < 6; gx++) {
          const x = Math.floor(((gx + 0.5) * q.width) / 6),
            y = Math.floor(((gy + 0.5) * q.height) / 4),
            i = (y * q.width + x) * 4;
          if (q.positions[i + 3] > 0.5 && q.raw[i + 3] > 0.5)
            points.push({
              position: Array.from(q.positions.slice(i, i + 3)),
              normal: Array.from(q.normals.slice(i, i + 3)),
              E: Array.from(q.temporal.slice(i, i + 3)),
            });
        }
      const C = points.length
        ? await d.world.sampleFinalGather(points, { samples: 1024, seed: 5 })
        : [];
      const rmseC = points.length
        ? Math.sqrt(
            points
              .flatMap((p, i) =>
                p.E.map((v, c) => (v - C[i].irradiance[c]) ** 2),
              )
              .reduce((a, b) => a + b, 0) /
              (points.length * 3),
          )
        : null;
      return {
        name,
        ready: true,
        revision: m.revision,
        requested: d.world.requestedRevision,
        round: m.round,
        epoch: m.sampleEpoch,
        passes: m.accumulationPasses,
        valid,
        lengthMean: sum / Math.max(1, valid),
        lengthMax: max,
        lengthMin: min,
        firstHistoryPixels: nearOne,
        reasons,
        rmseC,
        referencePositions: points,
        reference: C,
        ...tickCounts,
        actualFG: m.frames,
        bytes: m.totalAdditionalBytes,
        sourceVersions: m.versions,
      };
    };
  });
  const step = async (name, action) => {
    const data = await p.evaluate(
      async ({ name, action }) => {
        if (action) Function(action)();
        earthLab.widget.render();
        return stepSnapshot(name);
      },
      { name, action },
    );
    report.steps.push(data);
    await p.screenshot({
      path:
        out +
        "/" +
        String(report.steps.length).padStart(2, "0") +
        "-" +
        name +
        ".png",
    });
    console.log(
      JSON.stringify({
        name,
        ready: data.ready,
        length: data.lengthMean,
        passes: data.passes,
        revision: data.revision,
        rmse: data.rmseC,
      }),
    );
    return data;
  };
  await p.evaluate(() => {
    for (let i = 0; i < 31; i++) earthLab.widget.render();
  });
  const stable = await step("static-32");
  for (let i = 0; i < 8; i++)
    await step("slow-pan-" + i, "earthLab.scene.camera.moveRight(.04)");
  for (let i = 0; i < 8; i++) {
    const angle = -Math.PI * 0.7 + i * 0.1;
    await step(
      "around-pillar-" + i,
      "earthLab.metadata.cameras.__move={eye:[-7+3*Math.cos(" +
        angle +
        "),-2+3*Math.sin(" +
        angle +
        '),1.7],target:[-7,-2,.5]};earthLab.camera("__move")',
    );
  }
  await step("doorway-entry", 'earthLab.camera("inside")');
  for (let i = 0; i < 8; i++)
    await step("doorway-reveal-" + i, "earthLab.scene.camera.moveForward(.15)");
  const cut = await step("camera-cut", "earthLab.scene.camera.lookRight(1.6)");
  assert(cut.lengthMax <= 1.01);
  const jump = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather;
    document.getElementById("sun").value = "140";
    document.getElementById("sun").dispatchEvent(new Event("change"));
    d.widget.render();
    const pending = await stepSnapshot("sun-pending");
    const start = performance.now();
    while (!(
      f.ready &&
      f.metrics.revision === d.world.requestedRevision &&
      f.metrics.round === 3
    )) {
      d.widget.render();
      await new Promise(requestAnimationFrame);
      tickCounts.raf++;
      if (performance.now() - start > 180000) throw Error("relight timeout");
    }
    return { pending, first: await stepSnapshot("sun-first-new-input") };
  });
  report.steps.push(jump.pending, jump.first);
  assert.equal(jump.pending.ready, false);
  assert(jump.first.lengthMax <= 1.01);
  for (const angle of [40, 65, 90, 115, 140]) {
    await p.evaluate((angle) => {
      const control = document.getElementById("sun");
      if (![...control.options].some((x) => x.value === String(angle)))
        control.add(new Option("drag " + angle, String(angle)));
      control.value = String(angle);
      control.dispatchEvent(new Event("change"));
      earthLab.widget.render();
    }, angle);
    report.steps.push(
      await p.evaluate((angle) => stepSnapshot("sun-drag-" + angle), angle),
    );
  }
  const dragged = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather,
      start = performance.now();
    while (!(
      f.ready &&
      f.metrics.revision === d.world.requestedRevision &&
      f.metrics.round === 3
    )) {
      d.widget.render();
      await new Promise(requestAnimationFrame);
      tickCounts.raf++;
      if (performance.now() - start > 180000)
        throw Error("drag settle timeout");
    }
    return stepSnapshot("sun-drag-first-new-input");
  });
  report.steps.push(dragged);
  assert(dragged.lengthMax <= 1.01);
  await p.evaluate(() => {
    earthLab.camera("boxFoot");
    for (let i = 0; i < 32; i++) earthLab.widget.render();
  });
  const display = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather,
      hash = await oldDiag.rawHash(d),
      frames = f.metrics.frames;
    const before = await stepSnapshot("display-before");
    d.scene.postProcessStages.exposure = 0.8;
    d.widget.render();
    const changed = await stepSnapshot("display-only");
    d.scene.postProcessStages.exposure = 1;
    return {
      hash,
      afterHash: await oldDiag.rawHash(d),
      frames,
      afterFrames: f.metrics.frames,
      before,
      changed,
    };
  });
  assert.equal(display.hash, display.afterHash);
  assert.equal(display.frames, display.afterFrames);
  report.checks.push({
    name: "display exposure leaves raw solver and converged E untouched",
    status: "passed",
    evidence: display,
  });
  // Real resize and AA changes keep geometry but restart receiver/history ownership.
  await p.setViewportSize({ width: 800, height: 500 });
  const resized = await step("resize", "earthLab.widget.resize()");
  assert(resized.lengthMax <= 1.01);
  await step("AA-change", "earthLab.scene.msaaSamples=4");
  // Fixed override cannot keep self-requesting the same directions.
  const override = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather;
    await f.configure({ sequenceEpoch: 0 });
    d.widget.render();
    const first = await stepSnapshot("override-first"),
      frames = f.metrics.frames;
    for (let i = 0; i < 4; i++) d.widget.render();
    return {
      first,
      after: await stepSnapshot("override-repeat"),
      frames,
      afterFrames: f.metrics.frames,
    };
  });
  assert.equal(override.frames, override.afterFrames);
  assert(override.after.lengthMax <= 1.01);
  report.checks.push({
    name: "fixed epoch adds one information pass and then caches",
    status: "passed",
    evidence: override,
  });
  await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather;
    await f.configure({ sequenceEpoch: null });
    f._historyWorld = undefined;
    f._stableFrames = 0;
    d.scene.requestRenderMode = true;
    d.scene.maximumRenderTimeChange = Infinity;
    d.widget.useDefaultRenderLoop = true;
    d.camera("pillarFoot");
  });
  await p.waitForFunction(
    () => earthLab.scene.lumen.finalGather._stableFrames >= 32,
    null,
    { timeout: 30000 },
  );
  await p.waitForTimeout(400);
  const sleeping = await p.evaluate(() => ({
    FG: earthLab.scene.lumen.finalGather.metrics.frames,
    scene: tickCounts.render,
  }));
  await p.waitForTimeout(350);
  const slept = await p.evaluate(() => ({
    FG: earthLab.scene.lumen.finalGather.metrics.frames,
    scene: tickCounts.render,
  }));
  assert.deepEqual(sleeping, slept);
  await p.evaluate(() => earthLab.scene.camera.moveRight(0.04));
  await p.waitForFunction(
    (old) => earthLab.scene.lumen.finalGather.metrics.frames > old,
    slept.FG,
    { timeout: 5000 },
  );
  const woke = await p.evaluate(() => ({
    FG: earthLab.scene.lumen.finalGather.metrics.frames,
    scene: tickCounts.render,
  }));
  assert(woke.FG > slept.FG);
  report.checks.push({
    name: "on-demand finite accumulation sleeps and camera wakes",
    status: "passed",
    evidence: { sleeping, slept, woke },
  });
  // Material preset reload tests same integer owner IDs in a different world.
  const reloaded = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather,
      old = d.world,
      history = f.reconstruction,
      lease = old.finalGatherSnapshot.retain();
    document.getElementById("preset").value = "presentation";
    document.getElementById("preset").dispatchEvent(new Event("change"));
    d.widget.render();
    let leaseRejected = false;
    try {
      lease.assertAlive();
    } catch (e) {
      leaseRejected = true;
    }
    lease.release();
    const start = performance.now();
    while (!(d.world !== old && d.world?.status === "ready" && f.ready)) {
      d.widget.render();
      await new Promise(requestAnimationFrame);
      tickCounts.raf++;
      if (performance.now() - start > 180000) throw Error("reload timeout");
    }
    d.widget.useDefaultRenderLoop = false;
    return {
      oldDestroyed: old.isDestroyed(),
      historyDestroyed: history.isDestroyed(),
      leaseRejected,
      first: await stepSnapshot("material-world-reload"),
    };
  });
  assert(
    reloaded.oldDestroyed &&
      reloaded.historyDestroyed &&
      reloaded.leaseRejected,
  );
  assert(reloaded.first.lengthMax <= 2.01);
  report.checks.push({
    name: "material/world reload destroys history and leased old input",
    status: "passed",
    evidence: reloaded,
  });
  await p.evaluate(async () => {
    const d = earthLab;
    d.widget.useDefaultRenderLoop = false;
    glObserver.phase("production");
    for (let i = 0; i < 10; i++) d.widget.render();
  });
  report.production = await p.evaluate(() => glObserver.snapshot());
  for (const r of report.production) {
    assert.deepEqual(r.feedback, []);
    assert.deepEqual(r.errors, []);
    for (const key of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
      "queryCollisions",
    ])
      assert.equal(r.phases.production[key] ?? 0, 0);
  }
  report.notRun.push({
    name: "browser background suspension",
    reason:
      "headless browser does not provide a real OS background/foreground transition; visibility-event safety is tested separately",
  });
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(out + "/data.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    steps: report.steps.length,
    checks: report.checks.map((c) => c.name),
    error: report.error,
  }),
);
