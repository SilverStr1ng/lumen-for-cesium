import { captureMatches } from "./r7-acceptance.mjs";
export const configurations = Object.freeze([
  { id: "fixed", auto: false, viewport: { width: 1280, height: 800 } },
  { id: "auto-1920", auto: true, viewport: { width: 1920, height: 1080 } },
  { id: "auto-2560", auto: true, viewport: { width: 2560, height: 1440 } },
]);
export function screenNames(auto) {
  const scenes = [
    [
      "original",
      ["boxFoot", "pillarFoot", "ceiling"],
      auto ? ["auto"] : ["balanced", "high"],
    ],
    [
      "held-out",
      ["boxFoot", "pillarFoot", "ceiling"],
      auto ? ["auto"] : ["balanced", "high"],
    ],
    [
      "gallery",
      ["courtyard", "skylight", "emitter"],
      auto ? ["auto"] : ["high"],
    ],
    ["slanted-thin", ["left", "right"], auto ? ["auto"] : ["high"]],
    ...(auto ? [] : [["original-scale", ["boxFoot"], ["roi", "fast"]]]),
  ];
  return scenes.flatMap(([scene, views, qualities]) =>
    views.flatMap((view) =>
      qualities.flatMap((quality) =>
        [0, 5, 19].map(
          (seed) => scene + "-" + view + "-" + quality + "-s" + seed,
        ),
      ),
    ),
  );
}
export function performanceConfigurations() {
  const execution = {
    execution: "split",
    rayOrder: "azimuth",
    lazyFallback: true,
  };
  return ["original", "gallery"].flatMap((sceneName) => [
    ...configurations.flatMap((c) =>
      ["static", "moving", "relight"].map((activity) => ({
        ...execution,
        sceneName,
        quality: c.auto ? "auto" : "high",
        activity,
        viewport: c.viewport,
      })),
    ),
    {
      ...execution,
      sceneName,
      quality: "high",
      activity: "pause",
      viewport: { width: 1280, height: 800 },
    },
  ]);
}
export function performanceFile(c) {
  const suffix =
    c.sceneName === "original" &&
    c.quality === "high" &&
    c.activity === "static" &&
    c.viewport.width === 1280 &&
    c.viewport.height === 800
      ? ""
      : "-" +
        c.sceneName +
        "-" +
        c.viewport.width +
        "x" +
        c.viewport.height +
        "-" +
        c.quality +
        "-" +
        c.activity;
  return "performance-" + c.execution + "-azimuth-lazy" + suffix + ".json";
}
export function performanceArguments(c) {
  return [
    "--execution=" + c.execution,
    "--azimuth",
    "--lazy",
    "--scene=" + c.sceneName,
    "--width=" + c.viewport.width,
    "--height=" + c.viewport.height,
    "--quality=" + c.quality,
    "--activity=" + c.activity,
  ];
}
export function requiredCaptureFiles(out) {
  return [
    ...configurations.flatMap((c) => [
      ...[
        "canonical.json",
        "quality.json",
        "same-milliseconds.json",
        "temporal/data.json",
        "screen/data.json",
      ].map((f) => out + "/" + c.id + "/" + f),
      ...screenNames(c.auto).flatMap((name) => [
        out + "/" + c.id + "/screen/" + name + ".json.deflate",
        ...(name.endsWith("-s0")
          ? [
              ...[1, 4, 8, 16, 32].map(
                (frame) =>
                  out +
                  "/" +
                  c.id +
                  "/screen/" +
                  name +
                  "-frame-" +
                  frame +
                  ".png",
              ),
              ...[
                "final-32",
                "raw-32",
                "filtered-32",
                "weight-32",
                "fallback-32",
              ].map(
                (label) =>
                  out + "/" + c.id + "/screen/" + name + "-" + label + ".png",
              ),
            ]
          : []),
      ]),
    ]),
    ...performanceConfigurations().map(
      (c) => out + "/active/" + performanceFile(c),
    ),
    "reports/receiver-final-gather-v5/abcd.json",
    "reports/ddgi-visual-quality-v4/before/diagnostics.json",
    "reports/ddgi-visual-quality-v4/independent-reference.json",
  ];
}
export function requiredInputsPresent(hashes, out) {
  return requiredCaptureFiles(out).every(
    (f) => typeof hashes?.[f] === "string" && /^[0-9a-f]{64}$/.test(hashes[f]),
  );
}
export function versionMatches(
  version,
  current,
  required = Object.keys(current.sources),
) {
  return (
    captureMatches(
      version,
      current.sources,
      current.compiledBundle,
      required,
    ) && JSON.stringify(version?.assets) === JSON.stringify(current.assets)
  );
}
export function childGroupState(tests, names) {
  return names.every((name) => {
    const rows = tests.filter((r) => r.name === name && r.args?.length === 0);
    return rows.length === 1 && childPassed(rows[0]);
  })
    ? "passed"
    : "failed";
}
export function childPassed(run) {
  return run?.exitCode === 0;
}
export function sampleSequenceMatches(c, d) {
  const inputs = (row) =>
    row.sampleInputs?.map((input) => ({
      ...input,
      revision: input.revision - row.sampleInputs[0].revision,
    }));
  return (
    Array.isArray(c?.sampleInputs) &&
    c.sampleInputs.length > 0 &&
    JSON.stringify(inputs(c)) === JSON.stringify(inputs(d))
  );
}
export function artifactMatches(data, current, configuration, required) {
  return (
    versionMatches(data?.version, current, required) &&
    Object.entries(configuration ?? {}).every(
      ([key, value]) =>
        JSON.stringify(data?.configuration?.[key]) === JSON.stringify(value),
    )
  );
}
export function performancePassed(data, run) {
  if (
    !childPassed(run) ||
    data?.measurementVersion !== 2 ||
    data?.status !== "passed" ||
    data?.rounds?.length !== 12 ||
    !data.configuration
  )
    return false;
  const modes = ["ddgi", "fixed-raw", "decorrelated-raw", "reconstructed"],
    isPause = data.configuration.activity === "pause";
  const nat = (n) => Number.isInteger(n) && n >= 0;
  for (let round = 0; round < 3; round++) {
    const rows = modes.map((mode) =>
      data.rounds.find((r) => r.round === round && r.mode === mode),
    );
    if (
      rows.some(
        (r) =>
          !r ||
          !nat(r.whole?.gpuMilliseconds?.samples) ||
          r.whole.gpuMilliseconds.samples < 75 ||
          !["mean", "p50", "p95"].every(
            (k) =>
              Number.isFinite(r.whole.gpuMilliseconds[k]) &&
              r.whole.gpuMilliseconds[k] >= 0,
          ) ||
          !nat(r.whole.renderedFrames) ||
          r.whole.renderedFrames < 75 ||
          !nat(r.whole.actualFGFrames) ||
          r.whole.actualFGFrames > r.whole.renderedFrames ||
          !Array.isArray(r.epochs) ||
          r.epochs.length !== r.whole.actualFGFrames ||
          !Array.isArray(r.sampleInputs) ||
          r.sampleInputs.length !== r.whole.actualFGFrames ||
          r.sampleInputs.some(
            (input, index) =>
              !nat(input.frame) ||
              input.frame >= r.whole.renderedFrames ||
              input.epoch !== r.epochs[index] ||
              !nat(input.epoch) ||
              !Number.isInteger(input.seed) ||
              !nat(input.revision) ||
              !nat(input.round) ||
              !Array.isArray(input.camera) ||
              input.camera.length !== 3 ||
              input.camera.some((n) => !Number.isFinite(n)) ||
              JSON.stringify(input.receiver) !==
                JSON.stringify([r.metrics?.plan?.rw, r.metrics?.plan?.rh]) ||
              input.samples !== r.metrics?.samples,
          ) ||
          r.whole.disjoint !== 0 ||
          r.whole.incompleteQueries !== 0 ||
          r.whole.excludedFallbackFrames !== 0 ||
          r.whole.missingQueries !== 0,
      )
    )
      return false;
    const c = rows[2],
      d = rows[3];
    if (
      !c.metrics?.plan ||
      !d.metrics?.plan ||
      (!isPause &&
        (!sampleSequenceMatches(c, d) ||
          JSON.stringify(c.epochs) !== JSON.stringify(d.epochs))) ||
      JSON.stringify([
        c.metrics.plan.rw,
        c.metrics.plan.rh,
        c.metrics.samples,
      ]) !==
        JSON.stringify([
          d.metrics.plan.rw,
          d.metrics.plan.rh,
          d.metrics.samples,
        ])
    )
      return false;
    for (const r of rows)
      if (r.mode !== "ddgi") {
        if (
          !nat(r.metrics.totalAdditionalBytes) ||
          r.metrics.totalAdditionalBytes > 64 * 1048576 ||
          !nat(r.metrics.peakAdditionalBytes) ||
          r.metrics.peakAdditionalBytes > 64 * 1048576
        )
          return false;
        const expectedPause = isPause && r.mode === "reconstructed";
        if (
          expectedPause
            ? r.whole.actualFGFrames !== 0
            : r.whole.actualFGFrames <= 0
        )
          return false;
        if (
          data.configuration.activity !== "relight" &&
          !expectedPause &&
          r.whole.actualFGFrames !== r.whole.renderedFrames
        )
          return false;
      }
  }
  if (
    ![
      "completeQueries",
      "boundedWindow",
      "activeFG",
      "resourceBudget",
      "productionReadback",
    ].every((k) => data.checks?.[k] === true)
  )
    return false;
  if (isPause) return true;
  const p95 = (mode) =>
    data.rounds
      .filter((r) => r.mode === mode)
      .reduce((s, r) => s + r.whole.gpuMilliseconds.p95, 0) / 3;
  return (
    data.checks.sameSequence === true &&
    p95("reconstructed") - p95("fixed-raw") <= 1 &&
    p95("reconstructed") - p95("ddgi") <= 3
  );
}
export function qualityPassed(data, run) {
  return (
    childPassed(run) &&
    data?.status === "passed" &&
    data.checks?.length > 100 &&
    data.checks.every(
      (x) =>
        Number.isFinite(x.actual) &&
        Number.isFinite(x.threshold) &&
        x.actual <= x.threshold &&
        x.status === "passed",
    )
  );
}
export function aggregate(states) {
  const values = Object.values(states),
    status = values.every((v) => v === "passed")
      ? "passed"
      : values.includes("failed")
        ? "failed"
        : "not-run";
  return {
    status,
    recommended: status === "passed",
    exitCode: status === "passed" ? 0 : 1,
  };
}
