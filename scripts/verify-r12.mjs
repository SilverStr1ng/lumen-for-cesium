import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { sourceVersion } from "./browser-tools.mjs";
import { newOutput, pilotBase } from "./pilot-validation.mjs";
import { runBounded } from "./pilot-process.mjs";
const scripts = (await readdir("scripts"))
  .filter((f) => /^verify-pilot.*\.mjs$/.test(f))
  .map((f) => "scripts/" + f);
const inputs = [
  ...scripts,
  "scripts/verify-pipeline.mjs",
  "scripts/verify-transport.mjs",
  "scripts/verify-fixtures.mjs",
  "scripts/verify-environment.mjs",
  "scripts/verify-curved-contract.mjs",
  "scripts/verify-r12.mjs",
  "scripts/benchmark-pilot.mjs",
  "scripts/pilot-validation.mjs",
  "scripts/pilot-process.mjs",
  "scripts/pilot-network.mjs",
  "scripts/gl-allocation-observer.mjs",
  "scripts/setup.mjs",
  "scripts/serve.mjs",
  "package.json",
  "package-lock.json",
  "cesium-1.146/package-lock.json",
  "docs/product/local-gi-v0.1.md",
  "docs/product/local-gi-resource-scope-v11.md",
  "docs/product/local-gi-deployment-v11.md",
  "docs/progress/readiness/baseline-v1.json",
  "docs/progress/readiness/v10-review.json",
  ...[
    "models-enhanced-day-overview",
    "models-enhanced-day-doorway",
    "tiles-enhanced-night-emitter",
  ].map(
    (name) => `reports/local-gi-pilot-v10/quality-candidate-3/${name}.json`,
  ),
];
const version = sourceVersion(inputs),
  configuration = {
    schema: 2,
    buffer: [1920, 1080],
    profiles: ["baseline", "enhanced"],
    cache: false,
    queryLimit: 0.12,
    usedLimit: 0.2,
    budget: 67108864,
    soakSeconds: 1800,
    pilotBase: pilotBase(),
    browserMode: process.env.LUMEN_HEADFUL === "1" ? "headed" : "headless",
    soakBrowserMode: "headed-natural-focus",
    required: [
      "assets",
      "session-lifecycle",
      "tiles-residency",
      "resource",
      "query-quality",
      "final-image-quality",
      "temporal",
      "performance",
      "relight-visible",
      "soak",
      "deployment",
    ],
  };
const cached = process.argv.includes("--cached");
const evidenceHashes = async (output) => {
  const entries = await readdir(output, {
    recursive: true,
    withFileTypes: true,
  });
  const hashes = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name !== "acceptance.json")
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const relative = path.relative(output, file).replaceAll("\\", "/");
        return [
          relative,
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ];
      }),
  );
  return Object.fromEntries(hashes.sort(([a], [b]) => a.localeCompare(b)));
};
const compatible = (v) =>
  v &&
  v.head === version.head &&
  v.compiledBundle === version.compiledBundle &&
  JSON.stringify(v.compiledFiles) === JSON.stringify(version.compiledFiles) &&
  JSON.stringify(v.assets) === JSON.stringify(version.assets) &&
  Object.entries(v.sources).every(([f, h]) => version.sources[f] === h) &&
  !v.modifiedSources.length &&
  !version.modifiedSources.length;
if (cached) {
  const output = process.env.LUMEN_REPORT_DIRECTORY;
  if (!output)
    throw Error("--cached requires explicit immutable LUMEN_REPORT_DIRECTORY");
  const old = JSON.parse(await readFile(output + "/acceptance.json", "utf8"));
  if (
    JSON.stringify(old.configuration) !== JSON.stringify(configuration) ||
    !compatible(old.version) ||
    JSON.stringify(old.version.sources) !== JSON.stringify(version.sources) ||
    JSON.stringify(old.evidence) !==
      JSON.stringify(await evidenceHashes(output))
  )
    throw Error(
      "Cached source/build/assets/configuration/recipe/HEAD mismatch",
    );
  const execution = JSON.parse(
    await readFile(output + "/execution.json", "utf8"),
  );
  if (JSON.stringify(execution.children) !== JSON.stringify(old.children))
    throw Error("Cached execution outcomes differ from summary");
  for (const [directory, file] of [
    ["assets", "assets"],
    ["lifecycle", "lifecycle"],
    ["equivalence", "equivalence"],
    ["quality", "quality"],
    ["runtime", "runtime"],
    ["performance", "benchmark"],
    ["deployment", "deployment"],
    ["soak", "soak"],
  ]) {
    const child = JSON.parse(
      await readFile(`${output}/${directory}/${file}.json`, "utf8"),
    );
    if (!compatible(child.version) || child.status !== "passed")
      throw Error("Cached child gate did not pass: " + directory);
  }
  console.log(
    JSON.stringify({
      cached: true,
      testedHead: old.version.head,
      status: old.status,
      pilotReady: old.pilotReady,
    }),
  );
  if (
    old.status !== "passed" ||
    old.pilotReady !== true ||
    configuration.required.some((gate) => old.gates[gate] !== "passed") ||
    old.children?.length !== 8 ||
    old.children.some((c) => c.exitCode !== 0 || c.timedOut || c.cleanupFailed)
  )
    process.exitCode = 1;
} else {
  const output = await newOutput("acceptance"),
    report = {
      version,
      configuration,
      started: new Date().toISOString(),
      host: {
        cpu: os.cpus()[0].model,
        logicalCpus: os.cpus().length,
        platform: os.platform(),
        release: os.release(),
        totalMemory: os.totalmem(),
        node: process.version,
      },
      children: [],
      gates: {},
      pilotReady: false,
      releaseReady: false,
    };
  if (version.modifiedSources.length)
    throw Error(
      "Freeze source before formal R12 acceptance: " +
        version.modifiedSources.join(","),
    );
  await writeFile(
    output + "/frozen.json",
    JSON.stringify({ version, configuration }, null, 2),
    { flag: "wx" },
  );
  const run = async (name, command, timeoutSeconds) => {
    const childOutput = output + "/" + name,
      args =
        process.platform === "win32"
          ? ["/d", "/s", "/c", "npm run " + command]
          : ["run", command];
    const result = await runBounded(
      process.platform === "win32" ? "cmd.exe" : "npm",
      args,
      {
        timeoutMilliseconds: timeoutSeconds * 1000,
        forward: true,
        env: {
          ...process.env,
          LUMEN_REPORT_DIRECTORY: childOutput,
          LUMEN_SOAK_SECONDS: "1800",
          LUMEN_PILOT_DISPLAYS: "models,tiles",
          LUMEN_PILOT_REPLACEMENTS: "20",
          LUMEN_PILOT_LOD_SWITCHES: "50",
        },
      },
    );
    await writeFile(output + "/" + name + ".log", result.log, {
      flag: "wx",
    });
    report.children.push({
      name,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cleanupFailed: result.cleanupFailed,
      timeoutSeconds,
    });
    return !result.cleanupFailed;
  };
  const read = async (dir, file) => {
    try {
      const r = JSON.parse(
        await readFile(output + "/" + dir + "/" + file, "utf8"),
      );
      if (!compatible(r.version))
        return { status: "failed", errors: ["Frozen fingerprint mismatch"] };
      return r;
    } catch {
      return { status: "not-run" };
    }
  };
  const passed = (r) =>
    r.status === "passed"
      ? "passed"
      : r.status === "not-run"
        ? "not-run"
        : "failed";
  const gate = (states) =>
    states.includes("failed")
      ? "failed"
      : states.every((s) => s === "passed")
        ? "passed"
        : "not-run";
  for (const [name, command, timeoutSeconds] of [
    ["assets", "test:pilot:assets", 300],
    ["lifecycle", "test:pilot:lifecycle", 1200],
    ["equivalence", "test:pilot:equivalence", 1800],
    ["quality", "test:pilot:quality", 2400],
    ["runtime", "test:pilot:runtime", 1800],
    ["performance", "benchmark:pilot", 1200],
    ["deployment", "test:pilot:deployment", 2400],
    ["soak", "test:pilot:soak", 2400],
  ]) {
    console.log("R12 group " + name);
    if (!(await run(name, command, timeoutSeconds))) {
      report.infrastructureError =
        "Child tree cleanup unconfirmed; later GPU groups not-run";
      break;
    }
  }
  await writeFile(
    output + "/execution.json",
    JSON.stringify({ children: report.children }, null, 2),
    { flag: "wx" },
  );
  const assets = await read("assets", "assets.json"),
    lifecycle = await read("lifecycle", "lifecycle.json"),
    equivalence = await read("equivalence", "equivalence.json"),
    quality = await read("quality", "quality.json"),
    runtime = await read("runtime", "runtime.json"),
    performance = await read("performance", "benchmark.json"),
    deployment = await read("deployment", "deployment.json"),
    soak = await read("soak", "soak.json");
  const runtimeGate = (key) =>
    runtime.rows?.length === 2
      ? runtime.rows.every((r) => r.checks[key])
        ? "passed"
        : "failed"
      : passed(runtime);
  const qualityGate = (key) =>
    quality.rows?.length === 40
      ? quality.rows.every(
          (r) =>
            r.points.length > 0 &&
            r.query.values.length === r.points.length &&
            Number.isFinite(r[key]) &&
            r[key] <=
              configuration[
                key === "queryNRMSE" ? "queryLimit" : "usedLimit"
              ] &&
            Object.values(r.regions).every(
              (z) =>
                z.denominator > 0 &&
                Number.isFinite(z[key]) &&
                z[key] <=
                  configuration[
                    key === "queryNRMSE" ? "queryLimit" : "usedLimit"
                  ],
            ) &&
            r.query.values.every(
              (q) => (q.valid ?? q.coverage > 0) && !q.unknown,
            ),
        )
        ? "passed"
        : "failed"
      : passed(quality);
  report.gates = {
    assets: passed(assets),
    "session-lifecycle": passed(lifecycle),
    "tiles-residency": runtimeGate("tilesResidency"),
    resource: runtimeGate("resource"),
    "query-quality": gate([passed(equivalence), qualityGate("queryNRMSE")]),
    "final-image-quality": gate([
      passed(equivalence),
      qualityGate("usedNRMSE"),
    ]),
    temporal: runtimeGate("temporal"),
    performance: passed(performance),
    "relight-visible": runtimeGate("relightVisible"),
    soak: passed(soak),
    deployment: passed(deployment),
  };
  report.profiles = Object.fromEntries(
    configuration.profiles.map((profile) => {
      const rows = quality.rows?.filter((r) => r.profile === profile) ?? [];
      return [
        profile,
        {
          rows: rows.length,
          query:
            rows.length !== 20
              ? "not-run"
              : rows.every(
                    (r) =>
                      r.queryNRMSE <= 0.12 &&
                      Object.values(r.regions).every(
                        (z) => z.queryNRMSE <= 0.12,
                      ),
                  )
                ? "passed"
                : "failed",
          image:
            rows.length !== 20
              ? "not-run"
              : rows.every(
                    (r) =>
                      r.usedNRMSE <= 0.2 &&
                      Object.values(r.regions).every((z) => z.usedNRMSE <= 0.2),
                  )
                ? "passed"
                : "failed",
        },
      ];
    }),
  );
  report.status = report.children.some((c) => c.exitCode !== 0 || c.timedOut)
    ? "failed"
    : gate(Object.values(report.gates));
  report.pilotReady =
    report.status === "passed" &&
    report.children.every((c) => c.exitCode === 0);
  report.finished = new Date().toISOString();
  const endVersion = sourceVersion(inputs);
  if (
    !compatible(endVersion) ||
    JSON.stringify(endVersion.sources) !== JSON.stringify(version.sources)
  ) {
    report.status = "failed";
    report.pilotReady = false;
    report.sourceChanged = true;
  }
  report.evidence = await evidenceHashes(output);
  await writeFile(
    output + "/acceptance.json",
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      testedHead: version.head,
      status: report.status,
      pilotReady: report.pilotReady,
      gates: report.gates,
    }),
  );
  if (report.status !== "passed" || !report.pilotReady) process.exitCode = 1;
}
