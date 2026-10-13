import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import plan from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherPlan.js";
import {
  childPassed,
  artifactMatches,
  performancePassed,
  qualityPassed,
  aggregate,
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
