import assert from "node:assert/strict";
import { expectedTests, requiredStates, summarize } from "./r9-acceptance.mjs";
import { sourceVersion } from "./browser-tools.mjs";
const out = "reports/ballpool-curved-receivers-v8/validator-fixture";
const empty = await summarize({ tests: [], inputs: {} }, out);
assert.equal(empty.recommended, false);
assert.equal(empty.status, "failed");
assert.equal(empty.notRun.length, requiredStates.length);
assert(Object.values(empty.states).every((s) => s === "not-run"));
assert.equal(
  expectedTests(out).filter((j) => j.name === "benchmark-fg-runtime").length,
  14,
);
await assert.rejects(
  summarize(
    {
      tests: [
        {
          name: "verify-ballpool",
          parameters: [],
          exitCode: 0,
          status: "passed",
          log: `${out}/fake.log`,
        },
      ],
      inputs: {},
    },
    out,
    true,
  ),
  /required evidence absent/,
);
const forged = await summarize(
  {
    tests: [],
    inputs: {},
    states: Object.fromEntries(requiredStates.map((s) => [s, "passed"])),
    recommended: true,
  },
  out,
);
assert.equal(forged.recommended, false);
assert(
  sourceVersion().sources[
    "cesium-1.146/packages/engine/Source/Shaders/Model/LightingStageFS.glsl"
  ],
);
console.log(
  "R9 mandatory evidence, forged aggregate and shader fingerprint checks passed",
);
