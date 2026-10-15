import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
import { installAllocationObserver } from "./gl-allocation-observer.mjs";
import { newOutput, openPilot, waitFg } from "./pilot-validation.mjs";
const repeats = Number(process.env.LUMEN_PILOT_REPLACEMENTS ?? 20),
  lodSwitches = Number(process.env.LUMEN_PILOT_LOD_SWITCHES ?? 50);
const output = await newOutput("runtime"),
  report = {
    version: sourceVersion([
      "scripts/verify-pilot-runtime.mjs",
      "scripts/pilot-validation.mjs",
      "scripts/gl-allocation-observer.mjs",
      "docs/product/local-gi-v0.1.md",
    ]),
    configuration: {
      requested: { repeats, lodSwitches },
      buffer: [1920, 1080],
      profiles: ["enhanced"],
      replacementsPerHost: 20,
      lodSwitches: 50,
      budget: 64 * 1048576,
      visibleLimit: 2000,
      cpuFirstLimit: 500,
      cpuFinalLimit: 2000,
      mipByteAllowancePerAllocation: 16,
    },
    rows: [],
    errors: [],
  };
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.addInitScript(installGlObserver);
  await page.addInitScript(installAllocationObserver);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  for (const display of ["models", "tiles"]) {
    console.log("Runtime " + display);
    await openPilot(page, display);
    await waitFg(page);
    const resources = async () =>
      page.evaluate(() => {
        pilotSession._account();
        const e = [...pilotSession.budget.entries.values()],
          gpu = e.filter((e) =>
            [
              "giGpu",
              "snapshotGpu",
              "fgGpu",
              "displayGpu",
              "environmentGpu",
            ].includes(e.category),
          );
        return {
          ledger: pilotSession.status().resources,
          gl: glMemoryObserver.snapshot(
            gpu.map((e) => e.handle).filter(Boolean),
          ),
          gpuLedger: gpu.reduce((n, e) => n + e.bytes, 0),
          unobservable: gpu.filter((e) => !e.handle).map((e) => e.category),
          status: pilotSession.status(),
        };
      });
    const initial = await resources(),
      replacements = [];
    const leakDetected = await page.evaluate(function LumenLeakProbe() {
      const gl = pilotHost.scene.context._gl,
        old = gl.getParameter(gl.TEXTURE_BINDING_2D),
        texture = gl.createTexture();
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        const handles = [...pilotSession.budget.entries.values()]
          .map((e) => e.handle)
          .filter(Boolean);
        return glMemoryObserver
          .snapshot(handles)
          .unlistedAdditional.some(
            (e) => e.bytes === 4 && e.origin.includes("LumenLeakProbe"),
          );
      } finally {
        gl.bindTexture(gl.TEXTURE_2D, old);
        gl.deleteTexture(texture);
      }
    });
    const boundary = await page.evaluate(async () => {
      const s = pilotSession,
        scene = pilotHost.scene;
      s._account();
      const before = s.status(),
        world = s.world,
        light = scene.light,
        models = [...s.models],
        tileset = s.tileset,
        glBefore = glMemoryObserver.snapshot().liveAllocationIds;
      const pressure = s.budget.onPressure;
      const held = s.budget.reserve(
        s.budget.limit - s.budget.admittedBytes,
        "critical admission test",
      );
      s.budget.onPressure = undefined;
      let rejection;
      try {
        await pilotHost.replace();
      } catch (e) {
        rejection = { name: e.name, message: String(e), stage: s.stage };
      } finally {
        held.release();
        s.budget.onPressure = pressure;
        s._account();
      }
      const after = s.status(),
        glAfter = glMemoryObserver.snapshot().liveAllocationIds;
      return {
        before,
        after,
        rejection,
        glBefore,
        glAfter,
        passed:
          rejection?.name === "QuotaExceededError" &&
          s.ready &&
          world === s.world &&
          !world.isDestroyed() &&
          light === scene.light &&
          tileset === s.tileset &&
          models.every((m, i) => m === s.models[i]) &&
          before.version === after.version &&
          before.world.revision === after.world.revision &&
          JSON.stringify(glBefore) === JSON.stringify(glAfter),
      };
    });
    assert(
      boundary.passed,
      "Budget rejection must retain the old matched dataset before GL allocation",
    );
    for (let i = 0; i < repeats; i++) {
      const row = await page.evaluate(async () => {
        const before = pilotSession.status(),
          world = pilotSession.world,
          start = performance.now();
        await pilotHost.replace();
        return {
          beforeGeneration: before.generation,
          oldDestroyed: world.isDestroyed(),
          after: pilotSession.status(),
          milliseconds: performance.now() - start,
        };
      });
      await waitFg(page);
      row.resources = await resources();
      replacements.push(row);
      assert(
        row.oldDestroyed &&
          row.after.generation === row.beforeGeneration + 1 &&
          row.after.world.triangles === 998,
      );
      console.log(
        JSON.stringify({
          display,
          replace: i + 1,
          peak: row.resources.ledger.peakAdmittedBytes,
        }),
      );
    }
    const lod = [];
    if (display === "tiles")
      for (let i = 0; i < lodSwitches; i++) {
        const detail = i % 2 ? "children" : "parent",
          before = await page.evaluate(() => pilotSession.status());
        if (i % 5 === 0) {
          await page.evaluate(() => {
            pilotHost.view({ eye: [35, -43, 30], target: [300, -400, 300] });
            pilotSession.evictDisplay();
          });
          await page.waitForFunction(
            () => pilotSession.status().targets === 0,
            null,
            { timeout: 60000 },
          );
          const away = await page.evaluate(() => pilotSession.status());
          assert.equal(away.world.triangles, 998);
          assert(away.world.ready);
          await page.evaluate(() => pilotHost.focus());
        }
        await page.evaluate((d) => pilotSession.setDisplayDetail(d), detail);
        await page.waitForFunction(
          (n) => pilotSession.status().targets === n,
          detail === "parent" ? 1 : 8,
          { timeout: 60000 },
        );
        const after = await page.evaluate(() => pilotSession.status());
        lod.push({
          detail,
          before: before.world,
          after: after.world,
          active: after.targets,
          version: after.version,
          passed:
            after.world.triangles === 998 &&
            after.generation === before.generation &&
            after.world.revision === before.world.revision,
        });
      }
    await waitFg(page);
    const relight = await page.evaluate(async () => {
      const s = pilotSession,
        scene = pilotHost.scene,
        pixels = [
          [640, 540],
          [960, 540],
          [1280, 540],
          [960, 810],
        ];
      glObserver.phase("visible-response-diagnostic");
      const before = await s.diagnostics({ pixels, usedOnly: true }),
        start = performance.now();
      const operation = s.setLighting({
        sunDirection: [0.8, 0.2, 0.15],
        sunRadiance: [0.4, 0.15, 0.05],
        skyRadiance: [0.03, 0.04, 0.08],
      });
      operation.catch(() => {});
      let visible,
        changed,
        diagnosticMilliseconds = 0;
      while (performance.now() - start < 10000 && !visible) {
        if (
          s.world.ready &&
          s.world.requestedRevision === s.world.publishedRevision
        ) {
          const begin = performance.now(),
            capture = await s.diagnostics({ pixels, usedOnly: true });
          diagnosticMilliseconds += performance.now() - begin;
          if (
            capture.usedE.some((v, i) =>
              v.some((x, k) => Math.abs(x - before.usedE[i][k]) > 1e-4),
            )
          ) {
            visible = performance.now() - start;
            changed = capture;
          }
        } else await s._afterFrame(() => {}, s._controller.signal, 2000);
      }
      const result = await operation;
      glObserver.phase("production-after-visible-diagnostic");
      return {
        before,
        changed,
        renderedPixelMilliseconds: visible ?? null,
        diagnosticWindowMilliseconds: diagnosticMilliseconds,
        cpuTiming: s.timings.at(-1),
        outcome: result.outcome,
        scope:
          "CPU-observed changed linear-E pixels in an explicitly synchronous diagnostic window; OS compositor/photon latency not-run",
      };
    });
    const temporal = await waitFg(page),
      final = await resources();
    const samples = [initial, ...replacements.map((r) => r.resources), final];
    const resourcePassed =
      leakDetected &&
      samples.every(
        (r) =>
          r.ledger.peakAdmittedBytes <= 67108864 &&
          r.gl.scopedPeakBytes + r.ledger.cpuKnown <= 67108864 &&
          r.gl.unlistedAdditional.length === 0 &&
          r.gl.unknownFormats.length === 0 &&
          r.gl.missing === 0 &&
          r.unobservable.length === 0 &&
          r.gl.bytes <= r.gpuLedger &&
          r.gpuLedger - r.gl.bytes <= r.gl.allocationCount * 16,
      );
    const timing = relight.cpuTiming,
      relightPassed =
        relight.outcome === "completed" &&
        relight.renderedPixelMilliseconds !== null &&
        relight.renderedPixelMilliseconds <= 2000 &&
        timing.firstSubmitted <= 500 &&
        timing.finalPublished <= 2000;
    const row = {
      display,
      boundary,
      initial,
      replacements,
      lod,
      relight,
      temporal,
      final,
      checks: {
        resource: resourcePassed && boundary.passed,
        replacements: replacements.length === 20,
        tilesResidency:
          display !== "tiles" ||
          (lod.length === 50 && lod.every((r) => r.passed)),
        temporal:
          temporal.fg.revision === temporal.world.revision &&
          temporal.fg.round === 3 &&
          temporal.fg.stablePasses >= 32,
        relightVisible: relightPassed,
      },
    };
    report.rows.push(row);
    await writeFile(output + `/${display}.json`, JSON.stringify(row), {
      flag: "wx",
    });
  }
  report.status =
    repeats < 20 || lodSwitches < 50
      ? "not-run"
      : report.rows.length === 2 &&
          report.rows.every((r) => Object.values(r.checks).every(Boolean)) &&
          !report.errors.length
        ? "passed"
        : "failed";
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser?.close();
}
await writeFile(output + "/runtime.json", JSON.stringify(report), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.rows.map((r) => ({ display: r.display, ...r.checks })),
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
