// Full acceptance runs the slow independent reference, images, GPU costs and numeric gates.
// --fast is regression smoke only and explicitly leaves quality/performance not-run.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { sourceVersion } from "./browser-tools.mjs";
import { r6Acceptance } from "./r6-acceptance.mjs";
const out = "reports/receiver-final-gather-v5",
  fast = process.argv.includes("--fast"),
  historical = [
    "reports/globe-visibility-v3",
    "reports/ddgi-visual-quality-v4",
  ];
async function files(dir) {
  const a = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) a.push(...(await files(p)));
    else a.push(p);
  }
  return a;
}
const saved = new Map(
  await Promise.all(
    (await Promise.all(historical.map(files)))
      .flat()
      .map(async (p) => [p, await readFile(p)]),
  ),
);
const tests = [
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
const report = {
  started: new Date().toISOString(),
  version: sourceVersion([
    "lumen/path-reference.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenReceiverPass.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSnapshot.js",
    "cesium-1.146/packages/engine/Source/Scene/Model/LightingPipelineStage.js",
    "cesium-1.146/packages/engine/Source/Scene/Scene.js",
    "cesium-1.146/packages/engine/Source/Shaders/Model/LightingStageFS.glsl",
    "cesium-1.146/packages/engine/Source/Shaders/Model/ImageBasedLightingStageFS.glsl",
    "demo/globe.js",
  ]),
  tests: [],
  quality: { status: "not-run" },
  performance: { status: "not-run" },
  notRun: [
    {
      name: "real authenticated ion",
      reason: "no token supplied; local and mocked error fallback tested",
    },
    { name: "external Sponza assets", reason: "self-authored local geometry" },
    {
      name: "simultaneous relight busy-frame GPU",
      reason: "idle-only GPU timestamps; submission latency is CPU scope",
    },
    {
      name: "production held-out low-sample rendering",
      reason:
        "held-out high-sample query validated; low-sample screen data only on original scene",
    },
    {
      name: "WebGL1 / real missing timer hardware",
      reason: "current device is WebGL2 with available GPU timers",
    },
  ],
};
await mkdir(out + "/compatibility-raw", { recursive: true });
function run(script, args = []) {
  const start = performance.now(),
    r = spawnSync(process.execPath, ["scripts/" + script + ".mjs", ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        LUMEN_REPORT: out + "/compatibility-raw/" + script + ".json",
        LUMEN_REPORT_DIRECTORY: out + "/compatibility-raw",
      },
    });
  return {
    script,
    args,
    exitCode: r.status,
    milliseconds: performance.now() - start,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
  };
}
try {
  const lint = run("lint-r6");
  report.tests.push({
    ...lint,
    name: "target ESLint",
    status: lint.exitCode === 0 ? "passed" : "failed",
  });
  console.log(report.tests.at(-1).status.toUpperCase(), "target ESLint");
  for (const name of fast
    ? ["pipeline", "ibl-policy", "final-gather", "receiver", "reconstruction"]
    : tests) {
    const r = run("verify-" + name);
    report.tests.push({
      ...r,
      name,
      status: r.exitCode === 0 ? "passed" : "failed",
    });
    console.log(report.tests.at(-1).status.toUpperCase(), name);
    await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  }
  report.regression = report.tests.every((t) => t.status === "passed")
    ? "passed"
    : "failed";
  if (!fast) {
    for (const name of [
      "compare-final-gather",
      "capture-receiver",
      "benchmark-receiver",
    ]) {
      const r = run(name);
      report.tests.push({
        ...r,
        name,
        status: r.exitCode === 0 ? "executed" : "failed",
      });
      console.log(report.tests.at(-1).status.toUpperCase(), name);
    }
    const gates = [];
    for (const [label, args, expected] of [
      ["ddgi-v4", ["--label", "ddgi-v4"], 1],
      [
        "old-threshold-smoke",
        ["--candidate", "before", "--label", "old-threshold-smoke"],
        0,
      ],
      [
        "fg-query-high",
        ["--input", out + "/abcd.json", "--label", "fg-query-high"],
        0,
      ],
      [
        "fg16",
        ["--input", out + "/images.json", "--samples", "16", "--label", "fg16"],
        null,
      ],
      [
        "fg32",
        ["--input", out + "/images.json", "--samples", "32", "--label", "fg32"],
        null,
      ],
      [
        "injected",
        [
          "--input",
          out + "/abcd.json",
          "--label",
          "fg-query-high",
          "--inject-error",
        ],
        1,
      ],
    ]) {
      const r = run("verify-quality", args),
        gate = JSON.parse(
          await readFile(
            out +
              "/quality-" +
              (label === "injected" ? "fg-query-high-injected" : label) +
              ".json",
            "utf8",
          ),
        );
      gates.push({
        label,
        ...r,
        quality: gate.quality,
        checks: gate.checks,
        expectedExitCode: expected,
      });
    }
    const candidateStatus = (label) => {
      const g = gates.find((g) => g.label === label);
      return g.exitCode === 0 && g.quality === "passed" ? "passed" : "failed";
    };
    report.quality = {
      status: candidateStatus("fg16"),
      highQuery: candidateStatus("fg-query-high"),
      production32: candidateStatus("fg32"),
      gateHarness: gates
        .filter((g) => g.expectedExitCode !== null)
        .every((g) => g.exitCode === g.expectedExitCode)
        ? "passed"
        : "failed",
      gates,
    };
    const perf = JSON.parse(await readFile(out + "/performance.json", "utf8"));
    report.performance = {
      status:
        perf.status === "failed"
          ? "failed"
          : perf.acceptance.every(
                (c) => c.gpu === "passed" && c.memory === "passed",
              )
            ? "passed"
            : "failed",
      acceptance: perf.acceptance,
    };
  }
} finally {
  for (const dir of historical)
    for (const p of await files(dir)) {
      const data = await readFile(p),
        old = saved.get(p);
      if (!old || !data.equals(old)) {
        const target = out + "/compatibility-raw/" + p.slice(8);
        await mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await writeFile(target, data);
        if (old) await writeFile(p, old);
        else await unlink(p);
      }
    }
  report.finished = new Date().toISOString();
  const acceptance = r6Acceptance(report, fast);
  report.quality.overall = acceptance.quality;
  report.performance.status = acceptance.performance;
  report.status = acceptance.status;
  await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      regression: report.regression,
      quality: report.quality.overall,
      highQuery: report.quality.highQuery,
      performance: report.performance.status,
      status: report.status,
    }),
  );
  if (report.status === "failed") process.exitCode = 1;
}
