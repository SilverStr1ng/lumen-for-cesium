import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { sampleSequenceMatches } from "./r8-acceptance.mjs";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const execution =
  process.argv.find((a) => a.startsWith("--execution="))?.split("=")[1] ??
  "split";
const rayOrder = process.argv.includes("--azimuth") ? "azimuth" : "original";
const rayLayout = process.argv.includes("--planar") ? "planar" : "interleaved";
const lazyFallback = process.argv.includes("--lazy");
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith("--" + name + "="))?.split("=")[1] ??
  fallback;
const sceneName = arg("scene", "original"),
  quality = arg("quality", "high"),
  activity = arg("activity", "static");
const viewport = {
  width: Number(arg("width", 1280)),
  height: Number(arg("height", 800)),
};
const suffix =
  sceneName === "original" &&
  quality === "high" &&
  activity === "static" &&
  viewport.width === 1280 &&
  viewport.height === 800
    ? ""
    : "-" +
      sceneName +
      "-" +
      viewport.width +
      "x" +
      viewport.height +
      "-" +
      quality +
      "-" +
      activity;
const reportDirectory =
  process.env.LUMEN_REPORT_DIRECTORY ?? "reports/fg-runtime-budget-v7/latest";
await mkdir(reportDirectory, { recursive: true });
const reportFile =
  reportDirectory +
  "/performance-" +
  execution +
  (rayOrder === "azimuth" ? "-azimuth" : "") +
  (rayLayout === "planar" ? "-planar" : "") +
  (lazyFallback ? "-lazy" : "-eager") +
  suffix +
  ".json";
const report = {
  measurementVersion: 2,
  version: sourceVersion(["scripts/benchmark-fg-runtime.mjs"]),
  configuration: {
    execution,
    rayOrder,
    rayLayout,
    lazyFallback,
    sceneName,
    quality,
    activity,
    viewport,
  },
  rounds: [],
  errors: [],
  renderErrors: [],
};
const b = await launchBrowser(),
  p = await b.newPage({ viewport });
p.on("pageerror", (e) => report.errors.push(String(e)));
p.on("console", (message) => {
  if (message.type() === "error") report.renderErrors.push(message.text());
});
await p.addInitScript(installGlObserver);
try {
  await p.goto(
    "http://localhost:8090/demo/" +
      (sceneName === "gallery" ? "gallery.html?nativeBuffer=1" : "globe.html"),
  );
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
        async ({
          round,
          mode,
          execution,
          lazyFallback,
          rayOrder,
          rayLayout,
          sceneName,
          quality,
          activity,
        }) => {
          const d = earthLab,
            s = d.scene,
            f = s.lumen.finalGather,
            { measureFrames } = await import("./benchmark.js");
          d.camera(sceneName === "gallery" ? "courtyard" : "boxFoot");
          d.world.setDisplayTransition(0);
          s.requestRenderMode = false;
          window.glObserver.phase("performance");
          await f.configure({
            mode: mode === "ddgi" ? "ddgi" : "fg",
            quality,
            sampling:
              mode === "fixed-raw" || mode === "ddgi"
                ? "fixed-reference"
                : "reconstructed",
            reconstruction: mode === "reconstructed",
            execution:
              mode === "fixed-raw" || mode === "ddgi" ? "split" : execution,
            rayOrder:
              mode === "fixed-raw" || mode === "ddgi" ? "original" : rayOrder,
            rayLayout:
              mode === "fixed-raw" || mode === "ddgi"
                ? "interleaved"
                : rayLayout,
            model: d.model,
          });
          await d.world.completed;
          f.lazyFallback =
            mode === "fixed-raw" || mode === "ddgi" ? false : lazyFallback;
          f.continuousSampling = activity !== "pause";
          f.profileForward = false;
          for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
          if (activity === "pause")
            for (let i = 0; i < 70; i++)
              await new Promise(requestAnimationFrame);
          const origin = Cesium.Cartesian3.clone(s.camera.position),
            right = Cesium.Cartesian3.clone(s.camera.right),
            initialSunRadiance = Array.from(d.lighting.sunRadiance);
          let epoch = 0,
            activityFrame = 0,
            wholeDraws = 0,
            cachedFrames = 0;
          const epochs = [],
            sampleInputs = [],
            fallbackReasons = {},
            lightingEvents = [],
            beforeDraws = f.metrics.draws;
          const updateActivity = () => {
            const index = activityFrame++;
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
            if (activity === "relight" && [30, 60].includes(index)) {
              d.lighting.sunRadiance = initialSunRadiance.map(
                (v) => v * (index === 30 ? 1.05 : 1),
              );
              d.lightingController.update();
              d.world.solve({ ...d.lighting });
              lightingEvents.push({
                window: f.profileForward ? "components" : "whole-frame",
                frame: index,
                sunRadiance: [...d.lighting.sunRadiance],
              });
            }
          };
          const removeActivity = s.preUpdate.addEventListener(updateActivity);
          const before = performance.now(),
            whole = await measureFrames(s, 100, {
              warmup: 20,
              requireFG:
                activity === "static" || activity === "moving"
                  ? mode !== "ddgi"
                  : false,
              beforeFrame() {
                f._sampleEpoch = epoch;
              },
              afterFrame({ index, executed }) {
                if (executed === 1) {
                  epochs.push(f.metrics.sampleEpoch);
                  sampleInputs.push({
                    frame: index,
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
                  epoch++;
                } else if (mode !== "ddgi" && !f.ready) {
                  const reason = f.metrics.status;
                  fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
                } else if (mode !== "ddgi") {
                  cachedFrames++;
                }
                // Query polling may render more frames, but they are outside this window.
                if (index === 99) {
                  wholeDraws = f.metrics.draws - beforeDraws;
                  removeActivity();
                }
              },
            });
          activityFrame = 0;
          const queryDrainDraws = f.metrics.draws - beforeDraws - wholeDraws,
            componentBeforeDraws = f.metrics.draws;
          const fgBefore = f.metrics.frames,
            sceneBefore = s.frameState.frameNumber;
          f.metrics.completedTimings.length = 0;
          f.profileForward = mode !== "ddgi" && activity !== "pause";
          const removeComponentActivity =
            s.preUpdate.addEventListener(updateActivity);
          const minFrame = s.frameState.frameNumber + 1,
            start = performance.now();
          if (mode !== "ddgi" && activity !== "pause")
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
          removeComponentActivity();
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
            sampleInputs,
            fallbackReasons,
            lightingEvents,
            draws: f.metrics.draws - beforeDraws,
            wholeDraws,
            queryDrainDraws,
            componentDraws: f.metrics.draws - componentBeforeDraws,
            cachedFrames,
            fallbackFrames: Object.values(fallbackReasons).reduce(
              (sum, n) => sum + n,
              0,
            ),
            whole,
            components: {
              window: "separate from whole-frame timer",
              activity,
              completeFrames: complete.length,
              actualFGFrames: f.metrics.frames - fgBefore,
              actualSceneFrames: s.frameState.frameNumber - sceneBefore,
              means,
              combinedP50: all[Math.floor(all.length * 0.5)] ?? null,
              combinedP95: all[Math.floor(all.length * 0.95)] ?? null,
            },
            completeFrameSamples: complete,
            metrics: {
              ...structuredClone(f.metrics),
              completedTimings: undefined,
            },
            settings: await d.saveView(),
            milliseconds: performance.now() - before,
            readbacks: window.glObserver.snapshot(),
          };
        },
        {
          round,
          mode,
          execution,
          lazyFallback,
          rayOrder,
          rayLayout,
          sceneName,
          quality,
          activity,
        },
      );
      report.rounds.push(row);
      await writeFile(reportFile, JSON.stringify(report, null, 2));
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
        ...report.rounds.map((x) => x.metrics.peakAdditionalBytes ?? 0),
      ),
      limit: 64 * 1048576,
      scope: "peak owned attachments plus all live round/material snapshots",
    },
  };
  report.note =
    "Differences are means of independent-window P95s, not paired per-frame deltas. Component means are not summed percentiles.";
  report.checks = {
    sameSequence:
      activity === "pause" ||
      [0, 1, 2].every((round) =>
        sampleSequenceMatches(
          report.rounds.find(
            (r) => r.round === round && r.mode === "decorrelated-raw",
          ),
          report.rounds.find(
            (r) => r.round === round && r.mode === "reconstructed",
          ),
        ),
      ),
    boundedWindow: report.rounds.every(
      (x) =>
        x.epochs.length === x.whole.actualFGFrames &&
        x.sampleInputs.length === x.whole.actualFGFrames &&
        x.sampleInputs.every(
          (input) => input.frame >= 0 && input.frame < x.whole.renderedFrames,
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
          (activity === "relight"
            ? x.whole.actualFGFrames > 0
            : activity === "pause"
              ? x.whole.actualFGFrames ===
                (x.mode === "reconstructed" ? 0 : x.whole.renderedFrames)
              : x.whole.actualFGFrames === x.whole.renderedFrames) &&
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
    targetReconstruction:
      activity === "pause" ||
      report.targets.additionalReconstructionP95.value <= 1,
    targetCompleteFG:
      activity === "pause" || report.targets.completeFGP95.value <= 3,
  };
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.renderErrors, []);
  assert(
    Object.values(report.checks).every(Boolean),
    JSON.stringify(report.checks),
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  report.failureState = await p
    .evaluate(() => ({
      defaultLoop: earthLab.widget.useDefaultRenderLoop,
      errorPanel: document.querySelector(".cesium-widget-errorPanel")
        ?.textContent,
      frame: earthLab.scene.frameState.frameNumber,
      worldStatus: earthLab.world.status,
      worldError: earthLab.world.error,
      fgStatus: earthLab.scene.lumen.finalGather.metrics.status,
    }))
    .catch(() => undefined);
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(reportFile, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    targets: report.targets,
    checks: report.checks,
    error: report.error,
  }),
);
