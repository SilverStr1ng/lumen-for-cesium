import { readFile } from "node:fs/promises";
import {
  performanceFile,
  performancePassed,
  requiredCaptureFiles,
} from "./r8-acceptance.mjs";

export const requiredStates = [
  "regression",
  "fixed-quality-regression",
  "Auto-quality-regression",
  "temporal-regression",
  "curved-quality",
  "curved-temporal",
  "ballpool-frozen-GI",
  "physics-interaction",
  "snapshot-consistency",
  "resource",
  "fixed32-performance",
  "interactive-performance",
  "ballpool-static-performance",
  "physics-preview-performance",
  "snapshot-update-latency",
  "showcase",
];
export const sharedReferences = requiredCaptureFiles(
  "reports/r9-regression",
).filter((f) => !f.startsWith("reports/r9-regression/"));
const simple = [
  ["snapshot-consistency", "verify-r9-acceptance", null],
  ["curved-quality", "verify-curved-contract", null],
  ["curved-quality", "verify-curved-topology", "topology.json"],
  ["curved-quality", "verify-curved-receivers", "curved.json"],
  ["curved-temporal", "verify-curved-temporal", "curved-temporal.json"],
  [
    "ballpool-frozen-GI",
    "verify-ballpool-descriptor",
    "descriptor-physics.json",
  ],
  ["ballpool-frozen-GI", "verify-ballpool", "ballpool.json"],
  ["resource", "verify-ballpool-desktop", "desktop.json"],
  [
    "physics-preview-performance",
    "benchmark-ballpool-preview",
    "preview-performance.json",
  ],
];
export function expectedTests(out) {
  const jobs = simple.map(([state, name, file]) => ({
    state,
    name,
    parameters: [],
    file: file && `${out}/${file}`,
  }));
  jobs.push({
    state: "regression",
    name: "verify-r8",
    parameters: ["--without-performance", `--output=${out}/regression`],
    file: `${out}/regression/test-suite.json`,
  });
  for (const quality of ["high", "interactive16", "auto"]) {
    const scenes =
      quality === "auto"
        ? ["ballpool"]
        : quality === "high"
          ? ["original", "gallery"]
          : ["original", "gallery", "ballpool"];
    for (const sceneName of scenes)
      for (const activity of sceneName === "ballpool"
        ? ["static"]
        : ["static", "moving", "relight"]) {
        const configuration = {
          execution: "split",
          rayOrder: "azimuth",
          rayLayout: "interleaved",
          lazyFallback: true,
          sceneName,
          quality,
          activity,
          viewport: { width: 1280, height: 800 },
        };
        jobs.push({
          state:
            sceneName === "ballpool"
              ? "ballpool-static-performance"
              : quality === "high"
                ? "fixed32-performance"
                : "interactive-performance",
          name: "benchmark-fg-runtime",
          parameters: [
            `--scene=${sceneName}`,
            `--quality=${quality}`,
            `--activity=${activity}`,
            "--azimuth",
            "--lazy",
          ],
          file: `${out}/${performanceFile(configuration)}`,
          configuration,
        });
      }
  }
  return jobs;
}
export async function summarize(report, out, verifyManifest = false) {
  const states = Object.fromEntries(requiredStates.map((s) => [s, "not-run"])),
    jobs = expectedTests(out),
    rows = [],
    json = async (file) => JSON.parse(await readFile(file, "utf8"));
  for (const job of jobs) {
    const producers = report.tests.filter(
      (r) =>
        r.name === job.name &&
        JSON.stringify(r.parameters) === JSON.stringify(job.parameters),
    );
    const producer = producers[0];
    let status =
      producers.length === 1
        ? producer.exitCode === 0
          ? "passed"
          : "failed"
        : producers.length
          ? "failed"
          : "not-run";
    if (
      producer &&
      verifyManifest &&
      (!report.inputs[producer.log] || (job.file && !report.inputs[job.file]))
    )
      throw Error(
        `cached required evidence absent: ${job.name} ${job.file ?? producer.log}`,
      );
    let data;
    if (producer && job.file) {
      try {
        data = await json(job.file);
        if (job.configuration) {
          if (
            JSON.stringify(data.configuration) !==
              JSON.stringify(job.configuration) ||
            !performancePassed(data, producer)
          )
            status = "failed";
        } else if (job.name !== "verify-r8" && data.status !== "passed")
          status = "failed";
      } catch {
        status = "failed";
      }
    }
    rows.push({ ...job, status, data });
  }
  for (const state of requiredStates) {
    const group = rows.filter((r) => r.state === state);
    if (group.length)
      states[state] = group.some((r) => r.status === "failed")
        ? "failed"
        : group.every((r) => r.status === "passed")
          ? "passed"
          : "not-run";
  }
  const regression = rows.find((r) => r.name === "verify-r8")?.data;
  if (regression && verifyManifest) {
    for (const file of requiredCaptureFiles(`${out}/regression`).filter(
      (f) => !f.startsWith(`${out}/regression/active/`),
    ))
      if (!report.inputs[file])
        throw Error(`cached R8 quality evidence absent: ${file}`);
  }
  for (const [state, r8] of [
    ["regression", "regression"],
    ["fixed-quality-regression", "fixed-quality"],
    ["Auto-quality-regression", "auto-quality"],
    ["temporal-regression", "temporal"],
  ])
    states[state] = regression?.states?.[r8] ?? "not-run";
  const life = rows.find((r) => r.name === "verify-ballpool"),
    lifePassed = life?.status === "passed";
  states["physics-interaction"] = life?.status ?? "not-run";
  const validator = rows.find((r) => r.name === "verify-r9-acceptance");
  states["snapshot-consistency"] = [life?.status, validator?.status].includes(
    "failed",
  )
    ? "failed"
    : lifePassed && validator?.status === "passed"
      ? "passed"
      : "not-run";
  const latency = life?.data?.frozen?.state?.latencies?.at(-1);
  states["snapshot-update-latency"] =
    lifePassed &&
    latency &&
    Number.isFinite(latency.modelAndWorldMilliseconds) &&
    Number.isFinite(latency.convergedMilliseconds)
      ? "passed"
      : life?.status === "not-run"
        ? "not-run"
        : "failed";
  const images = ["static-64.png", "motion-64.png", "frozen-64.png"].map(
    (n) => `${out}/${n}`,
  );
  states.showcase =
    regression?.states?.showcase === "passed" &&
    lifePassed &&
    images.every((f) => !!report.inputs[f])
      ? "passed"
      : regression
        ? "failed"
        : "not-run";
  const notRun = Object.entries(states)
      .filter(([, v]) => v === "not-run")
      .map(([name]) => ({
        name,
        reason: "required evidence did not complete",
      })),
    recommended = requiredStates.every((s) => states[s] === "passed");
  return {
    states,
    notRun,
    recommended,
    status: recommended ? "passed" : "failed",
  };
}
