// Computes thresholds; tracked failures still fail the command.
import { readFile, writeFile, mkdir } from "node:fs/promises";
const out = "reports/receiver-final-gather-v5",
  args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const input = arg(
    "--input",
    "reports/ddgi-visual-quality-v4/independent-reference.json",
  ),
  candidate = arg("--candidate", "after");
const data = JSON.parse(await readFile(input, "utf8"));
const baseline = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/independent-reference.json",
    "utf8",
  ),
);
const injected = args.includes("--inject-error"),
  checks = [];
const results = structuredClone(
  data.composedError?.[candidate] ?? data.metrics?.C,
);
if (!results) throw Error("quality input has no computed candidate errors");
if (injected) results.pillarFoot.rmse = 10;
for (const name of Object.keys(baseline.composedError.before)) {
  const actual = results[name]?.rmse,
    threshold = baseline.composedError.before[name].rmse;
  checks.push({
    name,
    actual,
    threshold,
    status:
      Number.isFinite(actual) && actual <= threshold
        ? "passed"
        : name === "pillarFoot" && !injected
          ? "tracked-failure"
          : "failed",
    metric: "original six-line absolute effective E RMSE",
  });
}
if (data.metrics?.C)
  for (const name of ["pillarFoot", "boxFloor"]) {
    const actual = results[name].rmse,
      threshold = 0.7 * baseline.composedError.after[name].rmse;
    checks.push({
      name: name + " relative 30% improvement",
      actual,
      threshold,
      status: actual <= threshold ? "passed" : "failed",
    });
  }
const report = {
  input,
  candidate,
  regression: "not-run",
  quality: checks.every((c) => c.status === "passed") ? "passed" : "failed",
  performance: "not-run",
  slowReference:
    data.sampling ??
    "historical executed R5 paths; fresh R6 slow reference not-run",
  checks,
  injected,
};
await mkdir(out, { recursive: true });
await writeFile(
  out + "/quality-" + (injected ? "injected" : candidate) + ".json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ quality: report.quality, checks }));
if (report.quality !== "passed") process.exitCode = 1;
