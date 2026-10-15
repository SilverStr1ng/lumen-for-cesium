import assert from "node:assert/strict";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const output =
  process.env.LUMEN_REPORT_DIRECTORY ?? "reports/local-gi-pilot-v10/soak-first";
await mkdir(output, { recursive: true });
const seconds = Number(process.env.LUMEN_SOAK_SECONDS ?? 1800),
  requiredSeconds = 1800;
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-soak.mjs",
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
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.addInitScript(installGlObserver);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(
    "http://localhost:8090/demo/pilot-tiles.html?profile=enhanced",
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
  await page.evaluate(() => {
    window.pilotCruise = { frames: 0, start: performance.now() };
    pilotCruise.remove = pilotHost.scene.preRender.addEventListener(() => {
      const t = (performance.now() - pilotCruise.start) / 1000;
      pilotCruise.frames++;
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
    const sample = await page.evaluate(() => ({
      status: pilotSession.status(),
      cruiseFrames: pilotCruise.frames,
      fgFrames: pilotHost.scene.lumen.finalGather.metrics.frames,
      continuousSampling: pilotHost.scene.lumen.finalGather.continuousSampling,
    }));
    sample.elapsed = (Date.now() - started) / 1000;
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
  report.final = await page.evaluate(() => {
    pilotCruise.remove();
    return {
      status: pilotSession.status(),
      observer: glObserver.snapshot(),
      frames: pilotCruise.frames,
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
    duration: enough,
    budget: report.final.status.resources.peakKnownBytes <= 64 * 1048576,
    residentLod: report.lod.every((r) => r.passed),
    continuous:
      report.samples.filter(
        (s) => s.continuousSampling && s.status.fg.effectiveMode === "fg",
      ).length >
      report.samples.length * 0.5,
    noReads,
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
