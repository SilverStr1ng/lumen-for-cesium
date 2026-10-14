await (async function measureOwnedCosts() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { launchBrowser, sourceVersion, environment, installGlObserver } =
    await import("../../../scripts/browser-tools.mjs");
  const script = path
    .relative(process.cwd(), fileURLToPath(import.meta.url))
    .replaceAll("\\", "/");
  const out = path.dirname(fileURLToPath(import.meta.url));
  const output = path.join(out, "owned-costs.json");
  try {
    await fs.access(output);
    throw Error("Existing supplementary evidence is immutable");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const report = {
    version: sourceVersion([
      script,
      "package-lock.json",
      "node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs",
    ]),
    rows: [],
    errors: [],
    renderErrors: [],
  };
  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") report.renderErrors.push(m.text());
  });
  await page.addInitScript(installGlObserver);
  try {
    await page.goto("http://localhost:8090/demo/ballpool.html?count=64");
    await page.waitForFunction(
      () => window.ballPool?.snapshot().phase === "static-ready",
      null,
      { timeout: 180000 },
    );
    report.environment = await environment(page, browser);
    for (const quality of ["auto", "interactive16", "physics-preview"]) {
      const row = await page.evaluate(async (quality) => {
        const d = ballPool,
          s = d.scene,
          f = s.lumen.finalGather;
        const { measureFrames } = await import("/demo/benchmark.js");
        const stats = (values) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            samples: sorted.length,
            mean: values.reduce((sum, v) => sum + v, 0) / values.length,
            p50: sorted[Math.floor(sorted.length * 0.5)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            raw: values,
          };
        };
        if (quality === "physics-preview") {
          d.play();
          d.toss();
        } else {
          await d.configureQuality(quality);
          f.continuousSampling = true;
          f.profileForward = false;
          while (
            !f.ready ||
            f._stableFrames < (f.reconstruction?.targetFrames ?? 32)
          )
            await new Promise(requestAnimationFrame);
        }
        const nativeRender = s.render,
          cpu = [];
        let include = false;
        s.render = function (...args) {
          include = false;
          const start = performance.now(),
            result = nativeRender.apply(this, args);
          if (include) cpu.push(performance.now() - start);
          return result;
        };
        glObserver.phase("performance");
        let whole;
        try {
          whole = await measureFrames(s, 120, {
            warmup: 20,
            minimumMilliseconds: 1000,
            requireFG: quality !== "physics-preview",
            beforeFrame(index) {
              include = index >= 20;
            },
          });
        } finally {
          s.render = nativeRender;
        }
        const beforeDiagnostic = d.snapshot(),
          result = {
            quality,
            whole,
            fullSceneRenderCpu: stats(cpu),
            cpuScope:
              "Scene.render including preUpdate/physics/node synchronization and rendering submission; widget resize/RAF/input work excluded",
            state: beforeDiagnostic,
            physics: d.physics.metrics(),
          };
        if (quality !== "physics-preview") {
          glObserver.phase("diagnostic");
          const { captureCurved } = await import("/demo/curved-diagnostics.js");
          const c = captureCurved(d);
          result.coverage = {
            generation: c.generation,
            revision: c.revision,
            round: c.round,
            epoch: c.epoch,
            receiver: c.receiver,
            samples: c.samples,
            meanWeight: c.meanWeight,
            regions: c.regions,
            rayCounts: c.rayCounts,
          };
        }
        result.gl = glObserver.snapshot();
        return result;
      }, quality);
      report.rows.push(row);
      if (
        !Number.isFinite(row.fullSceneRenderCpu.p95) ||
        !row.fullSceneRenderCpu.samples ||
        row.whole.incompleteQueries ||
        row.whole.disjoint
      )
        throw Error("Invalid supplementary measurement");
      if (
        quality !== "physics-preview" &&
        (row.whole.actualFGFrames !== row.whole.renderedFrames ||
          !row.coverage.rayCounts.actualPrimaryRays)
      )
        throw Error("FG did not stay continuously active");
      console.log(
        JSON.stringify({
          quality,
          gpu: row.whole.gpuMilliseconds.p95,
          fullCpu: row.fullSceneRenderCpu.p95,
          submissionCpu: row.whole.cpuMilliseconds.p95,
          primary: row.coverage?.rayCounts.actualPrimaryRays,
        }),
      );
    }
    if (report.errors.length || report.renderErrors.length)
      throw Error("Unexpected rendering errors");
    await page.evaluate(() => ballPool.dispose());
    report.status = "passed";
    report.scope =
      "Supplementary single windows after mandatory performance suite; actual primary count plus fuller CPU scope. These windows do not replace mandatory three-round P95 gates.";
  } catch (e) {
    report.status = "failed";
    report.error = e.stack;
    process.exitCode = 1;
  } finally {
    await browser.close();
    await fs.writeFile(output, JSON.stringify(report, null, 2));
  }
})();
