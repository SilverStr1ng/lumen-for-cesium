// Historical startup is a negative control. Only its threshold exit code may
// fail; a timeout or an unconfirmed child-tree cleanup never certifies evidence.
export const childOutcomeValid = (child) =>
  !!child &&
  child.timedOut === false &&
  child.cleanupFailed === false &&
  (child.exitCode === 0 ||
    (child.name === "startup-before" && child.exitCode === 1));

export const startupGates = [
  "startup-cold",
  "startup-warm",
  "startup-no-extension",
  "shader-lifecycle",
  "profile-equivalence",
  "shared-shader-smoke",
];
export function readiness(report, required, expectedChildren, startup = false) {
  const complete =
    !report.sourceChanged &&
    !report.infrastructureError &&
    report.children.length === expectedChildren &&
    report.children.every(childOutcomeValid);
  const startupChildren = [
    "startup-before",
    "startup",
    "startup-no-extension",
    "shader-lifecycle",
    "profile-equivalence",
    "shared-shader-smoke",
  ];
  return {
    pilotReady:
      complete &&
      required.every((g) => report.gates[g] === "passed") &&
      (!startup || report.beforeEvidence === "passed"),
    startupReady:
      startup &&
      !report.sourceChanged &&
      !report.infrastructureError &&
      report.beforeEvidence === "passed" &&
      startupGates.every((g) => report.gates[g] === "passed") &&
      startupChildren.every((name) =>
        childOutcomeValid(report.children.find((c) => c.name === name)),
      ),
  };
}
