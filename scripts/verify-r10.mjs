import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourceVersion } from "./browser-tools.mjs";
const output =
    process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
    `reports/contact-transport-v9/run-${new Date().toISOString().replaceAll(":", "-")}`,
  cached = process.argv.includes("--cached"),
  recheck = process.argv.includes("--recheck");
if (cached && recheck)
  throw Error(
    "Choose strict cached verification or explicit aggregation recheck, not both",
  );
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
function contactStates(quality, childState) {
  const keys = new Set(
    quality?.rows?.map((r) => `${r.count}/${r.scenario}/${r.seed}/${r.view}`),
  );
  const expected = [];
  for (const count of [1, 2])
    for (const scenario of [
      "day",
      "black",
      "white-sky",
      "sun-turned",
      "colored-bounce",
    ])
      for (const seed of [0, 5, 19])
        for (const view of ["close", "contact"])
          expected.push(`${count}/${scenario}/${seed}/${view}`);
  const complete =
    childState === "passed" &&
    quality?.status === "passed" &&
    quality.rows.length === 60 &&
    keys.size === 60 &&
    expected.every((k) => keys.has(k)) &&
    !quality.configuration.quick &&
    quality.configuration.contact &&
    quality.configuration.source === "cache" &&
    quality.errors.length === 0 &&
    quality.renderErrors.length === 0 &&
    quality.failures.length === 0 &&
    quality.backends?.length === 2 &&
    quality.backends.every(
      (rows) =>
        rows.length === 3 &&
        ["split", "fused4", "fused8"].every((mode) =>
          rows.some(
            (r) =>
              r.execution === mode && r.delta <= 0.00001 && r.invalid === 0,
          ),
        ),
    ) &&
    quality.rows.every((r) => {
      const requiredRegions = [
        "foregroundContour",
        ...(r.view === "contact"
          ? ["ballFloorContact", ...(r.count === 2 ? ["ballBallContact"] : [])]
          : []),
      ];
      return (
        r.status === "passed" &&
        r.maxHistoryNormalDegrees <= 0.25 &&
        r.query.length > 0 &&
        r.query.every((p) => p.valid && !p.unknown) &&
        requiredRegions.every(
          (name) =>
            r.regions[name]?.pixels > 0 &&
            r.regionErrors[name]?.points.length > 0,
        )
      );
    });
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
  return {
    "contact-query": query ? "passed" : "failed",
    "contact-image": image ? "passed" : "failed",
  };
}
if (process.argv.includes("--self-test")) {
  const region = { pixels: 1 },
    error = { points: [1], queryNRMSE: 0.01, linearNRMSE: 0.01 },
    rows = [];
  for (const count of [1, 2])
    for (const scenario of [
      "day",
      "black",
      "white-sky",
      "sun-turned",
      "colored-bounce",
    ])
      for (const seed of [0, 5, 19])
        for (const view of ["close", "contact"])
          rows.push({
            count,
            scenario,
            seed,
            view,
            status: "passed",
            maxHistoryNormalDegrees: 0,
            query: [{ valid: true, unknown: false }],
            regions: {
              foregroundContour: region,
              ballFloorContact: region,
              ballBallContact: region,
            },
            regionErrors: {
              foregroundContour: error,
              ballFloorContact: error,
              ballBallContact: error,
            },
            source: { actual: "cache" },
            sourceUse: { cachedHits: 1, unknown: 0 },
            queryNRMSE: 0.01,
            linearNRMSE: 0.01,
            meanWeight: 0.96,
          });
  const good = {
    status: "passed",
    rows,
    configuration: { contact: true, quick: false, source: "cache" },
    errors: [],
    renderErrors: [],
    failures: [],
    backends: [1, 2].map(() =>
      ["split", "fused4", "fused8"].map((execution) => ({
        execution,
        delta: 0,
        invalid: 0,
      })),
    ),
  };
  assert.deepEqual(contactStates(good, "passed"), {
    "contact-query": "passed",
    "contact-image": "passed",
  });
  const mutations = [
    (q) => (q.rows[0].status = "failed"),
    (q) => (q.rows[0].query[0].valid = false),
    (q) => (q.rows[0].query[0].unknown = true),
    (q) => (q.rows[0].maxHistoryNormalDegrees = 0.26),
    (q) => (q.rows[0].regions.foregroundContour.pixels = 0),
    (q) => (q.rows[0].regionErrors.foregroundContour.points = []),
    (q) => (q.backends[0][1].invalid = 1),
    (q) => (q.backends[0][2].delta = 0.001),
    (q) => (q.rows[1] = q.rows[0]),
  ];
  assert(
    Object.values(contactStates(good, "failed")).every((s) => s === "failed"),
    "actual child exit 1 cannot pass",
  );
  for (const mutate of mutations) {
    const q = structuredClone(good);
    mutate(q);
    assert(
      Object.values(contactStates(q, "passed")).every((s) => s === "failed"),
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      checks: mutations.length + 2,
      scope:
        "original integrity and actual child failure cannot become recommended; no new region coverage threshold",
    }),
  );
  process.exit(0);
}
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
    Object.assign(states, contactStates(quality, stateFor("contact-quality")));
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
if (cached || recheck) {
  try {
    const report = JSON.parse(
      await readFile(output + "/test-suite.json", "utf8"),
    );
    const changed = [
      ...new Set([
        ...Object.keys(report.version.sources),
        ...Object.keys(version.sources),
      ]),
    ].filter((file) => report.version.sources[file] !== version.sources[file]);
    if (recheck) {
      const verifier = "scripts/verify-r10.mjs";
      if (
        changed.length !== 1 ||
        changed[0] !== verifier ||
        report.version.compiledBundle !== version.compiledBundle ||
        JSON.stringify(report.version.assets) !== JSON.stringify(version.assets)
      )
        throw Error("Recheck permits only the verifier itself to change");
      const original = execFileSync("git", [
        "show",
        `${report.version.head}:${verifier}`,
      ]);
      if (sha(original) !== report.version.sources[verifier])
        throw Error(
          "Execution verifier does not match original committed Git blob bytes",
        );
      if (version.modifiedSources.length)
        throw Error("Commit the verifier repair before recheck");
    }
    if (
      (!recheck && fingerprint(report.version) !== fingerprint(version)) ||
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
      !recheck &&
      (JSON.stringify(actual.states) !== JSON.stringify(report.states) ||
        actual.recommended !== report.recommended ||
        actual.status !== report.status)
    )
      throw Error("Cached aggregate contradicts mandatory evidence");
    const verification = recheck
      ? {
          verified: true,
          kind: "aggregation correction; GPU not rerun",
          executionHead: report.version.head,
          verifierHead: version.head,
          verifierHash: version.sources["scripts/verify-r10.mjs"],
          verifierByteHash: sha(await readFile("scripts/verify-r10.mjs")),
          originalSuiteHash: sha(await readFile(output + "/test-suite.json")),
          sourceDelta: changed,
          ...actual,
          at: new Date().toISOString(),
        }
      : { verified: true, at: new Date().toISOString(), head: version.head };
    const destination =
      output +
      (recheck ? "/rechecked-verification.json" : "/cached-verification.json");
    let existing;
    if (recheck) {
      try {
        existing = JSON.parse(await readFile(destination, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing) {
        for (const key of [
          "verified",
          "kind",
          "executionHead",
          "verifierHash",
          "originalSuiteHash",
          "sourceDelta",
          "states",
          "errors",
          "status",
          "recommended",
        ])
          if (
            JSON.stringify(existing[key]) !== JSON.stringify(verification[key])
          )
            throw Error(
              "Immutable recheck contradicts current evidence: " + key,
            );
        if (
          sha(
            execFileSync("git", [
              "show",
              `${existing.verifierHead}:scripts/verify-r10.mjs`,
            ]),
          ) !== existing.verifierHash
        )
          throw Error(
            "Recorded verifier does not match its committed Git blob",
          );
      }
    }
    if (!existing)
      await writeFile(
        destination,
        JSON.stringify(verification, null, 2),
        recheck ? { flag: "wx" } : undefined,
      );
    console.log(JSON.stringify({ ...actual, cached: !recheck, recheck }));
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
