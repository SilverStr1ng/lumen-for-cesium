import assert from "node:assert/strict";
import "./verify-shader-preparation.mjs";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { installStartupObserver } from "./startup-observer.mjs";
import { probeNativeCancellation } from "./native-cancel-probe.mjs";
import {
  newOutput,
  pilotBase,
  openPilot,
  waitFg,
} from "./pilot-validation.mjs";
const stages = [
    "auditing",
    "base-warming",
    "gi-warming",
    "fg-warming",
    "stopped",
    "context-loss",
    "dispose",
  ],
  selected = (process.env.LUMEN_SHADER_LIFECYCLE_STAGES ?? stages.join(","))
    .split(",")
    .filter(Boolean),
  displays = (process.env.LUMEN_PILOT_DISPLAYS ?? "models,tiles").split(","),
  repeats = Number(process.env.LUMEN_PILOT_REPLACEMENTS ?? 20),
  output = await newOutput("shader-lifecycle"),
  report = {
    version: sourceVersion([
      "scripts/verify-pilot-shader-lifecycle.mjs",
      "scripts/verify-shader-preparation.mjs",
      "scripts/startup-observer.mjs",
      "scripts/pilot-validation.mjs",
      "scripts/native-cancel-probe.mjs",
    ]),
    configuration: {
      stages,
      selected,
      displays,
      replacements: repeats,
      buffer: [1920, 1080],
      cancelLimit: 250,
    },
    rows: [],
    errors: [],
    status: "not-run",
  };
let browser;
try {
  browser = await launchBrowser({ recordArguments: true });
  for (const display of displays)
    for (const stage of selected) {
      const row = { display, stage, errors: [] };
      let page, releaseFetch;
      try {
        console.log(JSON.stringify({ display, stage }));
        page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
        });
        page.on("pageerror", (e) => row.errors.push(String(e)));
        await page.addInitScript(installStartupObserver);
        if (stage === "auditing") {
          const gate = new Promise((resolve) => {
            releaseFetch = resolve;
          });
          await page.route(
            "**/fixtures/local-pilot/dataset.json",
            async (route) => {
              await gate;
              await route.continue().catch(() => {});
            },
          );
        }
        await page.goto(
          pilotBase() + `pilot-${display}.html?profile=enhanced`,
          { waitUntil: "commit" },
        );
        await page.waitForFunction(
          (stage) => {
            const s = window.pilotSession;
            if (s?.phase === "failed") throw Error(s.error);
            if (!s) return false;
            if (stage === "auditing") return s.phase === "auditing";
            const state = s.status().startup.state;
            if (stage === "base-warming") return state === "base-warming";
            if (stage === "gi-warming") return !!s.world && !s.world.ready;
            if (stage === "fg-warming")
              return s.ready && state === "fg-warming";
            return (
              s.world &&
              Object.values(pilotHost.scene.context.shaderCache._shaders).some(
                (c) => !!c.shaderProgram._pending,
              )
            );
          },
          stage,
          { timeout: 60000 },
        );
        row.before = await page.evaluate(() => {
          const context = pilotHost.scene.context;
          window.oldPending = Object.values(context.shaderCache._shaders)
            .map((c) => c.shaderProgram)
            .filter((p) => !!p._pending);
          return {
            generation: pilotSession.generation,
            status: pilotSession.status(),
            pending: oldPending.length,
          };
        });
        if (stage === "context-loss") {
          await page.evaluate(() =>
            pilotHost.scene.context._gl
              .getExtension("WEBGL_lose_context")
              .loseContext(),
          );
          await page.waitForFunction(
            () => pilotSession.phase === "context-lost" && !pilotSession.world,
          );
        } else if (stage === "dispose") {
          await page.evaluate(() => pilotSession.dispose());
        } else {
          if (stage === "stopped")
            await page.evaluate(() => pilotHost.setRenderingEnabled(false));
          const box = await page.locator("#cancel").boundingBox();
          const cdp = await page.context().newCDPSession(page),
            position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const timestamp = Date.now() / 1000;
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...position,
            button: "left",
            clickCount: 1,
            timestamp,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...position,
            button: "left",
            clickCount: 1,
            timestamp,
          });
          await page.waitForFunction(
            () => pilotSession.phase === "cancelled",
            null,
            { timeout: 5000 },
          );
          row.input = await page.evaluate(() =>
            startupProbe.inputs.findLast((e) => e.cancel),
          );
          assert(
            row.input && row.input.delay <= report.configuration.cancelLimit,
            "Real cancel input exceeded frozen delay",
          );
        }
        releaseFetch?.();
        await page.waitForTimeout(150);
        await page.waitForFunction(
          () =>
            !pilotHost.scene.context._shaderPreparationLifetime?.retired.size,
          null,
          { timeout: 30000 },
        );
        row.nativeCleanup = await page.evaluate(() => ({
          error: pilotHost.scene.context._gl.getError(),
          pending:
            pilotHost.scene.context._shaderPreparationLifetime?.native.size ??
            0,
          retired:
            pilotHost.scene.context._shaderPreparationLifetime?.retired.size ??
            0,
          cleanupError:
            pilotHost.scene.context._shaderPreparationLifetime?.error,
        }));
        if (stage !== "context-loss")
          assert.equal(
            row.nativeCleanup.error,
            0,
            "Cancellation left a native GL error",
          );
        assert.equal(row.nativeCleanup.retired, 0);
        assert.equal(row.nativeCleanup.cleanupError, undefined);
        row.after = await page.evaluate(() => ({
          status: pilotSession.status(),
          oldPending: oldPending.map((p) => ({
            destroyed: p.isDestroyed(),
            pending: !p.isDestroyed() && !!p._pending,
          })),
          remainingModels: pilotSession.models.length,
        }));
        assert.equal(row.after.status.world, null);
        assert.equal(row.after.status.targets, 0);
        if (stage !== "auditing" && stage !== "context-loss")
          assert(
            row.after.oldPending.every((p) => !p.pending),
            "Request-only old program still pending",
          );
        assert.equal(row.errors.length, 0);
        await page.screenshot({ path: `${output}/${display}-${stage}.png` });
        if (stage === "dispose" || stage === "context-loss") {
          await page.evaluate(() => pilotHost.recreate());
          await waitFg(page);
          row.recreated = await page.evaluate(() => pilotSession.status());
          assert(row.recreated.ready);
        }
        row.passed = true;
      } catch (error) {
        row.errors.push(String(error));
        row.passed = false;
        console.error(String(error));
      } finally {
        releaseFetch?.();
        await page?.close();
      }
      report.rows.push(row);
      await writeFile(
        `${output}/${display}-${stage}.json`,
        JSON.stringify(row, null, 2),
        { flag: "wx" },
      );
    }
  for (const display of displays) {
    const row = { display, stage: "cache-reload", errors: [], counts: [] };
    let page;
    try {
      console.log(JSON.stringify({ display, stage: row.stage }));
      page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      page.on("pageerror", (e) => row.errors.push(String(e)));
      await page.addInitScript(installStartupObserver);
      await openPilot(page, display);
      await waitFg(page);
      const inventory = () =>
        page.evaluate(() => {
          const c = pilotHost.scene.context.shaderCache;
          return {
            sourcePairs: [
              ...new Set(
                startupProbe.programs.map((p) =>
                  p.shaders
                    .map((id) => startupProbe.shaders[id].source)
                    .join(":"),
                ),
              ),
            ].length,
            live: Object.keys(c._shaders).length,
            roots: c.numberOfShaders,
            rootReferences: Object.values(c._shaders)
              .filter((e) => !e.parent)
              .reduce((s, e) => s + e.count, 0),
            nativePeak:
              pilotHost.scene.context._shaderPreparationLifetime?.peakNative ??
              0,
            retiredPeak:
              pilotHost.scene.context._shaderPreparationLifetime?.peakRetired ??
              0,
            retained: c._preparationLease.size,
            overflow: !!c.preparationRetentionOverflow,
            admitted: pilotSession.status().resources.admittedBytes,
          };
        });
      row.counts.push(await inventory());
      if (display === "models") {
        report.nativeCancellation = await probeNativeCancellation(page, output);
        assert(
          report.nativeCancellation.passed,
          "Native cancellation safe path failed",
        );
      }
      for (let i = 0; i < repeats; i++) {
        await page.evaluate(() => pilotHost.replace());
        await waitFg(page);
        await page.waitForFunction(
          () => pilotSession.status().startup.state === "ready",
          null,
          { timeout: 30000 },
        );
        row.counts.push(await inventory());
      }
      const tail = row.counts.slice(-5);
      assert.equal(
        new Set(tail.map((v) => v.rootReferences)).size,
        1,
        "Cache root references keep growing after reload",
      );
      assert(
        row.counts.every((v) => v.nativePeak <= 32 && v.retiredPeak <= 32),
        "Native preparation/retirement capacity exceeded",
      );
      assert.equal(
        new Set(tail.map((v) => v.sourcePairs)).size,
        1,
        "Shader source kinds keep growing after reload",
      );
      assert.equal(
        new Set(tail.map((v) => v.live)).size,
        1,
        "Live program families keep growing after reload",
      );
      assert(
        row.counts.every(
          (v) => v.retained <= 256 && !v.overflow && v.admitted <= 67108864,
        ),
      );
      const sources = await page.evaluate(() => startupProbe.sources);
      row.sourceHashes = sources.map((s) =>
        createHash("sha256").update(s).digest("hex"),
      );
      row.readiness = await page.evaluate(() =>
        startupProbe.programs
          .filter((p) => p.completionPolls)
          .map((p) => ({
            program: p.id,
            completed: p.completed,
            linkStatus: p.linkStatusChecked,
            reflection: p.firstReflection,
            use: p.firstUse,
          })),
      );
      await page.waitForFunction(
        () => !pilotHost.scene.context._shaderPreparationLifetime?.retired.size,
        null,
        { timeout: 30000 },
      );
      assert.equal(
        await page.evaluate(() => pilotHost.scene.context._gl.getError()),
        0,
        "Cache reload left a native GL error",
      );
      assert(
        row.readiness.every(
          (p) =>
            p.linkStatus === undefined ||
            (p.completed !== undefined && p.linkStatus >= p.completed),
        ),
        "LINK_STATUS before nonblocking completion",
      );
      await page.evaluate(() => pilotSession.dispose());
      await page.waitForFunction(
        () => !pilotHost.scene.context._shaderPreparationLifetime?.retired.size,
        null,
        { timeout: 30000 },
      );
      row.disposed = await page.evaluate(() => ({
        status: pilotSession.status(),
        live: Object.keys(pilotHost.scene.context.shaderCache._shaders).length,
      }));
      assert.equal(row.disposed.status.world, null);
      assert.equal(row.errors.length, 0);
      row.passed = true;
    } catch (error) {
      row.errors.push(String(error));
      row.passed = false;
      console.error(String(error));
    } finally {
      await page?.close();
    }
    report.rows.push(row);
    await writeFile(
      `${output}/${display}-cache-reload.json`,
      JSON.stringify(row, null, 2),
      { flag: "wx" },
    );
  }
} catch (error) {
  report.errors.push(String(error));
} finally {
  await browser?.close();
}
report.status =
  report.errors.length || report.rows.some((r) => !r.passed)
    ? "failed"
    : selected.length === stages.length &&
        displays.length === 2 &&
        repeats >= 20
      ? "passed"
      : "not-run";
await writeFile(
  `${output}/shader-lifecycle.json`,
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    output,
    status: report.status,
    checks: report.rows.map((r) => ({
      display: r.display,
      stage: r.stage,
      passed: r.passed,
      errors: r.errors,
    })),
  }),
);
if (report.status !== "passed") process.exitCode = 1;
