import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const directory = "reports/relighting-v2";
const load = async (name) =>
  JSON.parse(await readFile(`${directory}/${name}.json`, "utf8"));
const [before, snapshot, progressive] = await Promise.all([
  load("r0-sponza-performance"),
  load("r3-sponza-snapshot-performance"),
  load("r3-sponza-progressive-performance"),
]);
for (const r of [before, snapshot, progressive])
  assert.equal(r.status, "passed");
const quality = (r) => ({
  renderer: r.environment.renderer,
  browser: r.environment.browser,
  headless: r.environment.headless,
  resolution: r.environment.resolution,
  shadowSize: r.environment.shadowSize,
  camera: r.config.camera,
  spacing: r.config.options.spacing,
  rays: r.config.options.rays,
  bounces: r.config.options.bounces,
  gpuBudget: r.config.options.targetGpuMilliseconds,
  maxBatch: r.config.options.maxBatch,
  grid: r.config.grid.counts,
  triangles: r.config.triangles,
  bvhNodes: r.config.bvhNodes,
});
assert.deepEqual(quality(before), quality(snapshot));
assert.deepEqual(quality(before), quality(progressive));
for (const category of Object.keys(before.updates)) {
  assert.deepEqual(
    before.updates[category].map((x) => x.requestedLighting),
    snapshot.updates[category].map((x) => x.requestedLighting),
  );
  assert.deepEqual(
    before.updates[category].map((x) => x.requestedLighting),
    progressive.updates[category].map((x) => x.requestedLighting),
  );
}
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    range: [sorted[0], sorted.at(-1)],
    samples: values.length,
  };
};
const summarize = (r) => ({
  sourceHead: r.head,
  sourceHashes: r.version?.sources,
  initializationWallMilliseconds: r.initializationWallMilliseconds,
  initializationStages: r.config.initialStages ?? null,
  display: r.display,
  memory: r.config.memory,
  work: r.metrics.work,
  disjoint: r.metrics.disjoint,
  timerMissing: r.metrics.timerMissing,
  queryQueuePeak: r.metrics.queryQueuePeak,
  gl: r.gl,
  updates: Object.fromEntries(
    Object.entries(r.updates).map(([key, samples]) => [
      key,
      {
        finalSubmissionMilliseconds: stats(
          samples.map((x) => x.submissionMilliseconds),
        ),
        callToFinalSubmissionMilliseconds: stats(
          samples.map((x) => x.callToFinalSubmissionMilliseconds),
        ),
        firstPublishSubmissionMilliseconds: stats(
          samples.map(
            (x) =>
              x.firstPublishSubmissionMilliseconds ?? x.submissionMilliseconds,
          ),
        ),
        totalGpuMilliseconds: stats(
          samples.map((x) =>
            Object.values(x.metrics.stages).reduce(
              (n, s) => n + s.gpuMilliseconds,
              0,
            ),
          ),
        ),
        submittedFrames: stats(samples.map((x) => x.metrics.submittedFrames)),
        submittedBatches: stats(samples.map((x) => x.metrics.submittedBatches)),
        cpuSchedulingMilliseconds: stats(
          samples.map((x) => x.metrics.cpuSchedulingMilliseconds),
        ),
        work: samples.map((x) => x.metrics.work),
        stages: Object.fromEntries(
          [
            ...new Set(samples.flatMap((x) => Object.keys(x.metrics.stages))),
          ].map((stage) => [
            stage,
            {
              gpuMilliseconds: stats(
                samples.map(
                  (x) => x.metrics.stages[stage]?.gpuMilliseconds ?? 0,
                ),
              ),
              batches: stats(
                samples.map(
                  (x) => x.metrics.stages[stage]?.submittedBatches ?? 0,
                ),
              ),
              timerSamples: samples.map(
                (x) => x.metrics.stages[stage]?.timerSamples ?? 0,
              ),
              timerMissing: samples.map(
                (x) => x.metrics.stages[stage]?.timerMissing ?? 0,
              ),
            },
          ]),
        ),
      },
    ]),
  ),
});
const summaries = {
  before: summarize(before),
  snapshot: summarize(snapshot),
  progressive: summarize(progressive),
};
const comparisons = Object.fromEntries(
  Object.keys(before.updates).map((category) => {
    const base = summaries.before.updates[category];
    const modes = Object.fromEntries(
      ["snapshot", "progressive"].map((mode) => {
        const next = summaries[mode].updates[category];
        const gpuReduction =
          1 -
          next.totalGpuMilliseconds.median / base.totalGpuMilliseconds.median;
        const wallReduction =
          1 -
          next.callToFinalSubmissionMilliseconds.median /
            base.callToFinalSubmissionMilliseconds.median;
        return [
          mode,
          {
            gpuReductionFraction: gpuReduction,
            wallReductionFraction: wallReduction,
            target30Percent:
              gpuReduction >= 0.3 || wallReduction >= 0.3 ? "met" : "not-met",
            previewAheadOfFinalFraction:
              1 -
              next.firstPublishSubmissionMilliseconds.median /
                next.finalSubmissionMilliseconds.median,
          },
        ];
      }),
    );
    return [category, modes];
  }),
);
const summary = {
  schema: 1,
  quality: quality(before),
  comparedLightingSequencesIdentical: true,
  scope:
    "Same device/browser/quality/camera/lighting sequence. CPU submission/atlas publication latency, not GPU completion or presentation. Independent GL-observed no-readback performance runs.",
  statisticalScope:
    "Three samples per revision category: median and range only. Frame p50/p95 are taken from measured frame intervals, not revision latency.",
  continuousLatencyScope:
    "Raw latestFinalSubmissionAfterInputStoppedMilliseconds includes subsequent asynchronous timer-drain frames; it is an upper bound. R3 per-job requestToFinalSubmissionMilliseconds is measured at atlas publication before drain.",
  commits: execFileSync(
    "git",
    ["log", "--format=%H %s", "cbf38d3a36cf6e6c4850d1f9bdd16297a1be2726..HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n"),
  reports: [
    "r0-sponza-performance.json",
    "r3-sponza-snapshot-performance.json",
    "r3-sponza-progressive-performance.json",
  ],
  comparisons,
  summaries,
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(comparisons, null, 2));
