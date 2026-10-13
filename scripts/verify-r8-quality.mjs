import { spawnSync } from "node:child_process";
for (const [id, width, height, auto] of [
  ["fixed", 1280, 800, false],
  ["auto-1920", 1920, 1080, true],
  ["auto-2560", 2560, 1440, true],
]) {
  const r = spawnSync(process.execPath, ["scripts/verify-fg-quality.mjs"], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      LUMEN_FG_REPORT: "reports/fg-runtime-budget-v7/" + id,
      LUMEN_FG_AUTO: auto ? "1" : "0",
      LUMEN_FG_WIDTH: String(width),
      LUMEN_FG_HEIGHT: String(height),
      LUMEN_QUALITY_REPORT:
        "reports/fg-runtime-budget-v7/validation/" + id + "-quality.json",
    },
  });
  if (r.status !== 0) process.exitCode = 1;
}
