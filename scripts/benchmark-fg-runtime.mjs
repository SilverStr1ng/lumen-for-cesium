import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const report = {
  version: sourceVersion(["scripts/benchmark-fg-runtime.mjs"]),
  rounds: [],
  errors: [],
};
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
await p.addInitScript(installGlObserver);
try {
  await p.goto("http://localhost:8090/demo/globe.html");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.device = await p.evaluate(() => {
    const gl = earthLab.scene.context._gl,
      e = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: e
        ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      units: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      timer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    };
  });
  for (let round = 0; round < 3; round++) {
    const order =
      round % 2
        ? ["reconstructed", "decorrelated-raw", "fixed-raw", "ddgi"]
        : ["ddgi", "fixed-raw", "decorrelated-raw", "reconstructed"];
    for (const mode of order) {
      const row = await p.evaluate(
        async ({ round, mode }) => {
          const d = earthLab,
            s = d.scene,
            f = s.lumen.finalGather,
            { measureFrames } = await import("./benchmark.js");
          d.camera("boxFoot");
          d.world.setDisplayTransition(0);
          s.requestRenderMode = false;
          window.glObserver.phase("performance");
          await f.configure({
            mode: mode === "ddgi" ? "ddgi" : "fg",
            quality: "high",
            sampling:
              mode === "fixed-raw" || mode === "ddgi"
                ? "fixed-reference"
                : "reconstructed",
            reconstruction: mode === "reconstructed",
            model: d.model,
          });
          await d.world.completed;
          f.continuousSampling = true;
          f.profileForward = false;
          for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
          let epoch = 0;
          const epochs = [],
            beforeDraws = f.metrics.draws;
          const removeSequence = s.preRender.addEventListener(() => {
            f._sampleEpoch = epoch++;
          });
          const removeEpochLog = s.postRender.addEventListener(() => {
            if (f.ready) epochs.push(f.metrics.sampleEpoch);
          });
          const before = performance.now(),
            whole = await measureFrames(s, 100, {
              warmup: 20,
              requireFG: mode !== "ddgi",
            });
          removeSequence();
          removeEpochLog();
          const fgBefore = f.metrics.frames,
            sceneBefore = s.frameState.frameNumber;
          f.metrics.completedTimings.length = 0;
          f.profileForward = mode !== "ddgi";
          const minFrame = s.frameState.frameNumber + 1,
            start = performance.now();
          if (mode !== "ddgi")
            while (
              f.metrics.completedTimings.filter(
                (x) => x.frame >= minFrame && x.fgExecuted,
              ).length < 60
            ) {
              await new Promise(requestAnimationFrame);
              if (performance.now() - start > 30000)
                throw Error(
                  "complete FG component timer timeout: " +
                    JSON.stringify({
                      pending: f._queries.length,
                      ledger: f._timerFrames.size,
                      completed: f.metrics.completedTimings.length,
                      active: f.metrics.frames - fgBefore,
                      status: f.metrics.status,
                      disjoint: f.metrics.disjoint,
                    }),
                );
            }
          f.profileForward = false;
          const complete = f.metrics.completedTimings
              .filter((x) => x.frame >= minFrame && x.fgExecuted)
              .slice(0, 60),
            keys = [...new Set(complete.flatMap((x) => Object.keys(x.stages)))];
          const means = Object.fromEntries(
            keys.map((k) => [
              k,
              complete.reduce((sum, x) => sum + (x.stages[k] ?? 0), 0) /
                complete.length,
            ]),
          );
          const all = complete
            .map((x) => Object.values(x.stages).reduce((a, b) => a + b, 0))
            .sort((a, b) => a - b);
          return {
            round,
            mode,
            epochs,
            draws: f.metrics.draws - beforeDraws,
            whole,
            components: {
              window: "separate from whole-frame timer",
              completeFrames: complete.length,
              actualFGFrames: f.metrics.frames - fgBefore,
              actualSceneFrames: s.frameState.frameNumber - sceneBefore,
              means,
              combinedP50: all[Math.floor(all.length * 0.5)] ?? null,
              combinedP95: all[Math.floor(all.length * 0.95)] ?? null,
            },
            completeFrameSamples: complete,
            metrics: structuredClone(f.metrics),
            settings: await d.saveView(),
            milliseconds: performance.now() - before,
            readbacks: window.glObserver.snapshot(),
          };
        },
        { round, mode },
      );
      report.rounds.push(row);
      await writeFile(
        "reports/fg-runtime-budget-v7/performance.json",
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          round,
          mode,
          gpu: row.whole.gpuMilliseconds,
          actualFG: row.whole.actualFGFrames,
          means: row.components.means,
        }),
      );
    }
  }
  const meanP95 = (mode) =>
    report.rounds
      .filter((x) => x.mode === mode)
      .reduce((sum, x) => sum + x.whole.gpuMilliseconds.p95, 0) / 3;
  report.targets = {
    additionalReconstructionP95: {
      value: meanP95("reconstructed") - meanP95("fixed-raw"),
      limit: 1,
    },
    sameSequenceReconstructionP95: {
      value: meanP95("reconstructed") - meanP95("decorrelated-raw"),
      scope: "additional ablation; does not replace original product target",
    },
    completeFGP95: {
      value: meanP95("reconstructed") - meanP95("ddgi"),
      limit: 3,
    },
    memory: {
      value: Math.max(
        ...report.rounds.map((x) => x.metrics.totalAdditionalBytes ?? 0),
      ),
      limit: 64 * 1048576,
    },
  };
  report.note =
    "Differences are means of independent-window P95s, not paired per-frame deltas. Component means are not summed percentiles.";
  report.checks = {
    sameSequence: [0, 1, 2].every(
      (round) =>
        JSON.stringify(
          report.rounds.find(
            (r) => r.round === round && r.mode === "decorrelated-raw",
          ).epochs,
        ) ===
        JSON.stringify(
          report.rounds.find(
            (r) => r.round === round && r.mode === "reconstructed",
          ).epochs,
        ),
    ),
    completeQueries: report.rounds.every(
      (x) =>
        x.whole.gpuMilliseconds.samples >= 75 &&
        x.whole.disjoint === 0 &&
        x.whole.incompleteQueries === 0,
    ),
    activeFG: report.rounds
      .filter((x) => x.mode !== "ddgi")
      .every(
        (x) =>
          x.whole.actualFGFrames === x.whole.renderedFrames &&
          x.whole.excludedFallbackFrames === 0,
      ),
    resourceBudget: report.targets.memory.value <= report.targets.memory.limit,
    productionReadback: report.rounds.every(
      (x) =>
        x.metrics.productionReadbacks === 0 &&
        x.readbacks.every(
          (o) =>
            !o.phases.performance?.readPixels &&
            !o.phases.performance?.finish &&
            !o.phases.performance?.blockingClientWaitSync &&
            !o.phases.performance?.getBufferSubData &&
            !o.phases.performance?.waitSync &&
            o.feedback.length === 0 &&
            o.errors.length === 0,
        ),
    ),
    targetReconstruction: report.targets.additionalReconstructionP95.value <= 1,
    targetCompleteFG: report.targets.completeFGP95.value <= 3,
  };
  assert.deepEqual(report.errors, []);
  assert(
    Object.values(report.checks).every(Boolean),
    JSON.stringify(report.checks),
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    "reports/fg-runtime-budget-v7/performance.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    targets: report.targets,
    checks: report.checks,
    error: report.error,
  }),
);
