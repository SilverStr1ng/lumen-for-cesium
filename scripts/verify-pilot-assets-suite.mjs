import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { sourceVersion } from "./browser-tools.mjs";
import { newOutput } from "./pilot-validation.mjs";
const output = await newOutput("assets"),
  tests = [
    "verify-pipeline",
    "verify-transport",
    "verify-fixtures",
    "verify-environment",
    "verify-curved-contract",
    "verify-pilot-assets",
    "verify-pilot-owners",
    "verify-pilot-cancellation",
    "verify-pilot-requests",
    "verify-pilot-inputs",
    "verify-pilot-diagnostics",
    "verify-pilot-network",
    "verify-pilot-budget",
    "verify-pilot-accounting",
    "verify-pilot-lod-policy",
    "verify-pilot-readiness",
  ],
  rows = [];
for (const name of tests) {
  const r = spawnSync(process.execPath, [`scripts/${name}.mjs`], {
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      LUMEN_REPORT: output + "/" + name + ".json",
      LUMEN_REPORT_DIRECTORY: output + "/" + name,
    },
  });
  await writeFile(
    output + `/${name}.log`,
    (r.stdout ?? "") + (r.stderr ?? ""),
    { flag: "wx" },
  );
  rows.push({ name, exitCode: r.status ?? 1 });
  console.log(name + " " + (r.status === 0 ? "passed" : "failed"));
}
const status = rows.every((r) => r.exitCode === 0) ? "passed" : "failed";
await writeFile(
  output + "/assets.json",
  JSON.stringify(
    {
      version: sourceVersion([
        "scripts/verify-pilot-assets-suite.mjs",
        ...tests.map((n) => `scripts/${n}.mjs`),
        "scripts/pilot-network.mjs",
        "docs/progress/readiness/baseline-v1.json",
        "docs/progress/readiness/v10-review.json",
      ]),
      rows,
      status,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
if (status !== "passed") process.exitCode = 1;
