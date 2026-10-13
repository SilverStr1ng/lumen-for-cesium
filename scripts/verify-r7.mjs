import { spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { sourceVersion } from "./browser-tools.mjs";
import {
  testPassed,
  performancePassed,
  captureMatches,
} from "./r7-acceptance.mjs";
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
  await Promise.all(
    [...new Set([...tracked, ...initialUntracked])].map(async (p) => [
      p,
      await readFile(p),
    ]),
  ),
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
const resilientWrite = async (file, data) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, data);
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
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
      "r7-acceptance",
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
    const child = (name) =>
      report.tests.find((x) => x.script === name && !x.args.length);
    if (
      !cached &&
      ["measure-fg-canonical", "capture-fg-reconstruction"].some(
        (name) => child(name)?.exitCode !== 0,
      )
    )
      report.quality = "failed";
    const temporal = await json("temporal/data.json"),
      life = await json("lifecycle.json");
    report.temporal =
      testPassed(temporal, child("verify-fg-temporal")) &&
      testPassed(life, child("verify-fg-lifecycle"))
        ? "passed"
        : "failed";
    const perf = await json("performance.json");
    report.performance = performancePassed(
      perf,
      child("benchmark-fg-reconstruction"),
      cached,
    )
      ? "passed"
      : "failed";
    report.showcase = testPassed(
      await json("gallery/data.json"),
      child("verify-gallery"),
    )
      ? "passed"
      : "failed";
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
    const captureFiles = [
      ...new Set(
        Object.values(report.captureVersions).flatMap((v) =>
          Object.keys(v?.sources ?? {}),
        ),
      ),
    ];
    const sourceRoot = path.resolve(".") + path.sep;
    const currentCaptureSources = Object.fromEntries(
      await Promise.all(
        captureFiles.map(async (file) => {
          if (!path.resolve(file).startsWith(sourceRoot))
            return [file, undefined];
          try {
            return [
              file,
              createHash("sha256")
                .update((await readFile(file, "utf8")).replaceAll("\r\n", "\n"))
                .digest("hex"),
            ];
          } catch {
            return [file, undefined];
          }
        }),
      ),
    );
    report.captureSourceMatch = Object.values(report.captureVersions).every(
      (v) =>
        captureMatches(
          v,
          currentCaptureSources,
          report.version.compiledBundle,
          Object.keys(report.version.sources),
        ),
    );
    if (!report.captureSourceMatch) {
      report.notRun.push({
        name: "current-source numeric/performance acceptance",
        reason:
          "capture source hashes or compiled bundle differ; existing snapshots remain inspectable",
      });
      if (report.quality !== "failed") report.quality = "not-run";
      if (report.performance !== "failed") report.performance = "not-run";
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
  report.restorationErrors = [];
  for (const [p, old] of saved) {
    try {
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
        await resilientWrite(target, current);
      }
      if (!current || !current.equals(old)) await resilientWrite(p, old);
    } catch (error) {
      report.restorationErrors.push({ file: p, message: error.message });
    }
  }
  // Keep new timestamped compatibility evidence inside this revision's report.
  // Existing untracked user files are preserved; only files created by this run move.
  const reportRoot = path.resolve("reports") + path.sep;
  for (const p of untrackedReports().filter((p) => !initialUntracked.has(p))) {
    if (!path.resolve(p).startsWith(reportRoot))
      throw Error("report path escaped workspace");
    const target = out + "/compatibility-raw/" + p.slice(8);
    await mkdir(path.dirname(target), { recursive: true });
    await resilientWrite(target, await readFile(p));
    await unlink(p);
  }
  if (report.restorationErrors.length) report.regression = "failed";
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
  await resilientWrite(
    out + "/test-suite.json",
    JSON.stringify(report, null, 2),
  );
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
