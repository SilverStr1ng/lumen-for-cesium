import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = path.join(root, ".lumen-baseline");
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else files.push(path.relative(baseline, file).replaceAll("\\", "/"));
  }
}
await collect(baseline);
let patch = "";
for (const file of [
  ...files,
  "packages/engine/Source/Scene/GBuffer.js",
  "packages/engine/Source/Scene/Lumen.js",
  "packages/engine/Source/Scene/LumenWorld.js",
  "packages/engine/Source/Scene/LumenGpuWorld.js",
  "packages/engine/Source/Scene/LumenGpuShaders.js",
  "packages/engine/Source/Shaders/Model/LumenStageFS.glsl",
]) {
  const old = files.includes(file) ? `.lumen-baseline/${file}` : "NUL";
  const current = `cesium-1.146/${file}`;
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-prefix", "--", old, current],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1)
    throw new Error(result.stderr);
  const section = result.stdout
    .replaceAll(old, `a/${file}`)
    .replaceAll(current, `b/${file}`);
  patch += section;
}
await mkdir(path.join(root, "artifacts"), { recursive: true });
await writeFile(path.join(root, "artifacts", "cesium-lumen.patch"), patch);
console.log(
  `Wrote ${files.length + 6} file diffs to artifacts/cesium-lumen.patch`,
);
