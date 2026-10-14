import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, environment, sourceVersion } from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/initial";
await mkdir(out, { recursive: true });
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 960, height: 600 } }),
  report = { version: sourceVersion(), errors: [], console: [] };
p.on("pageerror", (e) => {
  report.errors.push(String(e));
  console.error(String(e));
});
p.on("console", (m) => {
  if (m.type() === "error") {
    report.console.push(m.text());
    console.error(m.text());
  }
});
try {
  await p.goto(
    `http://localhost:8090/demo/ballpool.html?diagnostic=1&count=${process.env.LUMEN_BALL_COUNT ?? 1}&camera=close`,
  );
  await p.waitForFunction(
    () =>
      document.querySelector(".cesium-widget-errorPanel") ||
      (ballPool.world?.ready && ballPool.scene.lumen.finalGather.ready),
    null,
    { timeout: 180000 },
  );
  const renderError = (await p.locator(".cesium-widget-errorPanel").count())
    ? await p.locator(".cesium-widget-errorPanel").textContent()
    : "";
  if (renderError) throw Error(renderError);
  await p.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 60000 },
  );
  report.environment = await environment(p, b);
  report.capture = await p.evaluate(async () => {
    const { captureCurved } = await import("/demo/curved-diagnostics.js");
    return captureCurved(ballPool);
  });
  report.state = await p.evaluate(() => ballPool.snapshot());
  await p.screenshot({ path: out + "/static.png" });
  report.status =
    report.errors.length || report.console.length ? "failed" : "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  report.ui = await p
    .locator("#error")
    .textContent()
    .catch(() => "");
} finally {
  await b.close();
  await writeFile(out + "/smoke.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    ui: report.ui,
    errors: report.errors,
    console: report.console.slice(-2).map((s) => s.slice(0, 350)),
    coverage: report.capture?.meanWeight,
    resource: report.state?.resources,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
