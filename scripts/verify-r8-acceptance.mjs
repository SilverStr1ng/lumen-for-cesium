import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import plan from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherPlan.js";
import {
  childPassed,
  artifactMatches,
  performancePassed,
  qualityPassed,
  aggregate,
  performanceConfigurations,
  performanceFile,
  requiredCaptureFiles,
  requiredInputsPresent,
  childGroupState,
} from "./r8-acceptance.mjs";
const v = {
  sources: { core: "current" },
  compiledBundle: "bundle",
  assets: { geometry: "hash" },
};
assert(
  artifactMatches({ version: v, configuration: { quality: "auto" } }, v, {
    quality: "auto",
  }),
);
for (const bad of [
  { ...v, compiledBundle: "old" },
  { ...v, sources: { core: "old" } },
  { ...v, assets: { geometry: "old" } },
])
  assert(
    !artifactMatches({ version: bad, configuration: { quality: "auto" } }, v, {
      quality: "auto",
    }),
  );
assert(
  !artifactMatches({ version: v, configuration: { quality: "high" } }, v, {
    quality: "auto",
  }),
);
for (const exitCode of [1, null, undefined]) assert(!childPassed({ exitCode }));
assert(childPassed({ exitCode: 0 }));
for (const exitCode of [1, null, undefined])
  assert.equal(
    childGroupState(
      [{ name: "regression", args: [], exitCode }],
      ["regression"],
    ),
    "failed",
  );
assert.equal(childGroupState([], ["regression"]), "failed");
assert(
  !performancePassed(
    {
      status: "passed",
      rounds: Array(12).fill({ whole: { gpuMilliseconds: { samples: 74 } } }),
    },
    { exitCode: 0 },
  ),
);
assert(
  !qualityPassed(
    {
      status: "passed",
      checks: Array(120).fill({ actual: 1, threshold: 0.05, status: "passed" }),
    },
    { exitCode: 0 },
  ),
);
assert(
  !plan({ width: 1920, height: 1080, quality: "high", snapshotBytes: 2957760 })
    .supported,
);
assert(
  !plan({ width: 1920, height: 1080, quality: "auto", memoryBudget: 1 })
    .supported,
);
assert.deepEqual(aggregate({ regression: "passed", quality: "not-run" }), {
  status: "not-run",
  recommended: false,
  exitCode: 1,
});
assert.equal(aggregate({ performance: "failed" }).exitCode, 1);
const good = {
  measurementVersion: 2,
  status: "passed",
  configuration: { activity: "static" },
  checks: {
    sameSequence: true,
    completeQueries: true,
    boundedWindow: true,
    activeFG: true,
    resourceBudget: true,
    productionReadback: true,
  },
  rounds: [0, 1, 2].flatMap((round) =>
    ["ddgi", "fixed-raw", "decorrelated-raw", "reconstructed"].map((mode) => ({
      round,
      mode,
      epochs: mode === "ddgi" ? [] : Array.from({ length: 100 }, (_, i) => i),
      sampleInputs:
        mode === "ddgi"
          ? []
          : Array.from({ length: 100 }, (_, frame) => ({
              frame,
              epoch: frame,
              seed: 0,
              revision: 1,
              round: 2,
              receiver: [640, 400],
              samples: 32,
              camera: [100, 0, 0],
            })),
      metrics: {
        plan: { rw: 640, rh: 400 },
        samples: 32,
        totalAdditionalBytes: 63373760,
        peakAdditionalBytes: 63373760,
      },
      whole: {
        renderedFrames: 100,
        actualFGFrames: mode === "ddgi" ? 0 : 100,
        gpuMilliseconds: {
          samples: 80,
          mean: mode === "ddgi" ? 1 : 2,
          p50: mode === "ddgi" ? 1 : 2,
          p95: mode === "ddgi" ? 1 : 2,
        },
        disjoint: 0,
        incompleteQueries: 0,
        excludedFallbackFrames: 0,
        missingQueries: 0,
      },
    })),
  ),
};
assert(performancePassed(good, { exitCode: 0 }));
const badPeak = structuredClone(good);
badPeak.rounds[3].metrics.peakAdditionalBytes = 64 * 1048576 + 1;
assert(!performancePassed(badPeak, { exitCode: 0 }));
const unbounded = structuredClone(good);
unbounded.rounds[1].epochs.push(100);
assert(!performancePassed(unbounded, { exitCode: 0 }));
const pollFrame = structuredClone(good);
pollFrame.rounds[1].sampleInputs[99].frame = 100;
assert(!performancePassed(pollFrame, { exitCode: 0 }));
const oldWindow = structuredClone(good);
delete oldWindow.measurementVersion;
assert(!performancePassed(oldWindow, { exitCode: 0 }));
for (const field of ["seed", "round", "revision", "camera"]) {
  const differentInput = structuredClone(good);
  differentInput.rounds[3].sampleInputs[2][field] =
    field === "camera" ? [101, 0, 0] : 9;
  assert(!performancePassed(differentInput, { exitCode: 0 }), field);
}
for (const field of [
  "samples",
  "disjoint",
  "incompleteQueries",
  "excludedFallbackFrames",
  "missingQueries",
])
  for (const value of [undefined, null, NaN, -1]) {
    const broken = structuredClone(good);
    const where =
      field === "samples"
        ? broken.rounds[0].whole.gpuMilliseconds
        : broken.rounds[0].whole;
    where[field] = value;
    assert(!performancePassed(broken, { exitCode: 0 }), field + " " + value);
  }
const pause = structuredClone(good);
pause.configuration.activity = "pause";
pause.rounds
  .filter((r) => r.mode === "reconstructed")
  .forEach((r) => {
    r.whole.actualFGFrames = 0;
    r.epochs = [];
    r.sampleInputs = [];
  });
assert(performancePassed(pause, { exitCode: 0 }));
assert(!performancePassed(pause, { exitCode: 1 }));
const mandatory = requiredCaptureFiles("reports/fg-runtime-budget-v7"),
  hashes = Object.fromEntries(mandatory.map((p) => [p, "a".repeat(64)]));
assert(requiredInputsPresent(hashes, "reports/fg-runtime-budget-v7"));
delete hashes[mandatory[0]];
assert(!requiredInputsPresent(hashes, "reports/fg-runtime-budget-v7"));
assert.equal(
  new Set(performanceConfigurations().map(performanceFile)).size,
  20,
);
await mkdir("reports/fg-runtime-budget-v7/compatibility-raw", {
  recursive: true,
});
await writeFile(
  "reports/fg-runtime-budget-v7/compatibility-raw/acceptance-faults.json",
  JSON.stringify(
    {
      status: "passed",
      checks: [
        "source",
        "bundle",
        "asset",
        "configuration",
        "failed/null child",
        "incomplete timers",
        "fake passed coverage/error",
        "over-budget fixed/Auto",
        "not-run recommendation",
        "failed exit code",
      ],
    },
    null,
    2,
  ),
);
console.log(
  "PASS R8 acceptance rejects stale inputs, nonzero/null children, missing queries, fabricated pass and over-budget plans",
);
