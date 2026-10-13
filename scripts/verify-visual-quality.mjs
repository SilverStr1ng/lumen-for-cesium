import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
const label = process.argv[2] ?? "after",
  out = "reports/ddgi-visual-quality-v4/" + label;
await mkdir(out, { recursive: true });
const report = {
  label,
  started: new Date().toISOString(),
  version: sourceVersion([
    "demo/globe.js",
    "lumen/ddgi.js",
    "fixtures/earth-pavilion.gltf",
  ]),
  mode: "synchronous diagnostics, excluded from performance",
  errors: [],
  checks: [],
};
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("BROWSER", m.text().slice(0, 2000));
});
const external = [];
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (
    !["data:", "blob:"].includes(url.protocol) &&
    url.origin !== "http://localhost:8090"
  ) {
    external.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
try {
  await page.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1" +
      (label === "presentation" ? "&preset=presentation" : ""),
  );
  await page.waitForFunction(
    () =>
      window.earthLab?.world?.status === "ready" ||
      window.earthLab?.errors.length,
    null,
    { timeout: 180000 },
  );
  assert.deepEqual(await page.evaluate(() => earthLab.errors), []);
  assert.deepEqual(external, []);
  report.environment = await environment(page, browser);
  await page.evaluate(() => {
    earthLab.camera("boxFoot");
    window.stableFrames = 0;
  });
  await page.waitForFunction(
    () => {
      stableFrames = earthLab.scene.globe.tilesLoaded ? stableFrames + 1 : 0;
      return stableFrames >= 10;
    },
    null,
    { polling: "raf", timeout: 60000 },
  );
  report.settings = await page.evaluate(() => earthLab.saveView());
  if (label !== "before") {
    try {
      const { readFile } = await import("node:fs/promises");
      const prior = JSON.parse(
        await readFile(
          "reports/ddgi-visual-quality-v4/before/diagnostics.json",
          "utf8",
        ),
      );
      await page.evaluate(
        (saved) => earthLab.restoreView(saved),
        prior.settings,
      );
      report.comparisonSettings = await page.evaluate(() =>
        earthLab.saveView(),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  // Preserve exact original projections. These are geometric reproductions; user's free camera is unknown.
  for (const camera of [
    "boxFoot",
    "pillarFoot",
    "wallFoot",
    "ceiling",
    "overview",
    "bounce",
  ]) {
    await page.evaluate((name) => {
      earthLab.camera(name);
      earthLab.scene.lumen.debugMode = 0;
      earthLab.widget.render();
      earthLab.widget.render();
    }, camera);
    await page.screenshot({ path: out + "/" + camera + "-final.png" });
  }
  await page.evaluate(() => earthLab.camera("boxFoot"));
  for (const [name, mode] of [
    ["hdr", 0],
    ["direct", 1],
    ["indirect", 2],
    ["emissive", 3],
    ["E", 4],
    ["coverage", 5],
    ["shadow", 6],
    ["direct-diffuse", 7],
    ["direct-specular", 8],
    ["specular-IBL", 9],
    ["diffuse-IBL", 10],
    ["local-GI-removed", 11],
    ["multiple-scattering", 12],
  ]) {
    report[name] = await page.evaluate((mode) => {
      const d = earthLab,
        w = d.world;
      d.scene.lumen.debugMode = mode;
      d.widget.render();
      d.widget.render();
      const width = d.scene.drawingBufferWidth,
        height = d.scene.drawingBufferHeight,
        hdr = w._read(
          d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
          width,
          height,
        ),
        samples = [];
      for (let y = 0; y < height; y += 8)
        for (let x = 350; x < width; x += 8) {
          const o = (y * width + x) * 4;
          samples.push(...hdr.slice(o, o + 3));
        }
      let minimum = Infinity,
        maximum = -Infinity,
        sum = 0,
        nonfinite = 0;
      for (const v of samples) {
        minimum = Math.min(minimum, v);
        maximum = Math.max(maximum, v);
        sum += v;
        if (!Number.isFinite(v)) nonfinite++;
      }
      return {
        minimum,
        maximum,
        mean: sum / samples.length,
        nonfinite,
        samples,
        scope:
          "Scene linear HDR before postprocess; atmosphere/material stages may follow component selection. Raw E additionally sampled directly from gather.",
      };
    }, mode);
    await page.screenshot({ path: out + "/boxFoot-" + name + ".png" });
  }
  for (const [name, control, shadow] of [
    ["fixed-E", [0, 0, 1, -1], true],
    ["no-crush", [0, 1, -1, -1], true],
    ["no-visibility", [1, 0, -1, -1], true],
    ["no-display-shadow", [0, 0, -1, -1], false],
  ]) {
    await page.evaluate(
      ({ control, shadow }) => {
        earthLab.world.displayGatherControl =
          Cesium.Cartesian4.fromArray(control);
        earthLab.scene.shadowMap.enabled = shadow;
        earthLab.scene.lumen.debugMode = 2;
        earthLab.widget.render();
        earthLab.widget.render();
      },
      { control, shadow },
    );
    await page.screenshot({ path: out + "/boxFoot-" + name + ".png" });
  }
  report.receivers = await page.evaluate(async () => {
    const d = earthLab,
      w = d.world;
    w.displayGatherControl = undefined;
    d.scene.shadowMap.enabled = true;
    d.scene.lumen.debugMode = 0;
    const { ProbeField } = await import("/lumen/ddgi.js"),
      snapshot = w.snapshot(),
      f = new ProbeField(
        snapshot.grid,
        snapshot.positions,
        snapshot.irradiance,
        snapshot.moments,
      );
    const lines = {
      boxFloor: [],
      boxFace: [],
      wallFoot: [],
      pillarFoot: [],
      ceiling: [],
      doorway: [],
    };
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      lines.boxFloor.push({
        position: [-8.95, -3.5 + 4 * t, 0.151],
        normal: [0, 0, 1],
      });
      lines.boxFace.push({
        position: [-8.999, -3 + 2 * t, 0.25],
        normal: [1, 0, 0],
      });
      lines.wallFoot.push({
        position: [-10.69, 4 + 3.5 * t, 0.151],
        normal: [0, 0, 1],
      });
      lines.pillarFoot.push({
        position: [-6.81, -3 + 2 * t, 0.151],
        normal: [0, 0, 1],
      });
      lines.ceiling.push({
        position: [-10 + 7 * t, 7.3, 5.199],
        normal: [0, 0, -1],
      });
      lines.doorway.push({
        position: [-5 + 7 * t, 3.3, 0.151],
        normal: [0, 0, 1],
      });
    }
    const scans = {};
    for (const [name, points] of Object.entries(lines)) {
      const gpu = await w.sample(points);
      scans[name] = points.map((p, i) => ({
        ...p,
        gpu: gpu[i],
        cpu: f.sample(p.position, p.normal, { diagnostics: true }),
      }));
    }
    const interior = [];
    for (let id = 0; id < snapshot.grid.total; id++) {
      const p = Array.from(snapshot.positions.slice(id * 4, id * 4 + 4));
      if (
        p[0] > -12 &&
        p[0] < 12 &&
        p[1] > -9 &&
        p[1] < 9 &&
        p[2] > -1.5 &&
        p[2] < 0
      )
        interior.push({ id, position: p.slice(0, 3), state: p[3] });
    }
    window.r5TemporalPoints = [
      lines.boxFloor[24],
      lines.boxFace[24],
      lines.wallFoot[24],
      lines.pillarFoot[24],
      lines.ceiling[24],
      lines.doorway[24],
    ];
    return {
      scans,
      foundationInterior: interior,
      active: Array.from(snapshot.positions).filter(
        (v, i) => i % 4 === 3 && v >= 0.5,
      ).length,
      grid: snapshot.grid,
    };
  });
  report.static60 = await page.evaluate(async () => {
    const result = [];
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(requestAnimationFrame);
      result.push({
        frame,
        time: performance.now(),
        revision: earthLab.world.publishedRevision,
        samples: await earthLab.world.sample(r5TemporalPoints),
      });
    }
    return result;
  });
  report.finalSettings = await page.evaluate(() => earthLab.saveView());
  report.world = await page.evaluate(() => ({
    metrics: earthLab.world.metrics,
    errors: earthLab.errors,
    memoryBytes: earthLab.world.memoryBytes,
  }));
  report.checks.push({
    name: "finite raw linear samples",
    passed: Object.values(report.receivers.scans).every((line) =>
      line.every((p) => p.gpu.irradiance.every(Number.isFinite)),
    ),
  });
  if (label !== "before")
    report.checks.push({
      name: "foundation interior contains no active probes",
      passed: report.receivers.foundationInterior.every((p) => p.state < 0.5),
    });
  report.status =
    report.checks.every((c) => c.passed) && report.errors.length === 0
      ? "passed"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.errors.push(e.stack ?? String(e));
  process.exitCode = 1;
} finally {
  await writeFile(out + "/diagnostics.json", JSON.stringify(report));
  await browser.close();
}
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks,
    errors: report.errors,
    active: report.receivers?.active,
    interior: report.receivers?.foundationInterior.length,
  }),
);
