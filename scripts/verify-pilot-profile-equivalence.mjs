import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import {
  newOutput,
  openPilot,
  waitFg,
  pilotBase,
} from "./pilot-validation.mjs";

const output = await newOutput("profile-equivalence"),
  report = {
    version: sourceVersion([
      "scripts/verify-pilot-profile-equivalence.mjs",
      "scripts/pilot-validation.mjs",
    ]),
    configuration: {
      buffer: [1920, 1080],
      absoluteTolerance: 0.0001,
      relativeTolerance: 0.0001,
      epochs: 32,
      samples: 32,
      round: 3,
      components: [0, 1, 2, 3, 4, 5, 6, 9, 10],
    },
    rows: [],
    errors: [],
    status: "not-run",
  };
if (
  process.env.LUMEN_EQ_BEFORE_BASE &&
  !process.env.LUMEN_STARTUP_RUNTIME_MANIFEST
)
  throw Error("Historical comparison requires a verified runtime manifest");
if (process.env.LUMEN_STARTUP_RUNTIME_MANIFEST) {
  report.beforeRuntime = JSON.parse(
    await readFile(process.env.LUMEN_STARTUP_RUNTIME_MANIFEST, "utf8"),
  );
  if (!process.env.LUMEN_EQ_BEFORE_BASE)
    throw Error("Historical comparison requires its served base URL");
  for (const [f, h] of Object.entries({
    ...report.beforeRuntime.sources,
    "cesium-1.146/Build/CesiumUnminified/Cesium.js":
      report.beforeRuntime.compiledBundle,
  })) {
    const response = await fetch(
      new URL(f, new URL("../", process.env.LUMEN_EQ_BEFORE_BASE)),
    );
    if (
      !response.ok ||
      createHash("sha256")
        .update((await response.text()).replaceAll("\r\n", "\n"))
        .digest("hex") !== h
    )
      throw Error("Historical comparison served fingerprint mismatch: " + f);
  }
}
const endpoints = [
  ...(process.env.LUMEN_EQ_BEFORE_BASE
    ? [{ kind: "before", base: process.env.LUMEN_EQ_BEFORE_BASE }]
    : []),
  { kind: "after", base: pilotBase() },
];
let browser;
try {
  for (const endpoint of endpoints)
    for (const display of ["models", "tiles"])
      for (const profile of ["baseline", "enhanced"]) {
        console.log(
          JSON.stringify({ endpoint: endpoint.kind, display, profile }),
        );
        browser = await launchBrowser();
        const page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
        });
        page.on("pageerror", (e) => report.errors.push(String(e)));
        const previousBase = process.env.LUMEN_PILOT_BASE;
        process.env.LUMEN_PILOT_BASE = endpoint.base;
        try {
          await openPilot(page, display, profile);
          if (profile === "enhanced") await waitFg(page);
        } finally {
          if (previousBase === undefined) delete process.env.LUMEN_PILOT_BASE;
          else process.env.LUMEN_PILOT_BASE = previousBase;
        }
        const row = await page.evaluate(async (config) => {
          const s = pilotSession,
            scene = pilotHost.scene,
            fg = scene.lumen.finalGather,
            world = s.world,
            token = s.generation,
            revision = world.requestedRevision,
            signal = s._controller.signal;
          const lease = s.budget.reserve(
            65536 + 96 * 3 * 8 * 12,
            "explicit shader equivalence captures",
          );
          const old = {
            debugMode: scene.lumen.debugMode,
            diagnosticShaders: scene.lumen.diagnosticShaders,
            freezeSampling: fg.freezeSampling,
          };
          try {
            const frame = () =>
              s._afterFrame(() => {
                s._guard(token, signal);
                if (world !== s.world || revision !== world.requestedRevision)
                  throw Error("Equivalence ownership changed");
              }, signal);
            const ready = async () => {
              const deadline = performance.now() + 30000;
              let stable = 0;
              while (stable < 2) {
                await frame();
                const c = scene.context;
                stable =
                  (c._lastShaderPreparationPending ?? 0) === 0 &&
                  !c._lumenBaseGroup?.blocked
                    ? stable + 1
                    : 0;
                if (performance.now() > deadline)
                  throw Error("Variant preparation deadline");
              }
            };
            scene.lumen.debugMode = 0;
            scene.lumen.diagnosticShaders = false;
            await ready();
            if (s.profile === "enhanced") {
              // Explicit comparison only: restart the same production sequence and
              // capture at least 32 new epochs, then hold it while changing GLSL variants.
              fg.reconstruction?.invalidate("explicit shader equivalence");
              fg._stableFrames = 0;
              fg._historyWorld = undefined;
              fg._sampleEpoch = 0;
              fg.freezeSampling = false;
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  remove();
                  reject(Error("32 actual FG epochs not reached"));
                }, 30000);
                const remove = scene.postRender.addEventListener(() => {
                  if (
                    fg.metrics.sampleEpoch >= 32 &&
                    fg.metrics.stablePasses >= 32 &&
                    fg.metrics.round === 3
                  ) {
                    fg.freezeSampling = true;
                    remove();
                    clearTimeout(timer);
                    resolve();
                  }
                });
                scene.requestRender();
              });
            }
            const pixels = Array.from({ length: 96 }, (_, i) => [
              Math.floor((((i % 12) + 0.5) * 1920) / 12),
              Math.floor(((Math.floor(i / 12) + 0.5) * 1080) / 8),
            ]);
            const read = async () => {
              await ready();
              return s._afterFrame(() => {
                s._guard(token, signal);
                const color = scene._view.sceneFramebuffer._colorFramebuffer,
                  fb =
                    color._multisampleFramebuffer?.getColorFramebuffer() ??
                    color.framebuffer;
                return pixels.map(([x, y]) =>
                  Array.from(
                    world
                      ._read(fb, 1, 1, 0, undefined, x, 1079 - y)
                      .slice(0, 3),
                  ),
                );
              }, signal);
            };
            const production = await read();
            scene.lumen.diagnosticShaders = true;
            const diagnosticFinal = await read();
            const components = {};
            for (const mode of config.components) {
              scene.lumen.debugMode = mode;
              components[mode] = await read();
            }
            return {
              display: s.display,
              profile: s.profile,
              pixels,
              production,
              diagnosticFinal,
              components,
              generation: token,
              revision,
              round: world.publishedBounce,
              fg: {
                ...fg.metrics,
                completedTimings: undefined,
                stages: undefined,
              },
              state: s.status().startup,
            };
          } finally {
            scene.lumen.debugMode = old.debugMode;
            scene.lumen.diagnosticShaders = old.diagnosticShaders;
            fg.freezeSampling = old.freezeSampling;
            lease.release();
          }
        }, report.configuration);
        row.endpoint = endpoint.kind;
        const difference = (a, b) =>
          Math.max(
            ...a.flatMap((v, i) =>
              v.map(
                (x, k) =>
                  Math.abs(x - b[i][k]) /
                  (report.configuration.absoluteTolerance +
                    report.configuration.relativeTolerance *
                      Math.max(Math.abs(x), Math.abs(b[i][k]))),
              ),
            ),
          );
        row.productionDiagnosticRatio = difference(
          row.production,
          row.diagnosticFinal,
        );
        row.passed = row.productionDiagnosticRatio <= 1;
        if (endpoint.kind === "after" && report.beforeRuntime) {
          const before = report.rows.find(
            (r) =>
              r.endpoint === "before" &&
              r.display === display &&
              r.profile === profile,
          );
          assert(before, "Missing same-condition before capture");
          row.beforeAfterRatios = Object.fromEntries(
            report.configuration.components.map((mode) => [
              mode,
              difference(before.components[mode], row.components[mode]),
            ]),
          );
          row.passed &&= Object.values(row.beforeAfterRatios).every(
            (v) => v <= 1,
          );
        }
        report.rows.push(row);
        await writeFile(
          `${output}/${endpoint.kind}-${display}-${profile}.json`,
          JSON.stringify(row, null, 2),
          { flag: "wx" },
        );
        console.log(
          JSON.stringify({
            endpoint: endpoint.kind,
            display,
            profile,
            passed: row.passed,
            productionDiagnosticRatio: row.productionDiagnosticRatio,
            beforeAfterRatios: row.beforeAfterRatios,
          }),
        );
        await browser.close();
        browser = undefined;
      }
} catch (error) {
  report.errors.push(String(error));
  console.error(error);
} finally {
  await browser?.close();
}
report.status =
  report.rows.length === 8 &&
  report.rows.every((r) => r.passed) &&
  !report.errors.length
    ? "passed"
    : report.rows.some((r) => !r.passed) || report.errors.length
      ? "failed"
      : "not-run";
await writeFile(
  output + "/profile-equivalence.json",
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({ output, status: report.status, errors: report.errors }),
);
if (report.status !== "passed") process.exitCode = 1;
