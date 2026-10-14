import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  `reports/ballpool-curved-receivers-v8/benchmark-${new Date().toISOString().replaceAll(":", "-")}`;
await mkdir(out, { recursive: true });
const report = { rows: [], recommended: false };
for (const quality of ["auto", "interactive16"]) {
  const args = [
      "scripts/benchmark-fg-runtime.mjs",
      "--scene=ballpool",
      `--quality=${quality}`,
      "--activity=static",
      "--azimuth",
      "--lazy",
    ],
    result = spawnSync(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, LUMEN_REPORT_DIRECTORY: out },
      windowsHide: true,
    });
  const data = JSON.parse(
    await readFile(
      `${out}/performance-split-azimuth-lazy-ballpool-1280x800-${quality}-static.json`,
      "utf8",
    ),
  );
  report.rows.push({ quality, exitCode: result.status, data });
}
const preview = spawnSync(
  process.execPath,
  ["scripts/benchmark-ballpool-preview.mjs"],
  {
    stdio: "inherit",
    env: { ...process.env, LUMEN_REPORT_DIRECTORY: out },
    windowsHide: true,
  },
);
report.previewExitCode = preview.status;
report.status =
  report.rows.every((r) => r.exitCode === 0) && preview.status === 0
    ? "passed"
    : "failed";
await writeFile(
  out + "/ballpool-performance.json",
  JSON.stringify(report, null, 2),
);
if (report.status !== "passed") process.exitCode = 1;
