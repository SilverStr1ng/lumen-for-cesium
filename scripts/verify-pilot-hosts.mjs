import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { newOutput } from "./pilot-validation.mjs";
const output = await newOutput("hosts");
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-hosts.mjs",
    "scripts/pilot-validation.mjs",
    "docs/product/local-gi-v0.1.md",
  ]),
  configuration: {
    viewport: [960, 600],
    profile: "baseline",
    base: process.env.LUMEN_PILOT_BASE ?? "http://localhost:8090/demo/",
    capture: "explicit native canvas",
    scope: "functional; not target-device FPS certification",
  },
  scope:
    "Actual independent hosts, static assets and public session lifecycle; quality/performance/soak are separate required gates",
  checks: [],
  errors: [],
};
let browser, monitor;
try {
  browser = await launchBrowser();
  console.log("Browser launched");
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  for (const display of ["models", "tiles"]) {
    await page.bringToFront();
    page.on("pageerror", (error) => report.errors.push(String(error)));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(msg.text().slice(0, 3000));
    });
    await page.goto(
      (process.env.LUMEN_PILOT_BASE ?? "http://localhost:8090/demo/") +
        "pilot-" +
        display +
        ".html",
    );
    console.log("Opened " + display);
    monitor = setInterval(async () => {
      try {
        console.log(
          JSON.stringify(
            await page.evaluate(() => ({
              phase: window.pilotSession?.phase,
              error: window.pilotSession?.error,
              worker: window.pilotSession?.world?.status,
              packet: !!window.pilotSession?.world?.packet,
              frames: window.pilotSession?.world?.metrics.submittedFrames,
            })),
          ),
        );
      } catch {}
    }, 5000);
    await page.waitForFunction(
      () =>
        window.pilotSession &&
        ["available", "failed", "degraded"].includes(pilotSession.phase),
      null,
      { timeout: 180000 },
    );
    clearInterval(monitor);
    const initial = await page.evaluate(() => pilotSession.status());
    report.checks.push({
      name: display + "-load",
      passed:
        initial.ready && initial.audit.length >= 6 && initial.world?.ready,
      initial,
    });
    assert(initial.ready, initial.error);
    await page.waitForTimeout(1500);
    const image = await page.evaluate(() =>
      pilotSession.diagnostics({ image: true }),
    );
    const png = Buffer.from(image.png.split(",")[1], "base64");
    await writeFile(output + "/" + display + "-canvas.png", png, {
      flag: "wx",
    });
    report.checks.push({
      name: display + "-native-canvas",
      passed: png.byteLength > 10000,
      width: image.width,
      height: image.height,
      scope: image.scope,
    });
    const failure = await page.evaluate(async () => {
      const s = pilotSession,
        world = s.world;
      let rejected = false;
      try {
        await pilotHost.replace(
          new URL("../fixtures/missing-pilot.json", location.href).href,
        );
      } catch {
        rejected = true;
      }
      return {
        passed: rejected && s.world === world && !world.isDestroyed(),
        status: s.status(),
      };
    });
    report.checks.push({
      name: display + "-failed-load-retains-matching-world",
      ...failure,
    });
    assert(failure.passed);
    const retry = await page.evaluate(async () => {
      await pilotHost.replace();
      return pilotSession.status();
    });
    report.checks.push({
      name: display + "-retry",
      passed: retry.ready,
      status: retry,
    });
    assert(retry.ready);
    const disposed = await page.evaluate(() => {
      pilotSession.dispose();
      return pilotSession.status();
    });
    report.checks.push({
      name: display + "-dispose",
      passed:
        disposed.phase === "disposed" &&
        disposed.world === null &&
        disposed.targets === 0,
    });
  }
  assert(report.checks.every((c) => c.passed));
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
} finally {
  clearInterval(monitor);
  await browser?.close();
}
await writeFile(output + "/hosts.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      error: c.initial?.error,
    })),
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
