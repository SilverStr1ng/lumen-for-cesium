import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ?? "reports/fg-runtime-budget-v7";
await mkdir(out, { recursive: true });
const report = {
  version: sourceVersion(["scripts/verify-fg-desktop.mjs"]),
  rows: [],
  errors: [],
  checks: [],
};
const b = await launchBrowser();
try {
  for (const scene of ["original", "gallery"]) {
    const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
    p.on("pageerror", (e) => report.errors.push(String(e)));
    await p.addInitScript(installGlObserver);
    await p.goto(
      "http://localhost:8090/demo/" +
        (scene === "gallery" ? "gallery.html?nativeBuffer=1" : "globe.html") +
        "",
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
      [1280, 800],
    ]) {
      await p.setViewportSize({ width, height });
      const row = await p.evaluate(
        async ({ width, height }) => {
          const d = earthLab,
            s = d.scene,
            f = s.lumen.finalGather;
          d.widget.resize();
          d.world.setDisplayTransition(0);
          d.camera(
            d.metadata.name.includes("gallery") ? "courtyard" : "boxFoot",
          );
          await f.configure({
            mode: "fg",
            quality: "high",
            sampling: "reconstructed",
            model: d.model,
          });
          await d.world.completed;
          d.widget.useDefaultRenderLoop = false;
          d.widget.render();
          const fixed = {
            ready: f.ready,
            status: f.metrics.status,
            plan: f.metrics.plan,
            memory: f.metrics.memoryBytes,
            textures: f._textures.length,
          };
          const old = [...f._textures, ...(f.reconstruction?._textures ?? [])];
          await f.configure({ quality: "auto" });
          f.continuousSampling = true;
          f._stableFrames = 0;
          window.glObserver.phase("production");
          const first = f.metrics.frames;
          for (let i = 0; i < 5; i++) d.widget.render();
          if (!f.ready || !f.receiver)
            throw Error(
              JSON.stringify({
                status: f.metrics.status,
                plan: f.metrics.plan,
                fallback: f.fallbackReason,
              }),
            );
          const plan = f.metrics.plan,
            owned = [
              ...f._textures,
              ...(f.reconstruction?._textures ?? []),
              f.receiver.position,
              f.receiver.normal,
              f.receiver.manager.getDepthStencilTexture(),
            ].filter(Boolean);
          const bytes = owned.reduce((a, t) => a + t.sizeInBytes, 0),
            changes = f.metrics.planChanges;
          const history = f.reconstruction.frames;
          d.widget.render();
          d.widget.render();
          return {
            drawingBuffer: [s.drawingBufferWidth, s.drawingBufferHeight],
            fixed,
            ready: f.ready,
            actualFG: f.metrics.frames - first,
            history,
            plan,
            bytes,
            total: bytes + f.metrics.snapshotBytes,
            stablePlanning: f.metrics.planChanges === changes,
            oldDestroyed: old.every((t) => t.isDestroyed()),
            snapshotBytes: f.metrics.snapshotBytes,
            metrics: { ...f.metrics, completedTimings: undefined },
            readbacks: window.glObserver.snapshot(),
          };
        },
        { width, height },
      );
      row.scene = scene;
      report.rows.push(row);
      assert.deepEqual(row.drawingBuffer, [width, height]);
      assert(
        row.ready &&
          row.actualFG === 7 &&
          row.history >= 1 &&
          row.stablePlanning &&
          row.oldDestroyed,
      );
      assert.equal(row.bytes, row.plan.bytes);
      assert.equal(row.total, row.metrics.totalAdditionalBytes);
      assert(
        row.total <= 64 * 1048576 &&
          row.plan.slots + row.plan.geometrySlots <= 16 * 1048576,
      );
      if (width > 1280) {
        assert(!row.fixed.ready);
        assert.equal(row.fixed.memory, 0);
        assert.equal(row.fixed.textures, 0);
      }
      assert(
        row.readbacks.every(
          (x) =>
            !x.phases.production?.readPixels &&
            !x.phases.production?.finish &&
            !x.phases.production?.getBufferSubData &&
            !x.phases.production?.blockingClientWaitSync &&
            !x.errors.length &&
            !x.feedback.length,
        ),
      );
      console.log(
        JSON.stringify({
          scene,
          buffer: row.drawingBuffer,
          receiver: [row.plan.width, row.plan.height],
          bytes: row.total,
          ready: row.ready,
          history: row.history,
        }),
      );
      if (width === 1920 || width === 2560)
        await p.screenshot({
          path: out + "/auto-" + scene + "-" + width + ".png",
        });
    }
    for (const frozen of [true, false]) {
      const row = await p.evaluate(async (frozen) => {
        const d = earthLab,
          f = d.scene.lumen.finalGather;
        f.freezeSampling = false;
        f.continuousSampling = true;
        f.maxMemoryBytes = 64 * 1048576;
        d.widget.render();
        const old = [...f._textures, ...f.reconstruction._textures],
          beforeSize = [f.resultSize.x, f.resultSize.y];
        f.continuousSampling = false;
        f._stableFrames = 32;
        f.freezeSampling = frozen;
        f.maxMemoryBytes = 40 * 1048576;
        d.scene.requestRender();
        d.widget.render();
        const result = {
          frozen,
          ready: f.ready,
          beforeSize,
          size: [f.resultSize.x, f.resultSize.y],
          bytes: f.metrics.totalAdditionalBytes,
          history: f.reconstruction.frames,
          oldDestroyed: old.every((t) => t.isDestroyed()),
        };
        await f.configure({ lazyFallback: false });
        const eager = f.lazyFallback;
        await f.configure({ lazyFallback: true });
        result.lazyRestored = eager === false && f.lazyFallback === true;
        f.freezeSampling = false;
        f.continuousSampling = true;
        f.maxMemoryBytes = 64 * 1048576;
        return result;
      }, frozen);
      report.rows.push({
        scene,
        contract: "shrink cached/frozen budget",
        ...row,
      });
      assert(
        row.ready &&
          row.bytes <= 40 * 1048576 &&
          row.history === 1 &&
          row.oldDestroyed &&
          row.lazyRestored,
      );
      assert.notDeepEqual(row.beforeSize, row.size);
    }
    await p.close();
  }
  // Browser DPR and Cesium scale produce actual buffers; planning never reads CSS dimensions.
  const p = await b.newPage({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 2,
  });
  await p.goto("http://localhost:8090/demo/globe.html");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  for (const scale of [1, 0.75, 1]) {
    const row = await p.evaluate(async (scale) => {
      const d = earthLab,
        f = d.scene.lumen.finalGather;
      d.camera("boxFoot");
      d.widget.useBrowserRecommendedResolution = false;
      d.widget.resolutionScale = scale;
      await f.configure({
        mode: "fg",
        quality: "auto",
        sampling: "reconstructed",
        model: d.model,
      });
      await d.world.completed;
      d.widget.useDefaultRenderLoop = false;
      d.widget.resize();
      d.widget.render();
      return {
        scale,
        dpr: devicePixelRatio,
        buffer: [d.scene.drawingBufferWidth, d.scene.drawingBufferHeight],
        ready: f.ready,
        plan: f.metrics.plan,
        total: f.metrics.totalAdditionalBytes,
        history: f.reconstruction?.frames,
      };
    }, scale);
    report.rows.push({ scene: "DPR", ...row });
    assert.deepEqual(row.buffer, [
      Math.floor(960 * 2 * scale),
      Math.floor(600 * 2 * scale),
    ]);
    assert(row.ready && row.total <= 64 * 1048576);
    assert(row.history <= 2);
  }
  await p.close();
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(out + "/desktop.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    error: report.error,
  }),
);
