import { createRequire } from "node:module";
const require = createRequire(
  new URL("../cesium-1.146/package.json", import.meta.url),
);
const core = require("jasmine-core");
const jasmine = core.core(core);
const env = jasmine.getEnv();
Object.assign(globalThis, core.interface(jasmine, env));
let failures = 0,
  count = 0;
env.addReporter({
  specDone(result) {
    count++;
    if (result.status !== "passed") {
      failures++;
      console.error(
        "FAIL",
        result.fullName,
        result.failedExpectations.map((e) => e.message),
      );
    } else console.log("PASS", result.fullName);
  },
  jasmineDone(result) {
    console.log(
      `${count} pipeline specs; ${failures} failed; ${result.overallStatus}`,
    );
    if (failures || result.overallStatus !== "passed" || count === 0)
      process.exitCode = 1;
  },
});
await import("../cesium-1.146/packages/engine/Specs/Scene/Model/LightingPipelineStageSpec.js");
await import("../cesium-1.146/packages/engine/Specs/Scene/Model/ImageBasedLightingPipelineStageSpec.js");
await env.execute();
