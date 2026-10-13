// Expected quality-negative gates are checked by gateHarness, not treated as failed regressions.
export function r6Acceptance(report, fast = false) {
  const stepsPassed =
    report.tests.length > 0 && report.tests.every((t) => t.exitCode === 0);
  const ran = (script) =>
    report.tests.some((t) => t.script === script && t.exitCode === 0);
  const regressionPassed = report.regression === "passed" && stepsPassed;
  const ranGate = (label) =>
    report.quality.gates?.some(
      (g) => g.label === label && g.exitCode === 0 && g.quality === "passed",
    );
  const qualityPassed =
    ran("compare-final-gather") &&
    ran("capture-receiver") &&
    ["fg-query-high", "fg16", "fg32"].every(ranGate) &&
    [
      report.quality.status,
      report.quality.highQuery,
      report.quality.production32,
      report.quality.gateHarness,
    ].every((s) => s === "passed");
  const performancePassed =
    ran("benchmark-receiver") && report.performance.status === "passed";
  return {
    quality: fast ? "not-run" : qualityPassed ? "passed" : "failed",
    performance: fast ? "not-run" : performancePassed ? "passed" : "failed",
    status: fast
      ? regressionPassed
        ? "regression-only"
        : "failed"
      : regressionPassed && qualityPassed && performancePassed
        ? "passed"
        : "failed",
  };
}
