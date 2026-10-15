import assert from "node:assert/strict";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const output =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/local-gi-pilot-stabilization-v11/lifecycle-" +
    new Date().toISOString().replaceAll(":", "-");
await mkdir(output, { recursive: true });
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-lifecycle.mjs",
    "docs/product/local-gi-v0.1.md",
  ]),
  configuration: {
    buffer: [1280, 800],
    profile: "enhanced",
    faults:
      "explicit Worker constructor/postMessage injection; real HTTP404 and supersession",
  },
  checks: [],
  errors: [],
};
let browser, monitor;
try {
  browser = await launchBrowser();
  console.log("Browser launched");
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.addInitScript(installGlObserver);
  console.log("Page created");
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error(message.text().slice(0, 1200));
  });
  await page.exposeFunction("recordPilotStep", async (row) => {
    console.log(JSON.stringify(row));
    await appendFile(output + "/steps.ndjson", JSON.stringify(row) + "\n");
  });
  page.on("pageerror", (e) => {
    report.errors.push(String(e));
    console.error(e);
  });
  for (const display of (
    process.env.LUMEN_PILOT_DISPLAYS ?? "models,tiles"
  ).split(",")) {
    console.log("Opening " + display);
    await page.goto(
      (process.env.LUMEN_PILOT_BASE ?? "http://localhost:8090/demo/") +
        "pilot-" +
        display +
        ".html?profile=enhanced",
    );
    console.log("Opened " + display);
    monitor = setInterval(async () => {
      try {
        console.log(
          JSON.stringify(
            await page.evaluate(() => ({
              phase: window.pilotSession?.phase,
              stage: window.pilotSession?.stage,
              worldStatus: window.pilotSession?.world?.status,
              progress: window.pilotSession?.world?.progress,
              submitted: window.pilotSession?.world?.metrics.submittedFrames,
              frame: window.pilotHost?.scene._frameState?.frameNumber,
              error: window.pilotSession?.error,
            })),
          ),
        );
      } catch {}
    }, 2000);
    await page.waitForFunction(
      () => pilotSession?.ready || pilotSession?.phase === "failed",
      null,
      { timeout: 240000 },
    );
    clearInterval(monitor);
    assert(
      await page.evaluate(() => pilotSession.ready),
      await page.evaluate(() => pilotSession.error),
    );
    console.log(JSON.stringify({ display, phase: "loaded" }));
    const checks = await page.evaluate(async () => {
      const results = [],
        s = pilotSession,
        uri = new URL("../fixtures/local-pilot/dataset.json", location.href)
          .href,
        Native = Worker;
      const compact = () => ({
        phase: s.phase,
        generation: s.generation,
        requests: s.status().lightingRequests,
        display: s.displayStatus(),
        world: s.status().world,
        error: s.error,
      });
      const bounded = async (name, promise) => {
        await window.recordPilotStep({
          step: name,
          event: "start",
          ...compact(),
        });
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const state = compact();
                s.cancel();
                reject(
                  Error(
                    name + " exceeded 90 seconds: " + JSON.stringify(state),
                  ),
                );
              }, 90000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          await window.recordPilotStep({
            step: name,
            event: "end",
            ...compact(),
          });
        }
      };
      for (const fault of ["constructor", "postMessage"]) {
        const old = s.world;
        let failed = false,
          created = 0,
          terminated = 0;
        window.Worker =
          fault === "constructor"
            ? class {
                constructor(...a) {
                  if (!String(a[0]).includes("gpu-worker.js"))
                    return new Native(...a);
                  throw Error("injected Worker construction");
                }
              }
            : class extends Native {
                constructor(...a) {
                  super(...a);
                  this.injected = String(a[0]).includes("gpu-worker.js");
                  if (this.injected) created++;
                }
                postMessage(...a) {
                  if (this.injected) throw Error("injected postMessage");
                  return super.postMessage(...a);
                }
                terminate() {
                  if (this.injected) terminated++;
                  super.terminate();
                }
              };
        try {
          await bounded("injected-" + fault, s.replaceDataset(uri));
        } catch (error) {
          if (!String(error).includes("injected")) throw error;
          failed = true;
        } finally {
          window.Worker = Native;
        }
        results.push({
          name: fault,
          passed:
            failed &&
            s.world === old &&
            !old.isDestroyed() &&
            created === terminated,
          created,
          terminated,
        });
        await bounded("recover-" + fault, s.replaceDataset(uri));
      }
      const old = s.world;
      const pending = s.replaceDataset(uri);
      pending.catch(() => {});
      s.cancel();
      let cancelled = false;
      try {
        await pending;
      } catch (e) {
        cancelled = e.name === "AbortError";
      }
      results.push({
        name: "cancel-audit-keeps-matching-world",
        passed: cancelled && s.world === old && !old.isDestroyed(),
      });
      await bounded("recover-cancel", s.replaceDataset(uri));
      const first = s.replaceDataset(uri),
        second = s.replaceDataset(uri);
      const settled = await bounded(
        "rapid-supersession",
        Promise.allSettled([first, second]),
      );
      results.push({
        name: "rapid-supersession",
        passed:
          settled[0].status === "rejected" &&
          settled[1].status === "fulfilled" &&
          s.ready,
        settled: settled.map((v) => v.status),
      });
      const originalCommit = s.onDatasetCommitted;
      s.onDatasetCommitted = (dataset) => {
        originalCommit?.(dataset);
        queueMicrotask(() => {
          if (s.display === "models")
            s.models[0].errorEvent.raiseEvent(
              Error("injected late Model loader failure"),
            );
          else
            s.tileset.tileFailed.raiseEvent({
              message: "injected late Tile loader failure",
            });
        });
      };
      let displayRejected = false;
      try {
        await bounded("late-display-error", s.replaceDataset(uri));
      } catch {
        displayRejected = true;
      } finally {
        s.onDatasetCommitted = originalCommit;
      }
      results.push({
        name: "late-display-error-terminates-load",
        passed: displayRejected && s.phase === "failed" && !s.world,
        error: s.error,
      });
      await bounded("recover-late-display", s.replaceDataset(uri));
      const savedFocus = s.onDatasetCommitted;
      s.onDatasetCommitted = () => {};
      pilotHost.view({ eye: [35, -43, 30], target: [300, -400, 300] });
      await bounded("offscreen-dataset-ready", s.replaceDataset(uri));
      const invisible = await s.waitForVisible({ timeoutMilliseconds: 200 });
      results.push({
        name: "offscreen-data-ready-independent",
        passed: s.ready && invisible.outcome === "no-visible-content",
        displayState: invisible,
      });
      s.onDatasetCommitted = savedFocus;
      pilotHost.focus();
      const visible = await s.waitForVisible();
      results.push({
        name: "independent-visible-wait",
        passed: visible.visible,
      });
      const world = s.world,
        beforeRevision = world.requestedRevision;
      const burst = await bounded(
        "lighting-burst",
        Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            s.setLighting({ sunRadiance: [1 + i / 10, 1, 1] }),
          ),
        ),
      );
      results.push({
        name: "last-write-wins-lighting",
        passed:
          burst.filter((r) => r.outcome === "completed").length === 2 &&
          burst.filter((r) => r.outcome === "superseded").length === 6 &&
          s.world === world &&
          world.requestedRevision - beforeRevision === 2 &&
          world.options.sunRadiance[0] === 1.7,
        outcomes: burst.map((r) => r.outcome),
      });
      pilotHost.setRenderingEnabled(false);
      let frameTimeout = false;
      try {
        await bounded("stopped-render-loop", s.replaceDataset(uri));
      } catch (error) {
        frameTimeout = error.name === "TimeoutError";
      } finally {
        pilotHost.setRenderingEnabled(true);
      }
      results.push({
        name: "stopped-render-loop-bounded",
        passed: frameTimeout && s.world === world && !world.isDestroyed(),
      });
      await bounded("recover-render-loop", s.replaceDataset(uri));
      let rejected = false;
      try {
        await s.diagnostics({
          points: [{ position: [0, 0, 0], normal: [NaN, 0, 1] }],
        });
      } catch {
        rejected = true;
      }
      results.push({
        name: "reject-nonfinite-diagnostic-input",
        passed: rejected && s.ready,
      });
      return results;
    });
    report.checks.push(...checks.map((c) => ({ display, ...c })));
    assert(checks.every((c) => c.passed));
    const contextLoss = await page.evaluate(async () => {
      const s = pilotSession,
        gl = pilotHost.scene.context._gl,
        ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) return { status: "not-run", passed: false };
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 250));
      return {
        passed: s.status().phase === "context-lost" && !s.ready,
        status: s.status(),
      };
    });
    report.checks.push({
      display,
      name: "context-loss-explicit-recreate",
      ...contextLoss,
    });
    assert(contextLoss.passed);
    const rebuilt = await page.evaluate(async () => {
      await pilotHost.recreate();
      return pilotSession.status();
    });
    report.checks.push({
      display,
      name: "recreate-after-context-loss",
      passed: rebuilt.ready,
    });
    assert(rebuilt.ready);
    const reads = await page.evaluate(() => glObserver.snapshot());
    report.checks.push({
      display,
      name: "production-no-sync-readback",
      passed: reads.every((s) =>
        Object.values(s.phases).every(
          (p) =>
            !(
              p.readPixels ||
              p.getBufferSubData ||
              p.finish ||
              p.blockingClientWaitSync
            ),
        ),
      ),
      observer: reads,
    });
    const dispose = await page.evaluate(() => {
      pilotSession.dispose();
      return pilotSession.status();
    });
    report.checks.push({
      display,
      name: "dispose",
      passed:
        dispose.phase === "disposed" &&
        dispose.world === null &&
        dispose.targets === 0,
    });
  }
  report.status =
    report.checks.every((c) => c.passed) && !report.errors.length
      ? "passed"
      : "failed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
} finally {
  clearInterval(monitor);
  await browser?.close();
}
await writeFile(output + "/lifecycle.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks.map((c) => ({
      name: c.name,
      display: c.display,
      passed: c.passed,
    })),
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
