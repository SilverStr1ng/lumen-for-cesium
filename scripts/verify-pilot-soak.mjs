import assert from "node:assert/strict";
import { writeFile, appendFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
import { newOutput, openPilot, waitFg } from "./pilot-validation.mjs";
const output = await newOutput("soak");
const seconds = Number(process.env.LUMEN_SOAK_SECONDS ?? 1800),
  requiredSeconds = 1800,
  headed = process.env.LUMEN_SOAK_HEADED === "1";
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-soak.mjs",
    "scripts/pilot-validation.mjs",
    "docs/product/local-gi-v0.1.md",
  ]),
  configuration: {
    seconds,
    requiredSeconds,
    buffer: [1920, 1080],
    profile: "enhanced",
    display: "tiles",
    replacements: 20,
    lodSwitches: 50,
    budget: 64 * 1048576,
    renderDriver: "Actual CesiumWidget RAF, wall-clock cruise and relighting",
    browser: `${headed ? "headed" : "headless"}; security enabled; native tab visibility/background throttling, Playwright focus emulation disabled`,
  },
  samples: [],
  replacements: [],
  lod: [],
  lighting: [],
  errors: [],
  status: "not-run",
};
let browser;
try {
  browser = await launchBrowser({ naturalFocus: true, headless: !headed });
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  const browserSession = await browser.newBrowserCDPSession();
  const { arguments: browserArguments } = await browserSession.send(
    "Browser.getBrowserCommandLine",
  );
  report.browserControl = {
    headless: browserArguments.some((a) => a.startsWith("--headless")),
    chromiumSandbox: !browserArguments.includes("--no-sandbox"),
    focusEmulation: false,
    defaultBackgroundOverrides: browserArguments.filter((a) =>
      [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ].includes(a),
    ),
    scope:
      "Native browser tab visibility; OS window occlusion is a separate headed deployment concern",
  };
  await browserSession.detach();
  await page.addInitScript(installGlObserver);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await openPilot(page, "tiles");
  report.environment = await page.evaluate(() => {
    const gl = pilotHost.scene.context._gl,
      info = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      browser: navigator.userAgent,
      renderer: info
        ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
        : "not-run",
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      visibility: document.visibilityState,
    };
  });
  const environmentValid =
    report.browserControl.headless === !headed &&
    report.browserControl.chromiumSandbox &&
    report.browserControl.defaultBackgroundOverrides.length === 0 &&
    /5080/.test(report.environment.renderer) &&
    report.environment.drawingBuffer[0] === 1920 &&
    report.environment.drawingBuffer[1] === 1080 &&
    report.environment.visibility === "visible";
  assert(environmentValid, "Soak browser/device contract did not match");
  await waitFg(page);
  await page.evaluate(() => {
    window.pilotCruise = {
      frames: 0,
      start: performance.now(),
      intervals: [],
      stutters: 0,
      totalIntervals: 0,
    };
    pilotCruise.remove = pilotHost.scene.preRender.addEventListener(() => {
      const t = (performance.now() - pilotCruise.start) / 1000;
      const now = performance.now();
      if (pilotCruise.last !== undefined) {
        const dt = now - pilotCruise.last;
        pilotCruise.intervals.push(dt);
        if (pilotCruise.intervals.length > 4096) pilotCruise.intervals.shift();
        pilotCruise.totalIntervals++;
        if (dt > 50) pilotCruise.stutters++;
      }
      pilotCruise.last = now;
      pilotCruise.frames++;
      if (pilotCruise.paused) return;
      pilotHost.view({
        eye: [
          35 * Math.cos(t / 35),
          -40 + 10 * Math.sin(t / 25),
          25 + 4 * Math.sin(t / 15),
        ],
        target: [0, 1, 2.4],
      });
    });
  });
  const started = Date.now();
  let idleTested = false;
  let nextReplacement = 0,
    nextLod = 0,
    nextLight = 0;
  while (Date.now() - started < seconds * 1000) {
    const elapsed = (Date.now() - started) / 1000;
    if (report.replacements.length < 20 && elapsed >= nextReplacement) {
      const row = await page.evaluate(async () => {
        const before = pilotSession.status(),
          start = performance.now();
        await pilotHost.replace();
        return {
          before: { generation: before.generation, version: before.version },
          after: pilotSession.status(),
          milliseconds: performance.now() - start,
        };
      });
      report.replacements.push(row);
      nextReplacement += Math.max(1, seconds / 25);
      console.log(
        JSON.stringify({
          phase: "replace",
          n: report.replacements.length,
          peak: row.after.resources.peakKnownBytes,
        }),
      );
    }
    if (report.lod.length < 50 && elapsed >= nextLod) {
      const detail = report.lod.length % 2 ? "children" : "parent";
      const row = await page.evaluate(async (detail) => {
        const before = pilotSession.status(),
          world = pilotSession.world;
        await pilotSession.setDisplayDetail(detail);
        return {
          detail,
          before: {
            generation: before.generation,
            triangles: before.world.triangles,
            revision: before.world.revision,
          },
          after: pilotSession.status(),
          sameWorld: world === pilotSession.world,
        };
      }, detail);
      await page.waitForFunction(
        (detail) =>
          pilotSession.status().targets === (detail === "parent" ? 1 : 8),
        detail,
        { timeout: 60000 },
      );
      row.settled = await page.evaluate(() => pilotSession.status());
      row.passed =
        row.sameWorld &&
        row.before.triangles === row.after.world.triangles &&
        row.before.generation === row.after.generation &&
        row.before.revision === row.after.world.revision;
      report.lod.push(row);
      assert(row.passed);
      nextLod += Math.max(1, seconds / 60);
    }
    if (elapsed >= nextLight) {
      const night = report.lighting.length % 2 === 0,
        lighting = night
          ? {
              sunDirection: [0.8, 0.2, 0.15],
              sunRadiance: [0.4, 0.15, 0.05],
              skyRadiance: [0.03, 0.04, 0.08],
            }
          : {
              sunDirection: [-0.8, 0.6, 1.1],
              sunRadiance: [2, 2, 2],
              skyRadiance: [0.15, 0.18, 0.22],
            };
      const row = await page.evaluate(async (lighting) => {
        await pilotSession.setLighting(lighting);
        return pilotSession.status().timings.at(-1);
      }, lighting);
      report.lighting.push(row);
      nextLight += Math.max(3, seconds / 30);
    }
    if (!idleTested && elapsed >= seconds * 0.5) {
      const before = await page.evaluate(() => {
        pilotCruise.paused = true;
        return {
          version: pilotSession.status().version,
          revision: pilotSession.status().world.revision,
          visibility: document.visibilityState,
        };
      });
      const idle = await context.newPage();
      await idle.goto("about:blank");
      await idle.bringToFront();
      const hidden = await page.evaluate(() => document.visibilityState);
      await page.waitForTimeout(1000);
      await page.bringToFront();
      await idle.close();
      const visible = await page.evaluate(() =>
        pilotSession.waitForVisible({ timeoutMilliseconds: 60000 }),
      );
      await waitFg(page);
      const after = await page.evaluate(() => ({
        version: pilotSession.status().version,
        revision: pilotSession.status().world.revision,
        visibility: document.visibilityState,
      }));
      report.background = {
        before,
        hidden,
        after,
        visible,
        status:
          hidden !== "hidden"
            ? "not-run"
            : visible.visible && after.visibility === "visible"
              ? "passed"
              : "failed",
        consistent:
          before.version === after.version &&
          before.revision === after.revision,
      };
      await page.evaluate(() => {
        pilotCruise.paused = false;
      });
      idleTested = true;
    }
    const sample = await page.evaluate(() => ({
      status: pilotSession.status(),
      cruiseFrames: pilotCruise.frames,
      fgFrames: pilotHost.scene.lumen.finalGather.metrics.frames,
      continuousSampling: pilotHost.scene.lumen.finalGather.continuousSampling,
      visibility: document.visibilityState,
    }));
    sample.elapsed = (Date.now() - started) / 1000;
    const previous = report.samples.at(-1);
    if (previous) {
      sample.advance = {
        seconds: sample.elapsed - previous.elapsed,
        sceneFrames: sample.cruiseFrames - previous.cruiseFrames,
        fgFrames: sample.fgFrames - previous.fgFrames,
        sameGeneration: sample.status.generation === previous.status.generation,
        sameRevision:
          sample.status.world?.revision === previous.status.world?.revision,
      };
      sample.advance.stable =
        sample.advance.sameGeneration &&
        sample.advance.sameRevision &&
        sample.visibility === "visible" &&
        previous.visibility === "visible";
      sample.advance.passed =
        sample.advance.sceneFrames > 0 &&
        (!sample.advance.stable ||
          (sample.advance.fgFrames > 0 &&
            sample.continuousSampling &&
            sample.status.fg.effectiveMode === "fg"));
    }
    report.samples.push(sample);
    await appendFile(output + "/samples.ndjson", JSON.stringify(sample) + "\n");
    console.log(
      JSON.stringify({
        phase: "soak",
        seconds: sample.elapsed,
        frames: sample.cruiseFrames,
        fgFrames: sample.fgFrames,
        peak: sample.status.resources.peakKnownBytes,
      }),
    );
    await page.waitForTimeout(1000);
  }
  report.wallSeconds = (Date.now() - started) / 1000;
  const freshStart = await page.evaluate(() => {
    pilotCruise.paused = true;
    return {
      scene: pilotCruise.frames,
      fg: pilotHost.scene.lumen.finalGather.metrics.frames,
    };
  });
  await waitFg(page);
  report.final = await page.evaluate(() => {
    pilotCruise.remove();
    return {
      status: pilotSession.status(),
      observer: glObserver.snapshot(),
      frames: pilotCruise.frames,
      fgFrames: pilotHost.scene.lumen.finalGather.metrics.frames,
      cadence: {
        intervalP95: [...pilotCruise.intervals].sort((a, b) => a - b)[
          Math.ceil(pilotCruise.intervals.length * 0.95) - 1
        ],
        stutterFraction:
          pilotCruise.stutters / Math.max(1, pilotCruise.totalIntervals),
        intervals: pilotCruise.totalIntervals,
      },
    };
  });
  report.disposal = await page.evaluate(() => {
    pilotSession.dispose();
    return pilotSession.status();
  });
  const enough =
    report.wallSeconds >= 1800 &&
    report.replacements.length === 20 &&
    report.lod.length === 50 &&
    report.lighting.length >= 20;
  const noReads = report.final.observer.every((s) =>
    Object.values(s.phases).every(
      (p) =>
        !(
          p.readPixels ||
          p.getBufferSubData ||
          p.finish ||
          p.blockingClientWaitSync
        ),
    ),
  );
  report.checks = {
    environment: environmentValid,
    duration: enough,
    budget: report.final.status.resources.peakAdmittedBytes <= 64 * 1048576,
    residentLod: report.lod.every((r) => r.passed),
    continuous:
      report.samples.slice(1).every((s) => s.advance.passed) &&
      report.samples.filter((s) => s.advance?.stable && s.advance.fgFrames > 0)
        .length >
        report.samples.length * 0.5 &&
      report.final.frames > freshStart.scene &&
      report.final.fgFrames >= freshStart.fg + 32,
    noReads,
    background:
      report.background?.status === "passed" && report.background.consistent,
    disposed: report.disposal.world === null && report.disposal.targets === 0,
  };
  report.status =
    seconds < requiredSeconds
      ? "not-run"
      : Object.values(report.checks).every(Boolean) && !report.errors.length
        ? "passed"
        : "failed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
} finally {
  await browser?.close();
}
await writeFile(output + "/soak.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    seconds: report.wallSeconds,
    replacements: report.replacements.length,
    lod: report.lod.length,
    checks: report.checks,
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
