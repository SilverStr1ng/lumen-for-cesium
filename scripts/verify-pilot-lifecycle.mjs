import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const output =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/local-gi-pilot-v10/lifecycle-first";
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
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.addInitScript(installGlObserver);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  for (const display of ["models", "tiles"]) {
    await page.goto(
      (process.env.LUMEN_PILOT_BASE ?? "http://localhost:8090/demo/") +
        "pilot-" +
        display +
        ".html?profile=enhanced",
    );
    await page.waitForFunction(
      () => pilotSession?.ready || pilotSession?.phase === "failed",
      null,
      { timeout: 240000 },
    );
    assert(
      await page.evaluate(() => pilotSession.ready),
      await page.evaluate(() => pilotSession.error),
    );
    const checks = await page.evaluate(async () => {
      const results = [],
        s = pilotSession,
        uri = new URL("../fixtures/local-pilot/dataset.json", location.href)
          .href,
        Native = Worker;
      for (const fault of ["constructor", "postMessage"]) {
        const old = s.world;
        let failed = false,
          created = 0,
          terminated = 0;
        window.Worker =
          fault === "constructor"
            ? class {
                constructor() {
                  throw Error("injected Worker construction");
                }
              }
            : class extends Native {
                constructor(...a) {
                  super(...a);
                  created++;
                }
                postMessage() {
                  throw Error("injected postMessage");
                }
                terminate() {
                  terminated++;
                  super.terminate();
                }
              };
        try {
          await s.replaceDataset(uri);
        } catch {
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
        await s.replaceDataset(uri);
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
      await s.replaceDataset(uri);
      const first = s.replaceDataset(uri),
        second = s.replaceDataset(uri);
      const settled = await Promise.allSettled([first, second]);
      results.push({
        name: "rapid-supersession",
        passed:
          settled[0].status === "rejected" &&
          settled[1].status === "fulfilled" &&
          s.ready,
        settled: settled.map((v) => v.status),
      });
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
              p.clientWaitSync
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
