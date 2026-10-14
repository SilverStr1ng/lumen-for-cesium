import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { sourceVersion } from "./browser-tools.mjs";
const args = process.argv,
  explicit = args.find((a) => a.startsWith("--output="))?.slice(9),
  out =
    explicit ??
    `reports/ballpool-curved-receivers-v8/run-${new Date().toISOString().replaceAll(":", "-")}`,
  cached = args.includes("--cached"),
  root = path.resolve("reports");
if (!path.resolve(out).startsWith(root + path.sep))
  throw Error("R9 output must be inside reports");
const scripts = [
    "verify-r9",
    "verify-ballpool",
    "verify-ballpool-descriptor",
    "verify-ballpool-desktop",
    "verify-curved-receivers",
    "verify-curved-contract",
    "verify-curved-topology",
    "verify-curved-temporal",
    "benchmark-ballpool-preview",
    "benchmark-fg-runtime",
    "benchmark-ballpool",
    "verify-r8",
  ],
  current = sourceVersion([
    ...scripts.map((n) => `scripts/${n}.mjs`),
    "package.json",
    "package-lock.json",
    "node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs",
  ]),
  configuration = {
    budget: 64 * 1048576,
    baseline: "818ef240debddf322dd4be7ec504e5709b2a8b8e",
    fixedQuality: "high32r",
    interactiveQuality: "interactive16",
    scenes: ["original", "gallery", "ballpool"],
    activities: ["static", "moving", "relight"],
  },
  fingerprint = (v) =>
    JSON.stringify({
      sources: v.sources,
      compiledBundle: v.compiledBundle,
      assets: v.assets,
    });
await mkdir(out, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (cached) {
  let report;
  try {
    report = JSON.parse(await readFile(out + "/test-suite.json", "utf8"));
    if (
      fingerprint(report.version) !== fingerprint(current) ||
      JSON.stringify(report.configuration) !== JSON.stringify(configuration)
    )
      throw Error("cached source/build/assets/config mismatch");
    for (const [file, digest] of Object.entries(report.inputs)) {
      if (sha(await readFile(file)) !== digest)
        throw Error(`cached evidence mismatch: ${file}`);
    }
    report.cachedVerification = {
      verified: true,
      at: new Date().toISOString(),
      head: current.head,
    };
    await writeFile(
      out + "/cached-verification.json",
      JSON.stringify(report.cachedVerification, null, 2),
    );
    console.log(
      JSON.stringify({
        states: report.states,
        recommended: report.recommended,
        cached: true,
      }),
    );
    if (!report.recommended) process.exitCode = 1;
  } catch (e) {
    console.error(String(e));
    process.exitCode = 1;
  }
} else {
  if ((await readdir(out)).length)
    throw Error("Use a new output directory; existing evidence is immutable");
  const report = {
    version: current,
    configuration,
    started: new Date().toISOString(),
    tests: [],
    states: {},
    inputs: {},
    recommended: false,
    notRun: [],
  };
  const run = async (name, parameters = [], directory = out) => {
    const index = report.tests.length,
      log = `${out}/run-${index}-${name}.log`,
      start = performance.now();
    console.log(`RUN ${name} ${parameters.join(" ")}`);
    const exitCode = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [`scripts/${name}.mjs`, ...parameters],
        {
          windowsHide: true,
          env: { ...process.env, LUMEN_REPORT_DIRECTORY: directory },
        },
      );
      child.stdout.on("data", (b) => appendFileSync(log, b));
      child.stderr.on("data", (b) => appendFileSync(log, b));
      child.on("error", (e) => {
        appendFileSync(log, String(e));
        resolve(-1);
      });
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const row = {
      name,
      parameters,
      directory,
      exitCode,
      status: exitCode === 0 ? "passed" : "failed",
      milliseconds: performance.now() - start,
      log,
    };
    report.tests.push(row);
    await writeFile(out + "/progress.json", JSON.stringify(report, null, 2));
    console.log(`${row.status.toUpperCase()} ${name}`);
    return row;
  };
  const group = async (label, jobs) => {
    report.states[label] = "passed";
    for (const [name, parameters = []] of jobs)
      if ((await run(name, parameters)).exitCode !== 0)
        report.states[label] = "failed";
  };
  await group("curved-quality", [
    ["verify-curved-contract"],
    ["verify-curved-topology"],
    ["verify-curved-receivers"],
  ]);
  await group("curved-temporal", [["verify-curved-temporal"]]);
  await group("ballpool-frozen-GI", [
    ["verify-ballpool-descriptor"],
    ["verify-ballpool"],
  ]);
  for (const state of ["physics-interaction", "snapshot-consistency"])
    report.states[state] = report.states["ballpool-frozen-GI"];
  await group("resource", [["verify-ballpool-desktop"]]);
  await group("physics-preview-performance", [["benchmark-ballpool-preview"]]);
  const regression = await run(
    "verify-r8",
    ["--quality-only", `--output=${out}/regression`],
    out + "/regression",
  );
  try {
    const r = JSON.parse(
      await readFile(out + "/regression/test-suite.json", "utf8"),
    );
    report.states.regression = r.states.regression;
    report.states["fixed-quality-regression"] = r.states["fixed-quality"];
    report.states["Auto-quality-regression"] = r.states["auto-quality"];
    report.states["temporal-regression"] = r.states.temporal;
    report.states.showcase = r.states.showcase;
  } catch (e) {
    report.states.regression = "failed";
    report.regressionError = String(e);
  }
  const performances = {
    "fixed32-performance": [],
    "interactive-performance": [],
    "ballpool-static-performance": [],
  };
  for (const quality of ["high", "interactive16"])
    for (const scene of ["original", "gallery"])
      for (const activity of ["static", "moving", "relight"]) {
        const row = await run("benchmark-fg-runtime", [
          `--scene=${scene}`,
          `--quality=${quality}`,
          `--activity=${activity}`,
          "--azimuth",
          "--lazy",
        ]);
        performances[
          quality === "high" ? "fixed32-performance" : "interactive-performance"
        ].push(row);
      }
  for (const quality of ["auto", "interactive16"])
    performances["ballpool-static-performance"].push(
      await run("benchmark-fg-runtime", [
        "--scene=ballpool",
        `--quality=${quality}`,
        "--activity=static",
        "--azimuth",
        "--lazy",
      ]),
    );
  for (const [name, rows] of Object.entries(performances))
    report.states[name] = rows.every((r) => r.exitCode === 0)
      ? "passed"
      : "failed";
  const history = JSON.parse(
    await readFile(
      "reports/fg-runtime-budget-v7/acceptance-20261014-final/test-suite.json",
      "utf8",
    ),
  );
  report.r8Historical = {
    head: history.version.head,
    states: history.states,
    recommended: history.recommended,
  };
  for (const row of report.tests)
    report.inputs[row.log] = sha(await readFile(row.log));
  const collect = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = dir + "/" + entry.name;
      if (entry.isDirectory()) await collect(file);
      else if (
        ![
          "progress.json",
          "test-suite.json",
          "cached-verification.json",
        ].includes(entry.name)
      )
        report.inputs[file] = sha(await readFile(file));
    }
  };
  await collect(out);
  report.recommended =
    Object.values(report.states).every((v) => v === "passed") &&
    !report.notRun.length;
  report.status = report.recommended ? "passed" : "failed";
  report.finished = new Date().toISOString();
  report.unmeasured = [
    "physical driver VRAM",
    "GPU assembly/register pressure",
    "worker JS heap overhead",
    "authenticated ion/World Terrain",
    "continuous moving multi-bounce GI",
  ];
  await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      states: report.states,
      recommended: report.recommended,
    }),
  );
  if (!report.recommended) process.exitCode = 1;
}
