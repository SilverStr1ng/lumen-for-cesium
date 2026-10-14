import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../cesium-1.146/", import.meta.url));
const physics = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  {cwd:fileURLToPath(new URL("../",import.meta.url)),stdio:"inherit",shell:process.platform==="win32"});
if(physics.error)throw physics.error;
if(physics.status!==0)process.exit(physics.status??1);
for (const args of [
  ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  ["exec", "--", "gulp", "prepare"],
]) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    { cwd, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
