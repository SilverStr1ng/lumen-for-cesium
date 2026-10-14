import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourceVersion } from "./browser-tools.mjs";
const output =
    process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
    `reports/contact-transport-v9/run-${new Date().toISOString().replaceAll(":", "-")}`,
  cached = process.argv.includes("--cached");
if (!path.resolve(output).startsWith(path.resolve("reports") + path.sep))
  throw Error("R10 output must be under reports");
const required = [
  "regression",
  "ray-origin",
  "attribution",
  "contact-query",
  "contact-image",
  "temporal",
  "surface-cache",
  "lifecycle",
  "resource",
  "fixed32-performance",
  "interactive-performance",
  "rebuild-latency",
  "showcase",
];
const configuration = {
  baseline: "522201e5f6bd6e1b751eacfa8ae3afc4a8f3daf2",
  count: [1, 2, 16, 64, 128],
  qualityCases: 60,
  queryLimit: 0.12,
  imageLimit: 0.2,
  coverage: 0.95,
  bounces: 3,
  probeSpacing: 2,
  probeRays: 128,
  exposure: 1,
  budget: 64 * 1048576,
  source:
    "experimental surface cache .08m area scale /256r; immediate control preserved",
};
const extra = (await readdir("scripts"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => "scripts/" + f)
  .concat([
    "package.json",
    "package-lock.json",
    "node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs",
    "reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved.json",
  ]);
const version = sourceVersion(extra),
  sha = (b) => createHash("sha256").update(b).digest("hex"),
  fingerprint = (v) =>
    JSON.stringify({
      sources: v.sources,
      compiledBundle: v.compiledBundle,
      assets: v.assets,
    });
await mkdir(output, { recursive: true });
async function derive(report) {
  const states = Object.fromEntries(required.map((s) => [s, "not-run"])),
    errors = [];
  const get = async (key) => {
    try {
      return JSON.parse(await readFile(output + "/" + key, "utf8"));
    } catch (e) {
      errors.push(key + ": " + String(e));
      return null;
    }
  };
  const stateFor = (key) => {
    const tests = report.tests.filter((t) => t.group === key);
    return !tests.length
      ? "not-run"
      : tests.every((t) => t.exitCode === 0)
        ? "passed"
        : "failed";
  };
  states["ray-origin"] = stateFor("ray-origin");
  states["surface-cache"] = stateFor("surface-cache");
  states.temporal = stateFor("temporal");
  states.lifecycle = stateFor("lifecycle");
  states.resource = stateFor("resource");
  states.attribution = stateFor("root-cause");
  const quality = await get("quality-cache/curved.json");
  if (quality) {
    const complete =
      quality.rows.length === 60 &&
      !quality.configuration.quick &&
      quality.configuration.contact &&
      quality.configuration.source === "cache" &&
      !quality.errors.length &&
      !quality.renderErrors.length;
    const query =
      complete &&
      quality.rows.every(
        (r) =>
          r.source.actual === "cache" &&
          r.sourceUse.cachedHits > 0 &&
          r.sourceUse.unknown === 0 &&
          r.queryNRMSE <= 0.12 &&
          Object.values(r.regionErrors).every(
            (v) => !v.points.length || v.queryNRMSE <= 0.12,
          ),
      );
    const image =
      complete &&
      quality.rows.every(
        (r) =>
          r.linearNRMSE <= 0.2 &&
          r.meanWeight >= 0.95 &&
          Object.values(r.regionErrors).every(
            (v) => !v.points.length || v.linearNRMSE <= 0.2,
          ),
      );
    states["contact-query"] = query ? "passed" : "failed";
    states["contact-image"] = image ? "passed" : "failed";
  }
  const regression = await get("regression/test-suite.json");
  if (regression) {
    states.regression = [
      "regression",
      "fixed-quality",
      "auto-quality",
      "temporal",
      "resource",
      "showcase",
    ].every((k) => regression.states[k] === "passed")
      ? "passed"
      : "failed";
    states.showcase = regression.states.showcase;
  }
  const cost = await get("cache-cost/contact-cost.json");
  const validCost =
    cost &&
    cost.errors.length === 0 &&
    cost.configuration.rounds === 3 &&
    cost.rows.length === 72 &&
    cost.backendPairs.length === 24;
  for (const [state, quality] of [
    ["fixed32-performance", "high"],
    ["interactive-performance", "interactive16"],
  ]) {
    const old = report.tests.filter((t) => t.group === state),
      fresh = cost?.rows.filter(
        (r) =>
          r.quality === (quality === "high" ? "auto" : "interactive16") &&
          r.gates,
      );
    states[state] =
      !old.length || !cost
        ? "not-run"
        : old.length === 6 &&
            old.every((t) => t.exitCode === 0) &&
            validCost &&
            fresh.length === 12 &&
            fresh.every((r) => r.gates.status === "passed")
          ? "passed"
          : "failed";
  }
  const updates = cost?.updates ?? [];
  states["rebuild-latency"] = !cost
    ? "not-run"
    : validCost &&
        updates.length === 4 &&
        updates.every(
          (u) =>
            u.wallMilliseconds > 0 &&
            u.state.resources.peakAdditionalBytes <= 64 * 1048576,
        )
      ? "passed"
      : "failed";
  if (errors.length)
    states.regression = states.regression === "not-run" ? "not-run" : "failed";
  return {
    states,
    errors,
    recommended: required.every((s) => states[s] === "passed"),
    status: required.every((s) => states[s] === "passed") ? "passed" : "failed",
  };
}
if (cached) {
  try {
    const report = JSON.parse(
      await readFile(output + "/test-suite.json", "utf8"),
    );
    if (
      fingerprint(report.version) !== fingerprint(version) ||
      JSON.stringify(report.configuration) !== JSON.stringify(configuration)
    )
      throw Error(
        "Cached source/build/assets/dependencies/configuration mismatch",
      );
    for (const [file, digest] of Object.entries(report.inputs)) {
      if (!path.resolve(file).startsWith(path.resolve(output) + path.sep))
        throw Error("Cached input escaped output");
      if (sha(await readFile(file)) !== digest)
        throw Error("Cached artifact mismatch: " + file);
      if (file.endsWith("/test-suite.json")) {
        const nested = JSON.parse(await readFile(file, "utf8"));
        for (const [dependency, hash] of Object.entries(nested.inputs ?? {}))
          if (sha(await readFile(dependency)) !== hash)
            throw Error("Nested dependency mismatch: " + dependency);
      }
    }
    for (const t of report.tests)
      if (!Number.isInteger(t.exitCode) || !report.inputs[t.log])
        throw Error("Missing actual child exit/log: " + t.name);
    const actual = await derive(report);
    if (
      JSON.stringify(actual.states) !== JSON.stringify(report.states) ||
      actual.recommended !== report.recommended ||
      actual.status !== report.status
    )
      throw Error("Cached aggregate contradicts mandatory evidence");
    await writeFile(
      output + "/cached-verification.json",
      JSON.stringify(
        { verified: true, at: new Date().toISOString(), head: version.head },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ...actual, cached: true }));
    if (!actual.recommended) process.exitCode = 1;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
} else {
  if ((await readdir(output)).length)
    throw Error("Use a new immutable R10 output directory");
  const report = {
    version,
    configuration,
    tests: [],
    inputs: {},
    started: new Date().toISOString(),
    states: Object.fromEntries(required.map((s) => [s, "not-run"])),
    recommended: false,
  };
  const run = async (name, group, dir, args = [], env = {}) => {
    const target = output + "/" + dir;
    await mkdir(target, { recursive: true });
    const log = target + "/" + name + ".log",
      start = performance.now();
    console.log("RUN " + name + " " + dir);
    const handle = await import("node:fs");
    const stream = handle.createWriteStream(log, { flags: "wx" });
    const exitCode = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["scripts/" + name + ".mjs", ...args],
        {
          windowsHide: true,
          env: {
            ...process.env,
            LUMEN_REPORT_DIRECTORY: target,
            LUMEN_PARENT_RUN_LOG: log,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
      child.on("error", (e) => {
        stream.write(String(e));
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
    await new Promise((resolve) => stream.end(resolve));
    report.tests.push({
      name,
      group,
      dir,
      arguments: args,
      environment: env,
      exitCode,
      milliseconds: performance.now() - start,
      log,
    });
    console.log("DONE " + name + " exit " + exitCode);
    await writeFile(
      output + "/progress.json",
      JSON.stringify(report.tests, null, 2),
    );
  };
  await run("verify-contact-origins", "ray-origin", "origin");
  await run("verify-contact-geometry", "ray-origin", "geometry");
  await run("diagnose-contact-transport", "root-cause", "root-legacy", [], {
    LUMEN_CONTACT_POLICY: "legacy-15mm",
  });
  await run("diagnose-contact-transport", "root-cause", "root-physical", [], {
    LUMEN_CONTACT_POLICY: "physical",
  });
  await run("verify-surface-layout", "surface-cache", "surface-layout");
  await run("verify-contact-cache", "surface-cache", "surface-finite", [], {
    LUMEN_CACHE_COUNTS: "1,2,16,64",
  });
  await run(
    "verify-curved-receivers",
    "control-quality",
    "quality-immediate",
    [],
    {
      LUMEN_CONTACT_TRANSPORT: "1",
      LUMEN_CURVE_QUICK: "0",
      LUMEN_RADIANCE_SOURCE: "immediate",
    },
  );
  await run("verify-curved-receivers", "contact-quality", "quality-cache", [], {
    LUMEN_CONTACT_TRANSPORT: "1",
    LUMEN_CURVE_QUICK: "0",
    LUMEN_RADIANCE_SOURCE: "cache",
  });
  await run("verify-curved-temporal", "temporal", "temporal", [], {
    LUMEN_RADIANCE_SOURCE: "cache",
  });
  await run("verify-contact-lifecycle", "lifecycle", "cache-lifecycle");
  await run("verify-ballpool", "lifecycle", "ballpool-lifecycle");
  await run("verify-ballpool-desktop", "resource", "desktop", [], {
    LUMEN_RADIANCE_SOURCE: "cache",
  });
  await run("verify-r8", "regression", "regression", [
    "--without-performance",
    "--output=" + output + "/regression",
  ]);
  for (const quality of ["high", "interactive16"])
    for (const scene of ["original", "gallery"])
      for (const activity of ["static", "moving", "relight"])
        await run(
          "benchmark-fg-runtime",
          quality === "high"
            ? "fixed32-performance"
            : "interactive-performance",
          `performance-${scene}-${quality}-${activity}`,
          [
            `--scene=${scene}`,
            `--quality=${quality}`,
            `--activity=${activity}`,
            "--azimuth",
            "--lazy",
          ],
        );
  await run("benchmark-contact-cache", "cache-cost", "cache-cost", [], {
    LUMEN_COST_QUALITIES: "auto,interactive16",
    LUMEN_COST_ACTIVITIES: "static,moving",
    LUMEN_COST_ROUNDS: "3",
  });
  async function collect(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = dir + "/" + e.name;
      if (e.isDirectory()) await collect(f);
      else if (
        f !== output + "/test-suite.json" &&
        f !== output + "/progress.json" &&
        e.name !== "cached-verification.json"
      )
        report.inputs[f] = sha(await readFile(f));
    }
  }
  await collect(output);
  Object.assign(report, await derive(report));
  report.finished = new Date().toISOString();
  report.notRun = [
    "physical driver VRAM",
    "worker JS heap overhead",
    "continuous moving multi-bounce GI",
    "new cache pure-overhead relight performance (source/revision changes; busy frames and full update costs are separate)",
  ];
  await writeFile(
    output + "/test-suite.json",
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      states: report.states,
      status: report.status,
      recommended: report.recommended,
    }),
  );
  if (!report.recommended) process.exitCode = 1;
}
