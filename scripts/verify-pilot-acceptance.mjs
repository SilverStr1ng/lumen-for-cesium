import assert from "node:assert/strict";
import { readiness, startupGates } from "./pilot-acceptance.mjs";
const names = [
  "startup-before",
  "startup",
  "startup-no-extension",
  "shader-lifecycle",
  "profile-equivalence",
  "shared-shader-smoke",
  "soak",
];
const valid = {
  beforeEvidence: "passed",
  gates: Object.fromEntries(
    [...startupGates, "soak"].map((k) => [k, "passed"]),
  ),
  children: names.map((name) => ({
    name,
    exitCode: name === "startup-before" ? 1 : 0,
    timedOut: false,
    cleanupFailed: false,
  })),
};
const check = (r) =>
  readiness(r, [...startupGates, "soak"], names.length, true);
assert.deepEqual(check(valid), { pilotReady: true, startupReady: true });
for (const key of ["sourceChanged", "infrastructureError"])
  assert.deepEqual(check({ ...valid, [key]: true }), {
    pilotReady: false,
    startupReady: false,
  });
for (const name of ["startup-before", "startup"])
  for (const key of ["timedOut", "cleanupFailed"])
    assert.deepEqual(
      check({
        ...valid,
        children: valid.children.map((c) =>
          c.name === name ? { ...c, [key]: true } : c,
        ),
      }),
      { pilotReady: false, startupReady: false },
    );
assert.deepEqual(check({ ...valid, beforeEvidence: "not-run" }), {
  pilotReady: false,
  startupReady: false,
});
assert.deepEqual(
  check({
    ...valid,
    infrastructureError: "Final soak cleanup failed",
    children: valid.children.map((c) =>
      c.name === "soak" ? { ...c, cleanupFailed: true } : c,
    ),
  }),
  { pilotReady: false, startupReady: false },
);
console.log(
  "Frozen readiness rejects source changes, missing before evidence and cleanup failures",
);
