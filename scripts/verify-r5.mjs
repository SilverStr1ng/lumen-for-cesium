// Sequential existing regressions; preserve the previous round's report artifacts.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { sourceVersion } from "./browser-tools.mjs";
const out = "reports/ddgi-visual-quality-v4",
  previous = "reports/globe-visibility-v3";
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + entry.name;
    if (entry.isDirectory()) result.push(...(await files(p)));
    else result.push(p);
  }
  return result;
}
const original = new Map(
  await Promise.all(
    (await files(previous)).map(async (p) => [p, await readFile(p)]),
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
];
const report = {
  version: sourceVersion(),
  started: new Date().toISOString(),
  tests: [],
  notRun: [
    {
      name: "external Sponza asset chain",
      reason:
        "this acceptance run uses self-authored local pavilion and fixtures",
    },
    {
      name: "real authenticated ion",
      reason:
        "no user token supplied; mocked 401/403 and local fallback tested",
    },
  ],
};
await mkdir(out + "/compatibility-raw", { recursive: true });
try {
  for (const name of tests) {
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-" + name + ".mjs"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 240000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          LUMEN_REPORT: out + "/compatibility-raw/" + name + ".json",
        },
      },
    );
    report.tests.push({
      name,
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      milliseconds: performance.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    });
    console.log(report.tests.at(-1).status.toUpperCase(), name);
    await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
  }
} finally {
  for (const p of await files(previous)) {
    const data = await readFile(p),
      saved = original.get(p);
    if (!saved || !data.equals(saved)) {
      const target = out + "/compatibility-raw/" + p.slice(previous.length + 1);
      await mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await writeFile(target, data);
      if (saved) await writeFile(p, saved);
      else await unlink(p);
    }
  }
  report.status = report.tests.every((t) => t.status === "passed")
    ? "passed"
    : "failed";
  report.finished = new Date().toISOString();
  await writeFile(out + "/test-suite.json", JSON.stringify(report, null, 2));
}
if (report.status !== "passed") process.exitCode = 1;
