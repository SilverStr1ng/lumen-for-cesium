import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../cesium-1.146/", import.meta.url));
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
