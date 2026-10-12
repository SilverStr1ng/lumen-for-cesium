import { readFile, writeFile } from "node:fs/promises";
const file =
    process.argv[2] ??
    "reports/globe-visibility-v3/visibility-performance.json",
  report = JSON.parse(await readFile(file, "utf8"));
const summarize = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: v.length,
    median: v.length
      ? v.length % 2
        ? v[(v.length - 1) / 2]
        : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
      : null,
    min: v[0] ?? null,
    max: v.at(-1) ?? null,
  };
};
const summary = {
  source: file,
  environment: report.environment,
  baselineLimitation: report.baselineLimitation,
  status: report.status,
  variants: {},
};
const candidate = report.candidateVariant ?? "B";
summary.candidateVariant = candidate;
for (const variant of ["A", candidate]) {
  const runs = report.runs.filter((r) => r.variant === variant),
    updates = runs.flatMap((r) => r.updates);
  summary.variants[variant] = {
    trials: runs.length,
    configuration: runs[0]?.options,
    grid: runs[0]?.grid,
    initializationMilliseconds: summarize(
      runs.map((r) => r.initializationMilliseconds),
    ),
    workerPreparationMilliseconds: summarize(
      runs.map((r) => r.bvh.prepareMilliseconds),
    ),
    bvhBuildMilliseconds: summarize(runs.map((r) => r.bvh.buildMilliseconds)),
    bvh: runs[0]?.bvh,
    memory: runs[0]?.memory,
    firstCpuSubmissionMilliseconds: summarize(
      updates.map((u) => u.metrics.firstPublishSubmissionMilliseconds),
    ),
    finalCpuSubmissionMilliseconds: summarize(
      updates.map((u) => u.metrics.finalSubmissionMilliseconds),
    ),
    completedPromiseMilliseconds: summarize(
      updates.map((u) => u.completedPromiseMilliseconds),
    ),
    submittedFrames: summarize(updates.map((u) => u.metrics.submittedFrames)),
    gpuStages: Object.fromEntries(
      ["visibility", "direct", "bounce", "integrate", "border"].map((stage) => [
        stage,
        summarize(updates.map((u) => u.metrics.stages[stage]?.gpuMilliseconds)),
      ]),
    ),
    trialVisibilityMedians: runs.map(
      (r) =>
        summarize(
          r.updates.map((u) => u.metrics.stages.visibility?.gpuMilliseconds),
        ).median,
    ),
    numerical: runs.map((r) => r.numerical),
  };
}
const a = summarize(summary.variants.A.trialVisibilityMedians).median,
  b = summarize(summary.variants[candidate].trialVisibilityMedians).median;
summary.visibilityReductionFraction = a && b ? 1 - b / a : null;
summary.target30Percent =
  report.numericalStatus === "passed" &&
  report.timingComplete === true &&
  summary.variants.A.trials >= 3 &&
  summary.variants[candidate].trials >= 3 &&
  summary.visibilityReductionFraction !== null &&
  summary.visibilityReductionFraction >= 0.3
    ? "met against same-build reference only"
    : "not met";
const cleanPath = "reports/globe-visibility-v3/baseline-clean-visibility.json";
try {
  const clean = JSON.parse(await readFile(cleanPath, "utf8"));
  const cleanRuns = clean.runs.filter((r) => r.variant === "A");
  const trialMedians = cleanRuns.map((r) => summarize(r.updates.map((u) => u.metrics.stages.visibility?.gpuMilliseconds)).median);
  const cleanMedian = summarize(trialMedians).median;
  summary.originalCleanBaseline = {
    path: cleanPath,
    status: clean.status,
    version: clean.version,
    numericalStatus: clean.numericalStatus,
    timingComplete: clean.timingComplete,
    trials: cleanRuns.length,
    trialVisibilityMedians: trialMedians,
    medianVisibilityGpuMilliseconds: cleanMedian,
    candidateReductionFraction: cleanMedian && b ? 1 - b / cleanMedian : null,
    limitation: "Separate original-build trials; interleaved same-build A/B remains the primary timing comparison."
  };
} catch (error) {
  summary.originalCleanBaseline = { path: cleanPath, status: "not-run", reason: String(error) };
}
await writeFile(
  file.replace(".json", "-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
