// Numeric gates are executed here; no acceptance status from an input is trusted.
import { readFile, writeFile, mkdir } from "node:fs/promises";
const out = "reports/receiver-final-gather-v5",
  args = process.argv.slice(2),
  arg = (n, f) => {
    const i = args.indexOf(n);
    return i < 0 ? f : args[i + 1];
  };
const input = arg(
    "--input",
    "reports/ddgi-visual-quality-v4/independent-reference.json",
  ),
  candidate = arg("--candidate", "after"),
  label = arg("--label", candidate),
  samples = Number(arg("--samples", 0)),
  injected = args.includes("--inject-error"),
  checks = [];
const data = JSON.parse(await readFile(input, "utf8")),
  baseline = JSON.parse(
    await readFile(
      "reports/ddgi-visual-quality-v4/independent-reference.json",
      "utf8",
    ),
  );
let reference = data,
  results;
if (samples) {
  reference = JSON.parse(await readFile(out + "/abcd.json", "utf8"));
  results = structuredClone(
    data.qualityModes?.find((m) => m.samples === samples)?.metrics[0],
  );
} else
  results = structuredClone(data.composedError?.[candidate] ?? data.metrics?.C);
if (!results) throw Error("quality input has no computed candidate errors");
if (injected) results.pillarFoot.rmse = 10;
const gate = (name, actual, threshold, metric, tracked = false) =>
  checks.push({
    name,
    actual,
    threshold,
    metric,
    status:
      Number.isFinite(actual) && actual <= threshold
        ? "passed"
        : tracked && !injected
          ? "tracked-failure"
          : "failed",
  });
for (const name of Object.keys(baseline.composedError.before))
  gate(
    name,
    results[name]?.rmse,
    baseline.composedError.before[name].rmse,
    "unchanged original six-line absolute effective E RMSE",
    name === "pillarFoot",
  );
if (reference.metrics?.C) {
  for (const name of ["pillarFoot", "boxFloor"])
    gate(
      name + " relative 30% improvement",
      results[name].rmse,
      0.7 * baseline.composedError.after[name].rmse,
      "same original v4 RMSE threshold, without rounding",
    );
  for (const c of reference.cases) {
    // All 49 samples are required even though the historical score uses 13 indices.
    const valid = Object.entries(c.lines).every(
      ([name, line]) =>
        line.length === 49 &&
        line.every(
          (p) =>
            p.D.valid &&
            p.D.counts.unknown === 0 &&
            p.D.irradiance.every(Number.isFinite) &&
            p.D.standardError.every(Number.isFinite) &&
            p.CSeeds.every(
              (q) =>
                q.valid &&
                !q.unknown &&
                q.revision === c.snapshot.revision &&
                q.round === c.k,
            ),
        ) &&
        c.metrics.C[name].scoredIndices.join(",") ===
          baseline.scans[name].map((p) => p.index).join(","),
    );
    gate(
      (c.heldOut ? "held-out" : "original") +
        " k=" +
        c.k +
        " complete samples and matching revision",
      valid ? 0 : 1,
      0,
      "all six lines, original scored indices, no Unknown or missing rays",
    );
    if (c.k === 3)
      for (const name of Object.keys(c.lines)) {
        const indices = c.metrics.C[name].scoredIndices,
          se = indices.flatMap((i) => c.lines[name][i].D.standardError),
          ci = 3 * Math.sqrt(se.reduce((s, x) => s + x * x, 0) / se.length);
        const actual = !c.heldOut ? results[name].rmse : c.metrics.C[name].rmse;
        gate(
          (c.heldOut
            ? samples
              ? "held-out high-query (low-sample not-run)"
              : "held-out"
            : "original") +
            " " +
            name +
            " no regression vs A",
          actual,
          c.metrics.A[name].rmse + ci,
          "A RMSE + 3 × RMS independent D SE; candidate variance never widens the gate",
        );
      }
  }
  if (samples) {
    const m = data.qualityModes.find((m) => m.samples === samples);
    gate(
      "low-sample production seed validity",
      Object.values(m.lines)
        .flat()
        .every((p) => p.estimates[0].valid && !p.estimates[0].unknown)
        ? 0
        : 1,
      0,
      "deterministic seed 0; all 294 points retained",
    );
  }
}
const report = {
  input,
  candidate,
  label,
  samples: samples || undefined,
  regression: "not-run",
  quality: checks.every((c) => c.status === "passed") ? "passed" : "failed",
  performance: "not-run",
  slowReference:
    reference.sampling ??
    "historical executed R5 paths; fresh R6 slow reference not-run",
  checks,
  injected,
};
await mkdir(out, { recursive: true });
await writeFile(
  out + "/quality-" + label + (injected ? "-injected" : "") + ".json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ quality: report.quality, checks }));
if (report.quality !== "passed") process.exitCode = 1;
