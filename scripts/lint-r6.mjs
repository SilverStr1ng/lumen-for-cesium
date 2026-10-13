import { spawnSync } from "node:child_process";
const files = [
  "Lumen",
  "LumenFinalGather",
  "LumenReceiverPass",
  "LumenFinalGatherSnapshot",
  "LumenGpuShaders",
  "LumenGpuWorld",
  "destroyLumenResource",
].map((n) => "packages/engine/Source/Scene/" + n + ".js");
files.push("packages/engine/Source/Scene/Model/LightingPipelineStage.js");
const result = spawnSync(
  process.execPath,
  ["node_modules/eslint/bin/eslint.js", ...files],
  { cwd: "cesium-1.146", encoding: "utf8", windowsHide: true },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
