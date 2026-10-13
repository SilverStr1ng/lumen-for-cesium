import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { r6Acceptance } from "./r6-acceptance.mjs";
const positive = {
  tests: [
    "regression",
    "compare-final-gather",
    "capture-receiver",
    "benchmark-receiver",
  ].map((script) => ({ script, exitCode: 0 })),
  regression: "passed",
  quality: {
    status: "passed",
    highQuery: "passed",
    production32: "passed",
    gateHarness: "passed",
    gates: [
      { label: "ddgi-v4", exitCode: 1 },
      { label: "injected", exitCode: 1 },
      ...["fg-query-high", "fg16", "fg32"].map((label) => ({
        label,
        exitCode: 0,
        quality: "passed",
      })),
    ],
  },
  performance: { status: "passed" },
};
const results = [];
const check = (name, report, expected, fast = false) => {
  const decision = r6Acceptance(report, fast);
  assert.equal(decision.status, expected);
  const code =
    'import {readFileSync} from "node:fs"; import {r6Acceptance} from "./scripts/r6-acceptance.mjs"; const x=JSON.parse(readFileSync(0,"utf8")); process.exitCode=r6Acceptance(x.report,x.fast).status==="failed"?1:0;';
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      input: JSON.stringify({ report, fast }),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(child.status, expected === "failed" ? 1 : 0, child.stderr);
  results.push({ name, status: "passed", decision, exitCode: child.status });
};
check("expected negative gates still allow success", positive, "passed");
for (const key of ["status", "highQuery", "production32", "gateHarness"]) {
  const r = structuredClone(positive);
  r.quality[key] = "failed";
  check("quality " + key, r, "failed");
}
for (const key of ["regression", "performance"]) {
  const r = structuredClone(positive);
  if (key === "regression") r.regression = "failed";
  else r.performance.status = "failed";
  check(key + " failure", r, "failed");
}
for (let i = 0; i < positive.tests.length; i++) {
  for (const exitCode of [1, null]) {
    const r = structuredClone(positive);
    r.tests[i].exitCode = exitCode;
    check(r.tests[i].script + " exit " + exitCode, r, "failed");
  }
}
for (const label of ["fg-query-high", "fg16", "fg32"]) {
  for (const exitCode of [1, null]) {
    const r = structuredClone(positive);
    r.quality.gates.find((g) => g.label === label).exitCode = exitCode;
    check(label + " stale passed report, exit " + exitCode, r, "failed");
  }
}
const absentGate = structuredClone(positive);
absentGate.quality.gates = absentGate.quality.gates.filter(
  (g) => g.label !== "fg32",
);
check("absent production gate", absentGate, "failed");
const empty = structuredClone(positive);
empty.tests = [];
check("empty run", empty, "failed");
const fast = structuredClone(positive);
fast.quality = { status: "not-run" };
fast.performance = { status: "not-run" };
check("fast explicitly not-run", fast, "regression-only", true);
fast.tests[0].exitCode = 1;
check("fast failure", fast, "failed", true);
const actual = JSON.parse(
  await readFile("reports/receiver-final-gather-v5/test-suite.json", "utf8"),
);
check(
  "actual measured suite",
  actual,
  actual.status,
  actual.status === "regression-only",
);
await writeFile(
  "reports/receiver-final-gather-v5/acceptance-aggregation.json",
  JSON.stringify(
    { status: "passed", sourceSuiteHead: actual.version.head, results },
    null,
    2,
  ),
);
console.log(
  "PASS " +
    results.length +
    " aggregate/exit cases, including current measured suite",
);
