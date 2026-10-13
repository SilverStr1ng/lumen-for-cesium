import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  performancePassed,
  testPassed,
  captureMatches,
} from "./r7-acceptance.mjs";
const data = {
  status: "passed",
  rounds: Array(9).fill({}),
  checks: {
    completeQueries: true,
    activeFG: true,
    resourceBudget: true,
    productionReadback: true,
    targetReconstruction: true,
    targetCompleteFG: true,
  },
};
const rows = [];
for (const exitCode of [0, 1, null, undefined]) {
  const expected = exitCode === 0;
  assert.equal(performancePassed(data, { exitCode }), expected);
  assert.equal(testPassed({ status: "passed" }, { exitCode }), expected);
  rows.push({
    name: "stale passed JSON after child exit",
    exitCode: exitCode ?? "unavailable",
    accepted: expected,
  });
}
for (const bad of [
  { ...data, checks: {} },
  { ...data, rounds: [] },
  { ...data, status: "failed" },
  { ...data, checks: { ...data.checks, completeQueries: false } },
])
  assert.equal(performancePassed(bad, { exitCode: 0 }), false);
assert.equal(performancePassed(data, undefined, true), true);
assert.equal(testPassed({ status: "not-run" }, { exitCode: 0 }), false);
const currentSources = { core: "core-hash", diagnostics: "new-helper" };
const oldCapture = {
  compiledBundle: "bundle",
  sources: { core: "core-hash", diagnostics: "old-helper" },
};
assert.equal(
  captureMatches(oldCapture, currentSources, "bundle", ["core"]),
  false,
);
assert.equal(
  captureMatches(
    { ...oldCapture, sources: currentSources },
    currentSources,
    "bundle",
    ["core"],
  ),
  true,
);
assert.equal(
  captureMatches(
    { compiledBundle: "bundle", sources: { diagnostics: "new-helper" } },
    currentSources,
    "bundle",
    ["core"],
  ),
  false,
);
assert.equal(
  captureMatches(
    { ...oldCapture, sources: currentSources },
    currentSources,
    "other-bundle",
    ["core"],
  ),
  false,
);
await writeFile(
  "reports/fg-reconstruction-showcase-v6/acceptance-faults.json",
  JSON.stringify(
    {
      status: "passed",
      scope: "pure aggregation fault matrix; no GPU success inferred",
      rows,
      checks: [
        "fresh child success required",
        "missing exit rejected",
        "stale success cannot override failure",
        "empty performance checks rejected",
        "incomplete windows rejected",
        "cached is explicit; source hashes separately required",
      ],
    },
    null,
    2,
  ),
);
console.log(
  "PASS R7 aggregation rejects failed/null children and stale/empty/incomplete success JSON",
);
