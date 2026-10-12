import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { sourceVersion } from "./browser-tools.mjs";

const report = { started: new Date().toISOString(), version: sourceVersion(), checks: [] };
for (const script of ["verify-pipeline.mjs", "verify-transport.mjs", "verify-environment.mjs", "verify-globe-controls.mjs", "verify-visibility.mjs"]) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [`scripts/${script}`], { encoding: "utf8" });
  report.checks.push({ script, passed: result.status === 0, exitCode: result.status, signal: result.signal, elapsedMilliseconds: performance.now()-started, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  console.log(`${result.status === 0 ? "PASS" : "FAIL"} ${script}`);
}
report.status = report.checks.every(check => check.passed) ? "passed" : "failed";
mkdirSync("reports/globe-visibility-v3", { recursive: true });
const json = JSON.stringify(report,null,2);
writeFileSync(`reports/globe-visibility-v3/node-checks-${report.started.replaceAll(/[:.]/g,"-")}.json`,json);
writeFileSync("reports/globe-visibility-v3/node-checks.json",json);
if (report.status !== "passed") process.exitCode = 1;
