const requiredPerformanceChecks = Object.freeze([
  "completeQueries",
  "activeFG",
  "resourceBudget",
  "productionReadback",
  "targetReconstruction",
  "targetCompleteFG",
]);
// A passed JSON is insufficient when the process which should produce it failed.
export function testPassed(data, run) {
  return run?.exitCode === 0 && data?.status === "passed";
}
export function performancePassed(data, run, cached = false) {
  return (
    (cached || run?.exitCode === 0) &&
    data?.status === "passed" &&
    requiredPerformanceChecks.every((key) => data.checks?.[key] === true) &&
    data.rounds?.length === 9
  );
}
export function captureMatches(
  version,
  currentSources,
  compiledBundle,
  required = [],
) {
  return (
    version?.compiledBundle === compiledBundle &&
    version.sources &&
    required.every((file) => Object.hasOwn(version.sources, file)) &&
    Object.entries(version.sources).every(
      ([file, hash]) => currentSources[file] === hash,
    )
  );
}
