import { captureMatches } from "./r7-acceptance.mjs";
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
export function childPassed(run) {
  return run?.exitCode === 0;
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
export function performancePassed(data, run, cached = false) {
  if (
    !childPassed(run) ||
    data?.status !== "passed" ||
    data?.rounds?.length !== 12
  )
    return false;
  const modes = ["ddgi", "fixed-raw", "decorrelated-raw", "reconstructed"];
  for (let round = 0; round < 3; round++) {
    const rows = modes.map((mode) =>
      data.rounds.find((r) => r.round === round && r.mode === mode),
    );
    if (
      rows.some(
        (r) =>
          !r ||
          r.whole?.gpuMilliseconds?.samples < 75 ||
          r.whole.disjoint ||
          r.whole.incompleteQueries ||
          r.whole.excludedFallbackFrames,
      )
    )
      return false;
    const c = rows[2],
      d = rows[3];
    if (
      JSON.stringify(c.epochs) !== JSON.stringify(d.epochs) ||
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
      if (r.mode !== "ddgi" && data.configuration.activity !== "pause") {
        if (
          r.whole.actualFGFrames <= 0 ||
          r.metrics.totalAdditionalBytes > 64 * 1048576
        )
          return false;
        if (
          data.configuration.activity !== "relight" &&
          r.whole.actualFGFrames !== r.whole.renderedFrames
        )
          return false;
      }
  }
  if (data.configuration.activity === "pause") return true;
  const p95 = (mode) =>
    data.rounds
      .filter((r) => r.mode === mode)
      .reduce((s, r) => s + r.whole.gpuMilliseconds.p95, 0) / 3;
  return (
    Number.isFinite(p95("reconstructed")) &&
    p95("reconstructed") - p95("fixed-raw") <= 1 &&
    p95("reconstructed") - p95("ddgi") <= 3 &&
    [
      "sameSequence",
      "completeQueries",
      "activeFG",
      "resourceBudget",
      "productionReadback",
    ].every((k) => data.checks?.[k] === true)
  );
}
export function qualityPassed(data, run, cached = false) {
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
