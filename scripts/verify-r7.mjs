import { spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { sourceVersion } from "./browser-tools.mjs";
const out = "reports/fg-reconstruction-showcase-v6",
  fast = process.argv.includes("--fast"),
  cached = process.argv.includes("--cached");
await mkdir(out + "/compatibility-raw", { recursive: true });
const report = {
  version: sourceVersion(),
  started: new Date().toISOString(),
  tests: [],
  notRun: [],
  captureMode: cached
    ? "cached numerical/performance captures"
    : fast
      ? "fast: numerical/performance not-run"
      : "fresh numerical/performance captures",
};
const names = [
  "pipeline",
  "transport",
  "environment",
  "globe-controls",
  "visibility",
  "fixtures",
  "relighting",
  "integration",
  "progressive",
  "publication-lifecycle",
  "visibility-gpu",
  "visibility-domain",
  "visibility-edges",
  "globe",
  "solid-probes",
  "spatial-kernel",
  "spatial-gpu",
  "pbr-environment",
  "display-presets",
  "probe-display",
  "ibl-policy",
  "final-gather",
  "receiver",
  "reconstruction",
  "resource-lifecycle",
];
const tracked = execFileSync("git", ["ls-files", "reports"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .filter((p) => p && !p.startsWith(out + "/"));
const untrackedReports = () =>
  execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "reports"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .filter((p) => p && !p.startsWith(out + "/"));
const initialUntracked = new Set(untrackedReports());
const saved = new Map(
  await Promise.all(tracked.map(async (p) => [p, await readFile(p)])),
);
const run = (script, args = []) => {
  const start = performance.now(),
    r = spawnSync(process.execPath, ["scripts/" + script + ".mjs", ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        ...process.env,
        LUMEN_REPORT: out + "/compatibility-raw/" + script + ".json",
        LUMEN_REPORT_DIRECTORY: out + "/compatibility-raw",
      },
    });
  const row = {
    script,
    args,
    exitCode: r.status,
    milliseconds: performance.now() - start,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
    status: r.status === 0 ? "passed" : "failed",
  };
  report.tests.push(row);
  console.log(row.status.toUpperCase(), script);
  return row;
};
const json = async (p) => JSON.parse(await readFile(out + "/" + p, "utf8"));
try {
  run("lint-r6");
  for (const name of fast
    ? ["pipeline", "ibl-policy", "final-gather", "receiver", "reconstruction"]
    : names)
    run("verify-" + name);
  report.regression = report.tests.every((x) => x.status === "passed")
    ? "passed"
    : "failed";
  if (!fast) {
    for (const name of [
      "r7-timers",
      "fg-sampling",
      "fg-history",
      "fg-barriers",
      "fg-statistics",
      "fg-temporal",
      "fg-lifecycle",
      "gallery",
    ])
      run("verify-" + name);
    if (!cached) {
      run("measure-fg-canonical");
      run("capture-fg-reconstruction");
      run("benchmark-fg-reconstruction");
    }
    const quality = run("verify-fg-quality"),
      injected = run("verify-fg-quality", ["--inject-error"]);
    report.quality =
      quality.exitCode === 0 &&
      (await json("quality.json")).status === "passed" &&
      injected.exitCode === 1
        ? "passed"
        : "failed";
    const temporal = await json("temporal/data.json"),
      life = await json("lifecycle.json");
    report.temporal =
      temporal.status === "passed" && life.status === "passed"
        ? "passed"
        : "failed";
    const perf = await json("performance.json");
    report.performance =
      perf.status === "passed" &&
      Object.values(perf.checks ?? {}).every(Boolean)
        ? "passed"
        : "failed";
    report.showcase = (await json("gallery/data.json")).status;
    report.captureVersions = Object.fromEntries(
      await Promise.all(
        [
          "canonical.json",
          "screen/data.json",
          "performance.json",
          "gallery/data.json",
        ].map(async (file) => [file, (await json(file)).version]),
      ),
    );
    report.captureSourceMatch = Object.values(report.captureVersions).every(
      (v) =>
        v &&
        Object.entries(report.version.sources).every(
          ([file, hash]) => v.sources?.[file] === hash,
        ) &&
        v.compiledBundle === report.version.compiledBundle,
    );
    if (!report.captureSourceMatch) {
      report.notRun.push({
        name: "current-source numeric/performance acceptance",
        reason:
          "capture source hashes or compiled bundle differ; existing snapshots remain inspectable",
      });
      report.quality = report.performance = "not-run";
    }
    report.notRun.push(...(temporal.notRun ?? []), ...(life.notRun ?? []), {
      name: "authenticated ion / World Terrain",
      reason:
        "no token supplied; local mode and existing mocked failures executed",
    });
  } else
    report.quality =
      report.temporal =
      report.performance =
      report.showcase =
        "not-run";
  run("verify-export-patch");
  if (
    report.tests.some(
      (x) =>
        x.status === "failed" &&
        !["benchmark-fg-reconstruction", "verify-fg-quality"].includes(
          x.script,
        ),
    )
  )
    report.regression = "failed";
  // A deliberately injected quality failure is harness evidence, not a regression.
  if (
    report.tests
      .filter((x) => x.script === "verify-fg-quality" && !x.args.length)
      .some((x) => x.exitCode !== 0)
  )
    report.quality = "failed";
} catch (e) {
  report.error = e.stack;
  report.regression = "failed";
} finally {
  for (const [p, old] of saved) {
    let current;
    try {
      current = await readFile(p);
    } catch {
      current = undefined;
    }
    if (current && !current.equals(old)) {
      const target = out + "/compatibility-raw/" + p.slice(8);
      await mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await writeFile(target, current);
    }
    if (!current || !current.equals(old)) await writeFile(p, old);
  }
  // Keep new timestamped compatibility evidence inside this revision's report.
  // Existing untracked user files are preserved; only files created by this run move.
  const reportRoot = path.resolve("reports") + path.sep;
  for (const p of untrackedReports().filter((p) => !initialUntracked.has(p))) {
    if (!path.resolve(p).startsWith(reportRoot))
      throw Error("report path escaped workspace");
    const target = out + "/compatibility-raw/" + p.slice(8);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(p));
    await unlink(p);
  }
  const states = [
    report.regression,
    report.quality,
    report.temporal,
    report.performance,
    report.showcase,
  ];
  report.status = states.every((x) => x === "passed")
    ? "passed"
    : states.includes("failed")
      ? "failed"
      : "not-run";
  report.recommended = report.status === "passed";
  report.finished = new Date().toISOString();
  await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      regression: report.regression,
      imageQuality: report.quality,
      temporalQuality: report.temporal,
      performance: report.performance,
      showcase: report.showcase,
      status: report.status,
      recommended: report.recommended,
    }),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
