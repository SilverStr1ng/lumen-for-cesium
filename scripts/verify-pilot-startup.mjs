import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { newOutput, pilotBase } from "./pilot-validation.mjs";
import { installStartupObserver } from "./startup-observer.mjs";
const output = await newOutput("startup"),
  contract = JSON.parse(
    await readFile("docs/product/local-gi-startup-v1.json", "utf8"),
  ),
  report = {
    version: sourceVersion([
      "scripts/verify-pilot-startup.mjs",
      "scripts/startup-observer.mjs",
      "docs/product/local-gi-startup-v1.json",
    ]),
    contract,
    configuration: {
      starts: Number(process.env.LUMEN_STARTUP_RUNS ?? 5),
      displays: (process.env.LUMEN_PILOT_DISPLAYS ?? "models,tiles").split(","),
      profile: process.env.LUMEN_STARTUP_PROFILE ?? "enhanced",
      windows: (
        process.env.LUMEN_STARTUP_WINDOWS ??
        "cold,reload,baseline,enhanced,diagnostic,new-context"
      ).split(","),
      noParallel: process.env.LUMEN_STARTUP_NO_KHR === "1",
      browser:
        "fresh sandboxed browser/profile per cold row; driver shader cache uncontrolled",
      cpuProfile: process.env.LUMEN_STARTUP_CPU !== "0",
      base: pilotBase(),
    },
    rows: [],
    errors: [],
    status: "not-run",
  };
// A historical runtime may be served from an independently verified archive.
// Never label that page with the current measurement harness's source HEAD.
if (process.env.LUMEN_STARTUP_RUNTIME_MANIFEST) {
  const file = process.env.LUMEN_STARTUP_RUNTIME_MANIFEST;
  const bytes = await readFile(file);
  const runtime = JSON.parse(bytes);
  const root = new URL("../", pilotBase());
  for (const [f, h] of Object.entries({
    ...runtime.sources,
    "cesium-1.146/Build/CesiumUnminified/Cesium.js": runtime.compiledBundle,
  })) {
    const response = await fetch(new URL(f, root));
    if (
      !response.ok ||
      createHash("sha256")
        .update((await response.text()).replaceAll("\r\n", "\n"))
        .digest("hex") !== h
    )
      throw Error("Served historical runtime mismatch: " + f);
  }
  report.runtime = {
    manifest: file,
    manifestSHA256: createHash("sha256").update(bytes).digest("hex"),
    ...runtime,
  };
} else
  report.runtime = {
    reviewedHead: report.version.head,
    compiledBundle: report.version.compiledBundle,
    modifiedSources: report.version.modifiedSources,
  };
const percentile = (v, p) =>
  [...v].sort((a, b) => a - b)[Math.ceil(v.length * p) - 1] ?? null;
async function saveMeasurement(row) {
  const m = row.measurement;
  if (!m) return;
  m.sources = await Promise.all(
    m.sources.map(async (source, index) => {
      const hash = createHash("sha256").update(source).digest("hex"),
        file = `${hash}.glsl`;
      try {
        await writeFile(`${output}/${file}`, source, { flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      return { index, hash, bytes: Buffer.byteLength(source), file };
    }),
  );
  const inputs = m.inputs.filter((i) => i.shellReady).map((i) => i.delay),
    limits = contract.limitsMilliseconds;
  row.summary = {
    shellInteractive: m.shellInteractive,
    firstSceneFrame: m.firstSceneFrame,
    firstAssetFrame: m.firstAssetFrame,
    firstAssetMode: m.firstAssetMode,
    firstNewGIFrame: m.firstNewGIFrame,
    targetFGFrame: m.targetFGFrame,
    inputCount: inputs.length,
    inputP95: percentile(inputs, 0.95),
    inputMax: inputs.length ? Math.max(...inputs) : null,
    maxMainThreadGap: Math.max(
      0,
      ...m.gaps.map((g) => g.duration),
      ...m.tasks.map((t) => t.duration),
    ),
    programs: m.programs.filter((p) => !p.preExisting).length,
    livePrograms: m.programs.filter((p) => p.deleted === undefined).length,
    extensions: m.extensions,
  };
  row.checks = {
    shell:
      m.shellInteractive !== null &&
      m.shellInteractive <= limits.shellInteractive,
    asset:
      m.firstAssetFrame !== null && m.firstAssetFrame <= limits.firstAssetFrame,
    gi:
      m.firstNewGIFrame !== null && m.firstNewGIFrame <= limits.firstNewGIFrame,
    input:
      inputs.length >= 5 &&
      row.summary.inputP95 <= limits.inputP95 &&
      row.summary.inputMax <= limits.inputMax,
    gap: row.summary.maxMainThreadGap <= limits.maxMainThreadGap,
    fg: row.profile !== "enhanced" || m.targetFGFrame !== null,
    complete: !m.overflow && !row.errors.length && !m.errors.length,
  };
  row.passed = Object.values(row.checks).every(Boolean);
}
for (const display of report.configuration.displays)
  for (let n = 0; n < report.configuration.starts; n++) {
    let browser;
    try {
      browser = await launchBrowser({ recordArguments: true });
      const page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
        }),
        cdp = await page.context().newCDPSession(page),
        browserCdp = await browser.newBrowserCDPSession();
      const browserVersion = await browserCdp.send("Browser.getVersion"),
        browserArguments = await browserCdp.send(
          "Browser.getBrowserCommandLine",
        );
      await page.exposeFunction("recordStartupInput", () => {});
      await page.addInitScript(installStartupObserver, {
        noParallel: report.configuration.noParallel,
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      for (const kind of report.configuration.windows) {
        const profile =
            kind === "baseline"
              ? "baseline"
              : kind === "enhanced"
                ? "enhanced"
                : report.configuration.profile,
          name = `${display}-${n}-${kind}`,
          row = {
            display,
            run: n,
            kind,
            profile,
            cache:
              kind === "cold"
                ? "fresh-process/profile; driver cache uncontrolled"
                : "same browser profile; driver cache uncontrolled",
            browserVersion,
            browserArguments: browserArguments.arguments,
            errors: [],
          };
        let timer, operation;
        const errorStart = errors.length;
        try {
          console.log(JSON.stringify({ display, run: n, phase: kind }));
          if (report.configuration.cpuProfile) {
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
            await cdp.send("Profiler.start");
          }
          let inFlight = 0;
          timer = setInterval(() => {
            if (inFlight >= 4) return;
            inFlight++;
            cdp
              .send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "F8",
                code: "F8",
                windowsVirtualKeyCode: 119,
                timestamp: Date.now() / 1000,
              })
              .catch(() => {})
              .finally(() => inFlight--);
          }, 100);
          if (kind === "cold") {
            await page.goto(
              pilotBase() + `pilot-${display}.html?profile=${profile}`,
              {
                waitUntil: "commit",
                timeout: contract.measurementDeadlineMilliseconds,
              },
            );
          } else {
            operation = page.evaluate(
              ({ kind, profile }) => {
                const s = pilotSession,
                  fg = pilotHost.scene.lumen.finalGather;
                startupProbe.beginWindow({
                  kind,
                  generation:
                    kind === "new-context"
                      ? 1
                      : kind === "reload"
                        ? s.generation + 1
                        : s.generation,
                  epoch: kind === "new-context" ? 0 : (fg._sampleEpoch ?? 0),
                });
                const promise =
                  kind === "new-context"
                    ? pilotHost.recreate()
                    : kind === "reload"
                      ? pilotHost.replace()
                      : kind === "diagnostic"
                        ? Promise.resolve((pilotHost.scene.lumen.debugMode = 4))
                        : s.setQuality(profile);
                return promise.then(
                  () => ({ outcome: "completed" }),
                  (error) => ({ outcome: "failed", error: String(error) }),
                );
              },
              { kind, profile },
            );
          }
          await page.waitForFunction(
            (profile) => {
              if (window.pilotSession?.phase === "failed")
                throw Error(pilotSession.error);
              const s = window.startupProbe;
              return !!(
                s &&
                (profile === "enhanced" ? s.targetFGFrame : s.firstNewGIFrame)
              );
            },
            profile,
            { timeout: contract.measurementDeadlineMilliseconds },
          );
          // Retain a useful real-input sample even when a warm operation is short.
          await page.waitForFunction(
            () => startupProbe.inputs.filter((i) => i.shellReady).length >= 5,
            null,
            { timeout: 5000 },
          );
          if (operation) row.operation = await operation;
          row.status = await page.evaluate(() => pilotSession.status());
        } catch (error) {
          row.errors.push(String(error));
        } finally {
          clearInterval(timer);
          try {
            row.measurement = await page.evaluate(() => startupProbe.finish());
          } catch (error) {
            row.errors.push(String(error));
          }
          if (report.configuration.cpuProfile) {
            try {
              const { profile } = await cdp.send("Profiler.stop");
              await writeFile(
                `${output}/${name}.cpuprofile`,
                JSON.stringify(profile),
                { flag: "wx" },
              );
            } catch (error) {
              row.errors.push(String(error));
            }
          }
        }
        row.errors.push(...errors.slice(errorStart));
        await saveMeasurement(row);
        if (kind === "diagnostic")
          await page.evaluate(() => {
            pilotHost.scene.lumen.debugMode = 0;
          });
        row.passed = !!row.passed;
        report.rows.push(row);
        await writeFile(
          `${output}/${name}.json`,
          JSON.stringify(row, null, 2),
          { flag: "wx" },
        );
        console.log(
          JSON.stringify({
            display,
            run: n,
            kind,
            passed: row.passed,
            summary: row.summary,
            errors: row.errors,
          }),
        );
        if (row.errors.length) break;
      }
    } catch (error) {
      report.errors.push(String(error));
    } finally {
      await browser?.close();
    }
  }
report.statistics = [];
for (const display of report.configuration.displays)
  for (const kind of report.configuration.windows) {
    const rows = report.rows.filter(
      (r) => r.display === display && r.kind === kind,
    );
    const metrics = {};
    for (const key of [
      "shellInteractive",
      "firstAssetFrame",
      "firstNewGIFrame",
      "targetFGFrame",
      "inputP95",
      "inputMax",
      "maxMainThreadGap",
    ]) {
      const v = rows.map((r) => r.summary?.[key]).filter(Number.isFinite);
      metrics[key] = {
        runs: v.length,
        median: percentile(v, 0.5),
        worst: v.length ? Math.max(...v) : null,
      };
    }
    report.statistics.push({ display, kind, metrics });
  }
report.gates = {};
for (const [gate, kinds] of [
  ["startup-cold", ["cold", "new-context"]],
  ["startup-warm", ["reload", "baseline", "enhanced", "diagnostic"]],
]) {
  const rows = report.rows.filter((r) => kinds.includes(r.kind));
  report.gates[gate] =
    rows.some((r) => !r.passed) || report.errors.length
      ? "failed"
      : report.configuration.starts >= 5 &&
          report.configuration.displays.length === 2 &&
          kinds.every((k) => report.configuration.windows.includes(k)) &&
          rows.length === kinds.length * report.configuration.starts * 2
        ? "passed"
        : "not-run";
}
report.status = Object.values(report.gates).includes("failed")
  ? "failed"
  : Object.values(report.gates).every((g) => g === "passed")
    ? "passed"
    : "not-run";
if (report.configuration.noParallel) {
  report.gates["startup-no-extension"] =
    report.rows.some((r) => !r.passed) || report.errors.length
      ? "failed"
      : report.configuration.starts >= 5 &&
          report.configuration.displays.length === 2 &&
          report.configuration.windows.length === 1 &&
          report.configuration.windows[0] === "cold" &&
          report.rows.length === report.configuration.starts * 2
        ? "passed"
        : "not-run";
  report.status = report.gates["startup-no-extension"];
}
await writeFile(output + "/startup.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({ output, status: report.status, gates: report.gates }),
);
if (report.status !== "passed") process.exitCode = 1;
