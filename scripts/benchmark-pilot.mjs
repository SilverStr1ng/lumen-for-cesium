import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
import { newOutput, openPilot, waitFg } from "./pilot-validation.mjs";
const output = await newOutput("performance");
const configuration = {
  buffer: [1920, 1080],
  profiles: ["baseline", "enhanced"],
  displays: ["models", "tiles"],
  warmFrames: 80,
  frames: 240,
  fps30: { gpuP95: 33.3, cpuP95: 33.3, intervalP95: 40, stutterFraction: 0.05 },
  fps60: { gpuP95: 16.7 },
  cache: false,
  headless: process.env.LUMEN_HEADFUL !== "1",
  motions: ["stationary", "moving"],
  renderDriver: "unmodified CesiumWidget requestAnimationFrame loop",
};
const report = {
  version: sourceVersion([
    "scripts/benchmark-pilot.mjs",
    "scripts/pilot-validation.mjs",
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
    await openPilot(page, display, "baseline");
    for (const profile of configuration.profiles) {
      for (const motion of configuration.motions) {
        console.log("Measuring " + display + "/" + profile + "/" + motion);
        if ((await page.evaluate(() => pilotSession.profile)) !== profile)
          await page.evaluate((p) => pilotSession.setQuality(p), profile);
        if (profile === "enhanced") await waitFg(page);
        const result = await page.evaluate(
          async (config) => {
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
            const fg = scene.lumen.finalGather,
              moveStart = performance.now();
            const timerCapacity = s.budget.tryReserve(
              32 * 4096,
              "benchmark queries",
            );
            if (!timerCapacity)
              throw Error("No budget for bounded measurement queries");
            const pending = [];
            let q;
            const removeMove =
              config.motion === "moving"
                ? scene.preRender.addEventListener(() => {
                    const t = (performance.now() - moveStart) / 1000;
                    pilotHost.view({
                      eye: [
                        35 + 4 * Math.sin(t),
                        -43 + 3 * Math.cos(t),
                        30 + 2 * Math.sin(t * 0.5),
                      ],
                      target: [0, 1, 2.4],
                    });
                  })
                : () => {};
            try {
              for (let n = 0; n < config.warmFrames; n++)
                await s._afterFrame(() => {});
              const fgStart = fg.metrics.frames;
              const disjointStart =
                fg.metrics.disjoint + s.world.metrics.disjoint;
              glObserver.phase("steady-production");
              const cpu = [],
                intervals = [],
                gpu = [];
              let start,
                last,
                frames = 0,
                fgEnd = fgStart,
                effectiveFgFrames = 0,
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
                  if (
                    ext &&
                    pending.length < 32 &&
                    !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
                  ) {
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
                  if (
                    fg.metrics.effectiveMode === "fg" &&
                    fg._sampleWorld === s.world
                  )
                    effectiveFgFrames++;
                  if (ext) {
                    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++;
                    while (
                      pending.length &&
                      gl.getQueryParameter(
                        pending[0],
                        gl.QUERY_RESULT_AVAILABLE,
                      )
                    ) {
                      const query = pending.shift();
                      gpu.push(
                        gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6,
                      );
                      gl.deleteQuery(query);
                    }
                  }
                  if (++frames >= config.frames) {
                    fgEnd = fg.metrics.frames;
                    pre();
                    post();
                    clearTimeout(timeout);
                    resolve();
                  }
                });
              });
              for (let i = 0; i < 60 && pending.length; i++) {
                await s._afterFrame(() => {});
                while (
                  pending.length &&
                  gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)
                ) {
                  const query = pending.shift();
                  gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
                  gl.deleteQuery(query);
                }
              }
              // Query availability is polled without a blocking wait or finish.
              while (pending.length) {
                const query = pending.shift();
                if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
                  gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
                else missing++;
                gl.deleteQuery(query);
              }
              disjoint +=
                fg.metrics.disjoint + s.world.metrics.disjoint - disjointStart;
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
                continuousSampling: fg.continuousSampling,
                fgExecuted: fgEnd - fgStart,
                effectiveFgFrames,
                measurementQueryReservation: 32 * 4096,
              };
            } finally {
              removeMove();
              if (q) {
                gl.endQuery(ext.TIME_ELAPSED_EXT);
                gl.deleteQuery(q);
              }
              for (const query of pending) gl.deleteQuery(query);
              timerCapacity.release();
            }
          },
          { ...configuration, motion },
        );
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
          productionReads === 0 &&
          (profile !== "enhanced" ||
            (result.continuousSampling &&
              result.fgExecuted >= configuration.frames * 0.9 &&
              result.effectiveFgFrames >= configuration.frames * 0.9));
        const row = {
          display,
          profile,
          motion,
          ...result,
          productionReads,
          passed,
          fps60Observed: result.gpuP95 !== null && result.gpuP95 <= 16.7,
        };
        report.rows.push(row);
        await writeFile(
          output + `/${display}-${profile}-${motion}.json`,
          JSON.stringify(row, null, 2),
          { flag: "wx" },
        );
        console.log(
          JSON.stringify({
            display,
            profile,
            motion,
            passed,
            gpuP95: result.gpuP95,
            cpuP95: result.cpuP95,
            intervalP95: result.intervalP95,
          }),
        );
      }
    }
  }
  report.status =
    report.rows.length === 8 &&
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
