import { spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourceVersion } from "./browser-tools.mjs";
import {
  artifactMatches,
  versionMatches,
  performancePassed,
  qualityPassed,
  aggregate,
  configurations,
  performanceConfigurations,
  performanceFile,
  performanceArguments,
  requiredInputsPresent,
  childGroupState,
} from "./r8-acceptance.mjs";
const out = "reports/fg-runtime-budget-v7",
  cached = process.argv.includes("--cached"),
  onlyQuality = process.argv.includes("--quality-only");
const configs = configurations;
const regressions = [
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
  "r7-acceptance",
  "r7-timers",
  "fg-sampling",
  "fg-history",
  "fg-barriers",
  "fg-statistics",
  "fg-lifecycle",
  "gallery",
  "r8-acceptance",
  "fg-budget",
  "fg-order",
  "fg-execution",
  "fg-desktop",
];
const scriptNames = [
  "lint-r6",
  ...regressions.map((n) => "verify-" + n),
  "verify-r8",
  "verify-fg-temporal",
  "measure-fg-milliseconds",
  "measure-fg-canonical",
  "capture-fg-reconstruction",
  "verify-fg-quality",
  "benchmark-fg-runtime",
  "verify-export-patch",
  "r8-acceptance",
];
const current = sourceVersion(scriptNames.map((n) => "scripts/" + n + ".mjs"));
const report = {
  version: current,
  configuration: {
    configs,
    execution: "split",
    rayOrder: "azimuth",
    lazyFallback: true,
    budget: 64 * 1048576,
  },
  started: new Date().toISOString(),
  tests: [],
  states: {},
  notRun: [],
};
await mkdir(out + "/compatibility-raw", { recursive: true });
const listed = (args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter((p) => p && !p.startsWith(out + "/"));
const tracked = listed(["ls-files", "reports"]),
  untracked = () =>
    listed(["ls-files", "--others", "--exclude-standard", "reports"]);
const initial = new Set(untracked()),
  saved = new Map(
    await Promise.all(
      [...new Set([...tracked, ...initial])].map(async (p) => [
        p,
        await readFile(p),
      ]),
    ),
  );
const digest = (b) => createHash("sha256").update(b).digest("hex");
const json = async (f) => JSON.parse(await readFile(f, "utf8"));
const inputs = {};
let priorManifest;
const run = (name, args = [], extra = {}) => {
  const started = performance.now(),
    r = spawnSync(process.execPath, ["scripts/" + name + ".mjs", ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3600000,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        ...process.env,
        LUMEN_REPORT: out + "/compatibility-raw/" + name + ".json",
        LUMEN_REPORT_DIRECTORY: out + "/compatibility-raw",
        ...extra,
      },
    });
  const row = {
    name,
    args,
    environment: extra,
    exitCode: r.status,
    milliseconds: performance.now() - started,
    error: r.error?.message,
    status: r.status === 0 ? "passed" : "failed",
  };
  report.tests.push(row);
  console.log(
    row.status.toUpperCase(),
    name,
    JSON.stringify(args),
    JSON.stringify(extra),
  );
  inputs[out + "/compatibility-raw/run-" + report.tests.length + ".json"] =
    JSON.stringify({ ...row, stdout: r.stdout, stderr: r.stderr }, null, 2);
  return row;
};
const envFor = (c) => ({
  LUMEN_FG_REPORT: out + "/" + c.id,
  LUMEN_FG_AUTO: c.auto ? "1" : "0",
  LUMEN_FG_WIDTH: String(c.viewport.width),
  LUMEN_FG_HEIGHT: String(c.viewport.height),
});
const hasInputs = async (files) => {
  for (const f of files) {
    const resolved = path.resolve(f),
      base = path.resolve(".") + path.sep;
    if (!resolved.startsWith(base)) return false;
    try {
      if (digest(await readFile(f)) !== priorManifest.inputs[f]) return false;
    } catch {
      return false;
    }
  }
  return true;
};
const readMeasured = async (file, configuration) => {
  const data = await json(file),
    mandatory = Object.keys(sourceVersion().sources);
  if (!artifactMatches(data, current, configuration, mandatory))
    throw Error("capture source/build/assets/config mismatch: " + file);
  return data;
};
const requiredProducersPresent = (tests) => {
  const exact = (name, args = [], cfg) =>
    tests.filter(
      (r) =>
        r.name === name &&
        JSON.stringify(r.args) === JSON.stringify(args) &&
        (!cfg || r.environment?.LUMEN_FG_REPORT === out + "/" + cfg.id),
    ).length === 1;
  return (
    [
      "lint-r6",
      ...regressions.map((n) => "verify-" + n),
      "verify-export-patch",
    ].every((n) => exact(n)) &&
    configs.every((c) =>
      [
        "measure-fg-canonical",
        "capture-fg-reconstruction",
        "verify-fg-temporal",
        "measure-fg-milliseconds",
      ].every((n) => exact(n, [], c)),
    ) &&
    performanceConfigurations().every((c) =>
      exact("benchmark-fg-runtime", performanceArguments(c)),
    )
  );
};
try {
  if (cached) {
    priorManifest = await json(out + "/manifest.json");
    if (
      !versionMatches(priorManifest.version, current) ||
      JSON.stringify(priorManifest.configuration) !==
        JSON.stringify(report.configuration) ||
      !requiredInputsPresent(priorManifest.inputs, out) ||
      !(await hasInputs(Object.keys(priorManifest.inputs))) ||
      !requiredProducersPresent(priorManifest.tests)
    )
      throw Error("cached required inputs changed or incomplete");
    report.tests = priorManifest.tests;
    report.states.regression = childGroupState(report.tests, [
      "lint-r6",
      ...regressions.map((n) => "verify-" + n),
      "verify-export-patch",
    ]);
    report.states.resource = childGroupState(report.tests, [
      "verify-fg-budget",
      "verify-fg-desktop",
      "verify-fg-lifecycle",
      "verify-resource-lifecycle",
    ]);
    report.states.showcase = childGroupState(report.tests, ["verify-gallery"]);
    report.cache = {
      status: "verified",
      inputs: Object.keys(priorManifest.inputs).length,
    };
  } else {
    if (!onlyQuality) {
      run("lint-r6");
      for (const n of regressions) run("verify-" + n);
      report.states.regression = report.tests.every((r) => r.exitCode === 0)
        ? "passed"
        : "failed";
      report.states.resource = report.tests
        .filter((r) =>
          [
            "verify-fg-budget",
            "verify-fg-desktop",
            "verify-fg-lifecycle",
            "verify-resource-lifecycle",
          ].includes(r.name),
        )
        .every((r) => r.exitCode === 0)
        ? "passed"
        : "failed";
      report.states.showcase =
        report.tests.find((r) => r.name === "verify-gallery")?.exitCode === 0
          ? "passed"
          : "failed";
    } else
      report.states.regression =
        report.states.resource =
        report.states.showcase =
          "not-run";
    for (const c of configs) {
      run("measure-fg-canonical", [], envFor(c));
      run("capture-fg-reconstruction", [], envFor(c));
      run("verify-fg-temporal", [], envFor(c));
      run("measure-fg-milliseconds", [], envFor(c));
    }
    if (!onlyQuality) {
      for (const c of performanceConfigurations())
        run("benchmark-fg-runtime", performanceArguments(c), {
          LUMEN_REPORT_DIRECTORY: out + "/active",
        });
      if (run("verify-export-patch").exitCode !== 0)
        report.states.regression = "failed";
    }
  }
  report.states.temporal = "not-run";
  let temporalPassed = true;
  for (const c of configs) {
    const qFile = cached
      ? out + "/validation/" + c.id + "-quality.json"
      : out + "/" + c.id + "/quality.json";
    const q = run("verify-fg-quality", [], {
      ...envFor(c),
      LUMEN_QUALITY_REPORT: qFile,
    });
    const quality = await json(qFile);
    await readMeasured(out + "/" + c.id + "/canonical.json", {
      auto: c.auto,
      viewport: c.viewport,
    });
    await readMeasured(out + "/" + c.id + "/screen/data.json", {
      auto: c.auto,
      viewport: c.viewport,
    });
    const producers = report.tests.filter(
      (r) =>
        ["measure-fg-canonical", "capture-fg-reconstruction"].includes(
          r.name,
        ) && r.environment?.LUMEN_FG_REPORT === out + "/" + c.id,
    );
    const passed =
      qualityPassed(quality, q) &&
      producers.length === 2 &&
      new Set(producers.map((r) => r.name)).size === 2 &&
      producers.every((r) => r.exitCode === 0);
    report.states[c.auto ? "auto-quality" : "fixed-quality"] =
      report.states[c.auto ? "auto-quality" : "fixed-quality"] === "failed" ||
      !passed
        ? "failed"
        : "passed";
    const temporal = await json(out + "/" + c.id + "/temporal/data.json");
    const milliseconds = await readMeasured(
      out + "/" + c.id + "/same-milliseconds.json",
      { auto: c.auto, viewport: c.viewport },
    );
    if (milliseconds.status !== "passed" || milliseconds.rows.length !== 36)
      temporalPassed = false;
    const temporalProducers = report.tests.filter(
      (r) =>
        ["verify-fg-temporal", "measure-fg-milliseconds"].includes(r.name) &&
        r.environment?.LUMEN_FG_REPORT === out + "/" + c.id,
    );
    if (
      temporalProducers.length !== 2 ||
      new Set(temporalProducers.map((r) => r.name)).size !== 2 ||
      temporal.status !== "passed" ||
      !artifactMatches(
        temporal,
        current,
        { auto: c.auto, viewport: c.viewport },
        Object.keys(sourceVersion().sources),
      ) ||
      report.tests
        .filter(
          (r) =>
            ["verify-fg-temporal", "measure-fg-milliseconds"].includes(
              r.name,
            ) && r.environment?.LUMEN_FG_REPORT === out + "/" + c.id,
        )
        .some((r) => r.exitCode !== 0)
    )
      temporalPassed = false;
  }
  report.states.temporal = temporalPassed ? "passed" : "failed";
  const injected = run("verify-fg-quality", ["--inject-error"], {
    ...envFor(configs[0]),
    LUMEN_QUALITY_REPORT: out + "/validation/fixed-injected.json",
  });
  const missingLine = run("verify-fg-quality", ["--inject-missing-line"], {
    ...envFor(configs[0]),
    LUMEN_QUALITY_REPORT: out + "/validation/fixed-line-injected.json",
  });
  const fakeCoverage = run("verify-fg-quality", ["--inject-coverage"], {
    ...envFor(configs[0]),
    LUMEN_QUALITY_REPORT: out + "/validation/fixed-coverage-injected.json",
  });
  if (
    injected.exitCode !== 1 ||
    fakeCoverage.exitCode !== 1 ||
    missingLine.exitCode !== 1
  )
    report.states.regression = "failed";
  if (onlyQuality) report.states.performance = "not-run";
  else {
    report.states.performance = "passed";
    report.performance = [];
    const expected = performanceConfigurations(),
      files = (await readdir(out + "/active")).filter((f) =>
        f.endsWith(".json"),
      );
    if (
      files.length !== expected.length ||
      !expected.every((c) => files.includes(performanceFile(c)))
    )
      throw Error("required unique active+pause matrix missing");
    for (const config of expected) {
      const f = performanceFile(config),
        data = await readMeasured(out + "/active/" + f, config),
        args = performanceArguments(config);
      const producers = report.tests.filter(
        (r) =>
          r.name === "benchmark-fg-runtime" &&
          JSON.stringify(r.args) === JSON.stringify(args),
      );
      const passed =
        producers.length === 1 && performancePassed(data, producers[0]);
      report.performance.push({
        file: f,
        configuration: config,
        targets: data.targets,
        checks: data.checks,
        status: passed ? "passed" : "failed",
      });
      if (!passed) report.states.performance = "failed";
    }
  }
} catch (e) {
  report.error = e.stack;
  report.states.regression = "failed";
} finally {
  report.restorationErrors = [];
  for (const [p, old] of saved) {
    try {
      let now;
      try {
        now = await readFile(p);
      } catch {}
      if (now && !now.equals(old)) {
        const target = out + "/compatibility-raw/" + p.slice(8);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, now);
      }
      if (!now || !now.equals(old)) await writeFile(p, old);
    } catch (e) {
      report.restorationErrors.push({ path: p, error: e.message });
    }
  }
  for (const p of untracked().filter((p) => !initial.has(p))) {
    const target = out + "/compatibility-raw/" + p.slice(8);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(p));
    await unlink(p);
  }
  for (const [f, data] of Object.entries(inputs)) await writeFile(f, data);
  if (report.restorationErrors.length) report.states.regression = "failed";
  for (const name of [
    "regression",
    "fixed-quality",
    "auto-quality",
    "temporal",
    "performance",
    "resource",
    "showcase",
  ])
    report.states[name] ??= "not-run";
  report.notRun.push(
    {
      name: "authenticated ion / World Terrain",
      reason: "no token supplied; local Globe retained",
    },
    {
      name: "shader assembly/register pressure",
      reason: "not exposed by WebGL/ANGLE",
    },
  );
  Object.assign(report, aggregate(report.states));
  report.finished = new Date().toISOString();
  await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  if (!cached && !onlyQuality) {
    const requiredFiles = (await readdir(out, { recursive: true }))
      .map((f) => out + "/" + f.replaceAll("\\", "/"))
      .filter(
        (f) =>
          /\.(json|deflate|png)$/.test(f) &&
          !f.endsWith("/manifest.json") &&
          !f.endsWith("/test-suite.json") &&
          [
            "/fixed/",
            "/auto-1920/",
            "/auto-2560/",
            "/active/",
            "/compatibility-raw/",
          ].some((s) => f.replaceAll("\\", "/").includes(s)),
      );
    requiredFiles.push(
      "reports/receiver-final-gather-v5/abcd.json",
      "reports/ddgi-visual-quality-v4/before/diagnostics.json",
      "reports/ddgi-visual-quality-v4/independent-reference.json",
    );
    const hashes = {};
    for (const f of requiredFiles) hashes[f] = digest(await readFile(f));
    await writeFile(
      out + "/manifest.json",
      JSON.stringify(
        {
          version: current,
          configuration: report.configuration,
          inputs: hashes,
          states: report.states,
          tests: report.tests,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    JSON.stringify({
      states: report.states,
      status: report.status,
      recommended: report.recommended,
      error: report.error,
      restorationErrors: report.restorationErrors,
    }),
  );
  process.exitCode = report.exitCode;
}
