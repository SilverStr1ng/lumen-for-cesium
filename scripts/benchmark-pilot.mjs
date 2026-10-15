import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const output =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/local-gi-pilot-v10/benchmark-first";
await mkdir(output, { recursive: true });
const configuration = {
  buffer: [1920, 1080],
  profiles: ["baseline", "enhanced"],
  displays: ["models", "tiles"],
  warmFrames: 80,
  frames: 240,
  fps30: { gpuP95: 33.3, cpuP95: 33.3, intervalP95: 40, stutterFraction: 0.05 },
  fps60: { gpuP95: 16.7 },
  cache: false,
  renderDriver: "unmodified CesiumWidget requestAnimationFrame loop",
};
const report = {
  version: sourceVersion([
    "scripts/benchmark-pilot.mjs",
    "docs/product/local-gi-v0.1.md",
  ]),
  configuration,
  rows: [],
  errors: [],
  status: "not-run",
};
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.addInitScript(installGlObserver);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  for (const display of configuration.displays) {
    await page.goto("http://localhost:8090/demo/pilot-" + display + ".html");
    await page.waitForFunction(
      () => pilotSession?.ready || pilotSession?.phase === "failed",
      null,
      { timeout: 240000 },
    );
    if (!(await page.evaluate(() => pilotSession.ready)))
      throw Error(await page.evaluate(() => pilotSession.error));
    for (const profile of configuration.profiles) {
      console.log("Measuring " + display + "/" + profile);
      if ((await page.evaluate(() => pilotSession.profile)) !== profile)
        await page.evaluate((p) => pilotSession.setQuality(p), profile);
      const result = await page.evaluate(async (config) => {
        const s = pilotSession,
          scene = pilotHost.scene,
          gl = scene.context._gl,
          ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
          info = gl.getExtension("WEBGL_debug_renderer_info"),
          device = {
            renderer: info
              ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
            vendor: info
              ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL)
              : gl.getParameter(gl.VENDOR),
            browser: navigator.userAgent,
            width: scene.drawingBufferWidth,
            height: scene.drawingBufferHeight,
            visibility: document.visibilityState,
          };
        await new Promise((resolve) => {
          let n = 0;
          const remove = scene.postRender.addEventListener(() => {
            if (++n === config.warmFrames) {
              remove();
              resolve();
            }
          });
        });
        glObserver.phase("steady-production");
        const cpu = [],
          intervals = [],
          gpu = [],
          pending = [];
        let start,
          last,
          q,
          frames = 0,
          disjoint = 0,
          missing = 0;
        const started = performance.now();
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pre();
            post();
            reject(
              Error(
                "Actual render cadence did not complete measurement in 120s",
              ),
            );
          }, 120000);
          const pre = scene.preRender.addEventListener(() => {
            start = performance.now();
            if (last !== undefined) intervals.push(start - last);
            last = start;
            if (ext && !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
              q = gl.createQuery();
              gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            } else missing++;
          });
          const post = scene.postRender.addEventListener(() => {
            if (q) {
              gl.endQuery(ext.TIME_ELAPSED_EXT);
              pending.push(q);
              q = undefined;
            }
            cpu.push(performance.now() - start);
            if (ext) {
              if (gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++;
              while (
                pending.length &&
                gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)
              ) {
                const query = pending.shift();
                gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
                gl.deleteQuery(query);
              }
            }
            if (++frames >= config.frames) {
              pre();
              post();
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        for (let i = 0; i < 60 && pending.length; i++) {
          await new Promise((resolve) => {
            const remove = scene.postRender.addEventListener(() => {
              remove();
              resolve();
            });
          });
        }
        // Query availability is polled without a blocking wait or finish.
        while (pending.length) {
          const query = pending.shift();
          if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
            gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
          else missing++;
          gl.deleteQuery(query);
        }
        const p95 = (values) =>
          values.length
            ? [...values].sort((a, b) => a - b)[
                Math.ceil(values.length * 0.95) - 1
              ]
            : null;
        return {
          device,
          cpu,
          gpu,
          intervals,
          cpuP95: p95(cpu),
          gpuP95: p95(gpu),
          intervalP95: p95(intervals),
          stutterFraction:
            intervals.filter((v) => v > 50).length / intervals.length,
          frames,
          wallMilliseconds: performance.now() - started,
          disjoint,
          missing,
          observer: glObserver.snapshot(),
          status: s.status(),
        };
      }, configuration);
      const productionReads = result.observer.reduce(
        (n, s) =>
          n +
          Object.values(s.phases).reduce(
            (total, p) =>
              total +
              (p.readPixels ?? 0) +
              (p.getBufferSubData ?? 0) +
              (p.finish ?? 0) +
              (p.blockingClientWaitSync ?? 0),
            0,
          ),
        0,
      );
      const passed =
        result.device.width === 1920 &&
        result.device.height === 1080 &&
        /5080/.test(result.device.renderer) &&
        result.gpu.length >= configuration.frames * 0.9 &&
        !result.disjoint &&
        result.gpuP95 <= 33.3 &&
        result.cpuP95 <= 33.3 &&
        result.intervalP95 <= 40 &&
        result.stutterFraction <= 0.05 &&
        productionReads === 0;
      const row = {
        display,
        profile,
        ...result,
        productionReads,
        passed,
        fps60Observed: result.gpuP95 !== null && result.gpuP95 <= 16.7,
      };
      report.rows.push(row);
      await writeFile(
        output + `/${display}-${profile}.json`,
        JSON.stringify(row, null, 2),
        { flag: "wx" },
      );
      console.log(
        JSON.stringify({
          display,
          profile,
          passed,
          gpuP95: result.gpuP95,
          cpuP95: result.cpuP95,
          intervalP95: result.intervalP95,
        }),
      );
    }
  }
  report.status =
    report.rows.length === 4 &&
    report.rows.every((r) => r.passed) &&
    !report.errors.length
      ? "passed"
      : "failed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
} finally {
  await browser?.close();
}
await writeFile(output + "/benchmark.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
