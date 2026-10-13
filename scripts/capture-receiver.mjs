import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const out = "reports/receiver-final-gather-v5",
  prior = JSON.parse(
    await readFile(
      "reports/ddgi-visual-quality-v4/before/diagnostics.json",
      "utf8",
    ),
  ),
  ref = JSON.parse(await readFile(out + "/abcd.json", "utf8")).cases.find(
    (x) => !x.heldOut && x.k === 3,
  );
const report = {
  version: sourceVersion([
    "demo/globe.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenReceiverPass.js",
    "cesium-1.146/packages/engine/Source/Scene/Model/LightingPipelineStage.js",
    "cesium-1.146/packages/engine/Source/Shaders/Model/LightingStageFS.glsl",
  ]),
  started: new Date().toISOString(),
  scope: "explicit synchronous image diagnostics; excluded from performance",
  errors: [],
  images: [],
  productionPoints: [],
  qualityModes: [],
  sequence: [],
};
await mkdir(out + "/images", { recursive: true });
await mkdir(out + "/sequence", { recursive: true });
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.evaluate(async (saved) => {
    await earthLab.restoreView(saved);
    window.diag = await import("./receiver-diagnostics.js");
  }, prior.settings);
  await p.waitForFunction(() => earthLab.scene.globe.tilesLoaded);
  report.environment = await environment(p, b);
  await p.addStyleTag({
    content: "aside,footer,.cesium-widget-credits {display:none !important}",
  });
  for (const mode of ["ddgi", "fg"]) {
    await p.evaluate(async (mode) => {
      await earthLab.scene.lumen.finalGather.configure({
        mode,
        quality: "high",
        model: earthLab.model,
      });
      earthLab.scene.lumen.debugMode = 0;
    }, mode);
    for (const camera of [
      "boxFoot",
      "pillarFoot",
      "wallFoot",
      "ceiling",
      "overview",
      "bounce",
    ]) {
      await p.evaluate((name) => {
        earthLab.camera(name);
        earthLab.widget.render();
        earthLab.widget.render();
      }, camera);
      const name = camera + "-" + mode + ".png";
      await p.screenshot({ path: out + "/images/" + name });
      report.images.push({
        name,
        camera,
        mode,
        settings: await p.evaluate(() => earthLab.saveView()),
      });
    }
  }
  const geometry = await loadGeometry(
      "http://localhost:8090/fixtures/earth-pavilion.gltf",
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    ),
    bvh = new BVH(geometry, { strategy: "sah" });
  // Actual screen receiver points, including off-axis perspective triangles; no screen color feeds FG.
  for (const quality of ["fast", "balanced", "high", "roi"]) {
    await p.evaluate(async (quality) => {
      await earthLab.scene.lumen.finalGather.configure({ mode: "fg", quality });
    }, quality);
    for (const camera of ["boxFoot", "pillarFoot", "wallFoot"]) {
      const data = await p.evaluate(async (camera) => {
        earthLab.camera(camera);
        earthLab.widget.render();
        const r = diag.receiverSamples(earthLab),
          A = await earthLab.world.sample(
            r.points.map((p) => ({ position: p.position, normal: p.normal })),
          );
        return {
          ...r,
          A,
          lighting: earthLab.lighting,
          metrics: {
            ...earthLab.scene.lumen.finalGather.metrics,
            stages: undefined,
          },
        };
      }, camera);
      const points = data.points.map((point, i) => ({
        ...point,
        A: data.A[i],
        D: referenceIrradiance(
          bvh,
          point.position,
          point.normal,
          { ...data.lighting, bounces: 3 },
          4096,
          42110 + i * 997,
        ),
      }));
      const rmse = (estimate) => {
        const differences = points.flatMap((p) =>
          p.D.irradiance.map(
            (v, c) => (estimate === "A" ? p.A.irradiance[c] : p.E[c]) - v,
          ),
        );
        return Math.sqrt(
          differences.reduce((s, v) => s + v * v, 0) / differences.length,
        );
      };
      report.productionPoints.push({
        quality,
        camera,
        ...data,
        points,
        rmseA: rmse("A"),
        rmseRawFG: rmse("FG"),
      });
      console.log("SCREEN", quality, camera, rmse("A"), rmse("FG"));
    }
  }
  // Low-sample estimator on all original six lines, evaluated against the same independent D.
  const points = Object.values(ref.lines)
    .flat()
    .map((p) => ({ position: p.position, normal: p.normal }));
  for (const samples of [16, 32, 64, 256]) {
    const data = await p.evaluate(
        ({ points, samples }) =>
          Promise.all(
            [0, 5, 19].map((seed) =>
              earthLab.world.sampleFinalGather(points, {
                samples,
                seed,
                budget: 256,
              }),
            ),
          ),
        { points, samples },
      ),
      mode = { samples, seeds: [0, 5, 19], lines: {}, metrics: {} };
    let cursor = 0;
    for (const [name, line] of Object.entries(ref.lines)) {
      mode.lines[name] = line.map((point, index) => {
        const i = cursor++;
        return { ...point, D: point.D, estimates: data.map((s) => s[i]) };
      });
      for (const seed of [0, 5, 19]) {
        const si = mode.seeds.indexOf(seed),
          diff = ref.metrics.C[name].scoredIndices.flatMap((i) =>
            line[i].D.irradiance.map(
              (v, c) => mode.lines[name][i].estimates[si].irradiance[c] - v,
            ),
          );
        (mode.metrics[seed] ??= {})[name] = {
          rmse: Math.sqrt(diff.reduce((s, v) => s + v * v, 0) / diff.length),
          scoredIndices: ref.metrics.C[name].scoredIndices,
        };
      }
    }
    report.qualityModes.push(mode);
    console.log("FIXED", samples, JSON.stringify(mode.metrics[0]));
  }
  await p.evaluate(async () => {
    earthLab.camera("boxFoot");
    await earthLab.scene.lumen.finalGather.configure({
      mode: "fg",
      quality: "high",
    });
  });
  for (const [name, mode] of [
    ["E-used", 4],
    ["raw-FG", 13],
    ["filtered-FG", 14],
    ["weight", 15],
  ]) {
    await p.evaluate((mode) => {
      earthLab.scene.lumen.debugMode = mode;
      earthLab.widget.render();
    }, mode);
    await p.screenshot({ path: out + "/images/boxFoot-" + name + ".png" });
  }
  // Deterministic no-history sequence: pan, turn, enter, then light update and stop.
  await p.evaluate(() => {
    earthLab.scene.lumen.debugMode = 0;
    earthLab.camera("boxFoot");
  });
  for (let i = 0; i < 7; i++) {
    const data = await p.evaluate(async (i) => {
      const d = earthLab,
        w = d.world,
        nodes = w._nodes;
      if (i === 1) d.scene.camera.moveRight(0.6);
      if (i === 2) d.scene.camera.lookRight(0.18);
      if (i === 3) d.camera("inside");
      if (i === 4) {
        document.getElementById("sun").value = "140";
        document.getElementById("sun").dispatchEvent(new Event("change"));
      }
      if (i === 5) await w.completed;
      d.widget.render();
      return {
        step: i,
        camera: await d.saveView(),
        input: { ...d.scene.lumen.finalGather.metrics, stages: undefined },
        staticBvh: w._nodes === nodes,
      };
    }, i);
    await p.screenshot({ path: out + "/sequence/" + i + ".png" });
    report.sequence.push(data);
  }
  await p.evaluate(async () => {
    document.getElementById("preset").value = "presentation";
    document.getElementById("preset").dispatchEvent(new Event("change"));
  });
  await p.waitForFunction(
    () =>
      earthLab.preset === "presentation" && earthLab.world?.status === "ready",
    null,
    { timeout: 180000 },
  );
  await p.evaluate(async () => {
    await earthLab.world.completed;
    await earthLab.scene.lumen.finalGather.configure({
      mode: "fg",
      quality: "high",
      model: earthLab.model,
    });
  });
  for (const camera of ["boxFoot", "pillarFoot", "materials", "overview"]) {
    await p.evaluate((name) => {
      earthLab.camera(name);
      earthLab.widget.render();
      earthLab.widget.render();
    }, camera);
    await p.screenshot({
      path: out + "/images/presentation-" + camera + ".png",
    });
    report.images.push({
      name: "presentation-" + camera + ".png",
      preset: "presentation",
      settings: await p.evaluate(() => earthLab.saveView()),
    });
  }
  assert(
    report.productionPoints.every((x) => x.unknown === 0 && x.nonfinite === 0),
  );
  assert.deepEqual(report.errors, []);
  report.status = "executed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  report.finished = new Date().toISOString();
  await writeFile(out + "/images.json", JSON.stringify(report, null, 2));
}
