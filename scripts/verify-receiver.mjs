import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
  environment,
} from "./browser-tools.mjs";
const out = "reports/receiver-final-gather-v5",
  report = {
    version: sourceVersion([
      "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
      "cesium-1.146/packages/engine/Source/Scene/LumenReceiverPass.js",
      "cesium-1.146/packages/engine/Source/Scene/Scene.js",
      "cesium-1.146/packages/engine/Source/Scene/Model/LightingPipelineStage.js",
      "cesium-1.146/packages/engine/Source/Shaders/Model/LightingStageFS.glsl",
      "demo/globe.js",
    ]),
    checks: [],
    errors: [],
    started: new Date().toISOString(),
  };
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => report.errors.push(String(e)));
await page.addInitScript(installGlObserver);
async function check(name, fn) {
  try {
    const evidence = await fn();
    report.checks.push({ name, status: "passed", evidence });
    console.log("PASS", name);
  } catch (e) {
    report.checks.push({ name, status: "failed", error: String(e) });
    console.error("FAIL", name, e);
  }
}
try {
  await page.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=roi",
  );
  await page.waitForFunction(() => earthLab.world?.ready, null, {
    timeout: 180000,
  });
  await page.evaluate(async () => {
    await earthLab.world.completed;
    earthLab.camera("boxFoot");
    window.diag = await import("./receiver-diagnostics.js");
  });
  await page.waitForTimeout(200);
  report.environment = await environment(page, browser);
  await check(
    "full-resolution ROI production equals fixed point FG",
    async () => {
      const result = await page.evaluate(async () => {
        glObserver.phase("diagnostic");
        earthLab.widget.render();
        const d = diag.receiverSamples(earthLab),
          fg = earthLab.scene.lumen.finalGather,
          q = await earthLab.world.sampleFinalGather(
            d.points.map((p) => ({ position: p.position, normal: p.normal })),
            {
              samples: fg.samples,
              seed: fg.seed,
              snapshot: earthLab.world.finalGatherSnapshot,
              budget: fg.traversalBudget,
            },
          );
        let maxError = 0;
        for (let i = 0; i < q.length; i++)
          for (let c = 0; c < 3; c++)
            maxError = Math.max(
              maxError,
              Math.abs(q[i].irradiance[c] - d.points[i].E[c]),
            );
        return {
          ...d,
          maxError,
          metrics: { ...fg.metrics, stages: undefined },
          queries: q,
        };
      });
      assert(result.points.length > 10);
      assert.equal(result.queries.length, result.points.length);
      assert(result.queries.every((q) => q.valid && !q.unknown));
      assert.equal(result.unknown, 0);
      assert.equal(result.nonfinite, 0);
      assert(result.maxError < 0.00005);
      return result;
    },
  );
  await check(
    "same-frame E replaces complete DDGI; direct and emitter unchanged",
    async () => {
      const r = await page.evaluate(() => {
        const fg = earthLab.scene.lumen.finalGather;
        const sample = (mode, on) => {
          fg.mode = on ? "fg" : "ddgi";
          const a = diag.linearFrame(earthLab, mode),
            v = [];
          for (let i = 0; i < a.length; i += 4 * 31)
            v.push(a[i], a[i + 1], a[i + 2]);
          return v;
        };
        const diff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
        const E0 = sample(4, false),
          E1 = sample(4, true),
          direct0 = sample(1, false),
          direct1 = sample(1, true),
          em0 = sample(3, false),
          em1 = sample(3, true),
          weights = sample(15, true);
        return {
          EChange: diff(E0, E1),
          directChange: diff(direct0, direct1),
          emissiveChange: diff(em0, em1),
          maxWeight: Math.max(...weights),
          weightedPixels: weights.filter((x) => x > 0.9).length,
        };
      });
      assert(r.EChange > 0.01);
      assert(r.directChange < 0.000001);
      assert(r.emissiveChange < 0.000001);
      assert(r.maxWeight > 0.99);
      return r;
    },
  );
  await check(
    "ordinary/log depth and forced multiframe-frustum receiver ownership",
    async () => {
      const r = await page.evaluate(() => {
        const s = earthLab.scene,
          fg = s.lumen.finalGather,
          records = [];
        fg.mode = "fg";
        for (const log of [false, true]) {
          s.logarithmicDepthBuffer = log;
          s.farToNearRatio = 2;
          s.logarithmicDepthFarToNearRatio = 2;
          earthLab.widget.render();
          earthLab.widget.render();
          const d = diag.receiverSamples(earthLab);
          records.push({
            log,
            frustums: s._view.frustumCommandsList.length,
            valid: d.validReceivers,
            unknown: d.unknown,
            normalError: Math.max(
              ...d.points.map((p) => Math.abs(Math.hypot(...p.normal) - 1)),
            ),
          });
        }
        s.farToNearRatio = 1000;
        s.logarithmicDepthFarToNearRatio = 1e9;
        s.logarithmicDepthBuffer = true;
        return records;
      });
      assert(r.some((x) => x.frustums > 1));
      for (const c of r) {
        assert(c.valid > 0);
        assert.equal(c.unknown, 0);
        assert(c.normalError < 0.00001);
      }
      return r;
    },
  );
  await check("Unknown does not become sky; invalid FG uses DDGI", async () => {
    const r = await page.evaluate(() => {
      const fg = earthLab.scene.lumen.finalGather;
      fg.mode = "ddgi";
      const a = diag.linearFrame(earthLab, 4);
      fg.mode = "fg";
      fg.traversalBudget = 1;
      const b = diag.linearFrame(earthLab, 4),
        d = diag.receiverSamples(earthLab);
      let max = 0;
      for (let i = 0; i < a.length; i++)
        max = Math.max(max, Math.abs(a[i] - b[i]));
      fg.traversalBudget = 256;
      const locations = [];
      let roiMax = 0;
      for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) > 0.005 && locations.length < 5)
          locations.push({
            x: Math.floor(i / 4) % earthLab.scene.drawingBufferWidth,
            y: Math.floor(i / 4 / earthLab.scene.drawingBufferWidth),
            channel: i % 4,
            a: a[i],
            b: b[i],
          });
      }
      for (let y = 272; y < 528; y++)
        for (let x = 512; x < 768; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * 1280 + x) * 4 + c;
            roiMax = Math.max(roiMax, Math.abs(a[i] - b[i]));
          }
      return {
        max,
        roiMax,
        locations,
        unknown: d.unknown,
        valid: d.validReceivers,
      };
    });
    console.log("Unknown evidence", JSON.stringify(r));
    assert(r.unknown > 0);
    assert(r.roiMax < 0.000001);
    return r;
  });
  await check("memory and ray budgets reject atomically", async () => {
    const r = await page.evaluate(() => {
      const fg = earthLab.scene.lumen.finalGather;
      const records = [];
      for (const key of ["maxMemoryBytes", "maxRayInvocations"]) {
        const old = fg[key];
        fg[key] = 1;
        earthLab.widget.render();
        records.push({
          key,
          ready: fg.ready,
          memory: fg.metrics.memoryBytes,
          status: fg.metrics.status,
        });
        fg[key] = old;
      }
      earthLab.widget.render();
      return records;
    });
    for (const c of r) {
      assert.equal(c.ready, false);
      assert.equal(c.memory, 0);
      assert(c.status.includes("budget"));
    }
    return r;
  });
  await check(
    "new revision and material do not reuse old FG input",
    async () => {
      const r = await page.evaluate(async () => {
        const w = earthLab.world,
          fg = earthLab.scene.lumen.finalGather,
          geometry = w._nodes;
        const old = fg.metrics.revision;
        const request = w.solve({
          sunDirection: [-1, 0.2, 0.65],
          materialOverrides: [{ id: 1, baseColorFactor: [0.3, 0.2, 0.1] }],
        });
        earthLab.widget.render();
        const interim = { ready: fg.ready, status: fg.metrics.status };
        await request;
        earthLab.widget.render();
        return {
          old,
          interim,
          input: fg.metrics.revision,
          requested: w.requestedRevision,
          round: fg.metrics.round,
          material: fg.metrics.versions.material,
          geometrySame: w._nodes === geometry,
        };
      });
      assert.equal(r.interim.ready, false);
      assert.equal(r.input, r.requested);
      assert.equal(r.round, 3);
      assert(r.material > 1);
      assert(r.geometrySame);
      return r;
    },
  );
  await check(
    "resize, AA, no history and camera movements retain static BVH",
    async () => {
      await page.setViewportSize({ width: 1056, height: 640 });
      const r = await page.evaluate(async () => {
        earthLab.widget.resize();
        const fg = earthLab.scene.lumen.finalGather,
          w = earthLab.world,
          nodes = w._nodes,
          rev = w.requestedRevision,
          records = [];
        await fg.configure({ quality: "balanced" });
        for (const name of [
          "boxFoot",
          "inside",
          "wallFoot",
          "pillarFoot",
          "overview",
        ]) {
          earthLab.camera(name);
          earthLab.scene.msaaSamples = 4;
          earthLab.widget.render();
          earthLab.widget.render();
          const d = diag.receiverSamples(earthLab);
          records.push({
            name,
            valid: d.validReceivers,
            unknown: d.unknown,
            size: fg.metrics.resolution,
          });
        }
        earthLab.scene.msaaSamples = 1;
        return {
          records,
          staticGeometry: nodes === w._nodes,
          revisionUnchanged: rev === w.requestedRevision,
          history: fg.metrics.history,
        };
      });
      assert(r.staticGeometry && r.revisionUnchanged);
      assert.equal(r.history, false);
      for (const c of r.records) {
        assert(c.valid > 0);
        assert.equal(c.unknown, 0);
        assert.deepEqual(c.size, [528, 320]);
      }
      return r;
    },
  );
  await check(
    "FG off restores raw solver and releases resources over 20 cycles",
    async () => {
      const r = await page.evaluate(async () => {
        const fg = earthLab.scene.lumen.finalGather;
        await fg.configure({ mode: "ddgi" });
        earthLab.widget.render();
        const hash = await diag.rawHash(earthLab),
          initial = glObserver.snapshot()[0].live,
          cycles = [];
        for (let i = 0; i < 20; i++) {
          await fg.configure({ mode: "fg", quality: "fast" });
          earthLab.widget.render();
          await fg.configure({ mode: "ddgi" });
          earthLab.widget.render();
          earthLab.widget.render();
          cycles.push({
            textures: glObserver.snapshot()[0].live.textures,
            framebuffers: glObserver.snapshot()[0].live.framebuffers,
            memory: fg.metrics.memoryBytes,
          });
        }
        return { initial, cycles, hash, after: await diag.rawHash(earthLab) };
      });
      assert.equal(r.hash, r.after);
      for (const c of r.cycles) {
        assert.equal(c.memory, 0);
        assert.equal(c.textures, r.initial.textures);
        assert.equal(c.framebuffers, r.initial.framebuffers);
      }
      return r;
    },
  );
  await check(
    "no production readback, feedback or nested timer queries",
    async () => {
      const r = await page.evaluate(async () => {
        const fg = earthLab.scene.lumen.finalGather;
        await fg.configure({ mode: "fg", quality: "fast" });
        earthLab.scene.lumen.debugMode = 0;
        glObserver.phase("production");
        for (let i = 0; i < 6; i++) earthLab.widget.render();
        return glObserver.snapshot();
      });
      for (const c of r) {
        assert.deepEqual(c.feedback, []);
        assert.deepEqual(c.errors, []);
        for (const key of [
          "readPixels",
          "getBufferSubData",
          "finish",
          "waitSync",
          "blockingClientWaitSync",
          "queryCollisions",
        ])
          assert.equal(c.phases.production[key] ?? 0, 0);
      }
      return r;
    },
  );
  await check(
    "static requestRenderMode sleeps; camera requests FG frame",
    async () => {
      await page.waitForFunction(() => earthLab.scene.globe.tilesLoaded);
      await page.evaluate(() => {
        earthLab.scene.requestRenderMode = true;
        earthLab.scene.maximumRenderTimeChange = Infinity;
      });
      await page.waitForTimeout(400);
      const before = await page.evaluate(
        () => earthLab.scene.lumen.finalGather.metrics.frames,
      );
      await page.waitForTimeout(250);
      const stopped = await page.evaluate(
        () => earthLab.scene.lumen.finalGather.metrics.frames,
      );
      await page.evaluate(() => earthLab.camera("pillarFoot"));
      await page.waitForTimeout(150);
      const changed = await page.evaluate(
        () => earthLab.scene.lumen.finalGather.metrics.frames,
      );
      assert.equal(before, stopped);
      assert(changed > stopped);
      return { before, stopped, changed };
    },
  );
  await check(
    "saved view restores FG mode and settings; reload and destroy release",
    async () => {
      const r = await page.evaluate(async () => {
        const saved = await earthLab.saveView(),
          old = earthLab.world,
          fg = earthLab.scene.lumen.finalGather;
        await fg.configure({ mode: "ddgi" });
        await earthLab.restoreView(saved);
        earthLab.widget.render();
        const restored = {
          mode: fg.mode,
          quality: fg.quality,
          ready: fg.ready,
        };
        await earthLab.reload();
        while (!earthLab.world?.ready || earthLab.world === old) {
          await new Promise(requestAnimationFrame);
        }
        await earthLab.world.completed;
        earthLab.camera("boxFoot");
        earthLab.widget.render();
        const active = fg.ready;
        const current = earthLab.world;
        earthLab.widget.destroy();
        return {
          restored,
          active,
          oldDestroyed: old.isDestroyed(),
          ownedTextures: fg._textures.length,
          ownedFramebuffers: fg._framebuffers.length,
          worldTextures: current._textures.length,
          live: glObserver.snapshot()[0].live,
        };
      });
      console.log("destroy evidence", JSON.stringify(r));
      assert(r.restored.ready && r.active && r.oldDestroyed);
      assert.equal(r.restored.mode, "fg");
      assert.equal(r.ownedTextures, 0);
      assert.equal(r.ownedFramebuffers, 0);
      assert.equal(r.worldTextures, 0);
      assert.equal(r.live.queries, 0);
      return r;
    },
  );
} catch (e) {
  report.errors.push(String(e));
} finally {
  await browser.close();
  report.finished = new Date().toISOString();
  report.status =
    report.errors.length === 0 &&
    report.checks.every((x) => x.status === "passed")
      ? "passed"
      : "failed";
  await writeFile(
    out + "/receiver-regression.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(report.status);
if (report.status !== "passed") process.exitCode = 1;
