import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out = "reports/fg-reconstruction-showcase-v6/gallery";
await mkdir(out, { recursive: true });
const report = { version: sourceVersion(), rows: [], errors: [], requests: [] };
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
p.on("requestfailed", (r) =>
  report.requests.push({ url: r.url(), failure: r.failure() }),
);
try {
  await p.goto(
    "http://localhost:8090/demo/gallery.html?diagnostic=1&fg=fg&fgQuality=high&fgSampling=reconstructed",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.addStyleTag({
    content:
      "aside,footer,.cesium-credit-logoContainer,.cesium-credit-textContainer{display:none!important}",
  });
  for (const view of [
    "overview",
    "courtyard",
    "skylight",
    "doorway",
    "emitter",
  ]) {
    const info = await p.evaluate(async (view) => {
      const d = earthLab,
        f = d.scene.lumen.finalGather;
      d.world.setDisplayTransition(0);
      d.widget.useDefaultRenderLoop = false;
      d.camera(view);
      f.reconstruction?.invalidate("gallery capture");
      f._historyWorld = undefined;
      f._stableFrames = 0;
      f._sampleEpoch = 0;
      for (let i = 0; i < 32; i++) d.widget.render();
      const r = f.reconstruction;
      if (!r || !f.ready) throw Error(f.metrics.status);
      const a = d.world._read(
        r.history[r._index].framebuffer,
        r.width,
        r.height,
        0,
      );
      let valid = 0,
        count = 0,
        max = 0,
        peak = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i + 3] > 0.5) {
          valid++;
          count += a[i + 3];
          max = Math.max(max, a[i + 3]);
          peak = Math.max(peak, a[i], a[i + 1], a[i + 2]);
        }
      return {
        settings: await d.saveView(),
        metrics: structuredClone(f.metrics),
        valid,
        lengthMean: count / Math.max(valid, 1),
        lengthMax: max,
        peakE: peak,
        geometry: d.world.packet.geometry,
        grid: d.world.packet.grid,
        bvh: d.world.packet.bvh,
        worldMemory: d.world.metrics.memory,
      };
    }, view);
    report.rows.push({ view, ...info });
    await p.screenshot({ path: out + "/" + view + "-reconstructed-32.png" });
    for (const [mode, label] of [
      [11, "without-local"],
      [13, "raw"],
      [15, "weight"],
    ]) {
      await p.evaluate((mode) => {
        const f = earthLab.scene.lumen.finalGather;
        f.freezeSampling = true;
        earthLab.scene.lumen.debugMode = mode;
        earthLab.widget.render();
      }, mode);
      await p.screenshot({ path: out + "/" + view + "-" + label + ".png" });
    }
    await p.evaluate(() => {
      earthLab.scene.lumen.finalGather._compositeEnabled = false;
      earthLab.scene.lumen.debugMode = 0;
      earthLab.widget.render();
    });
    await p.screenshot({ path: out + "/" + view + "-ddgi.png" });
    await p.evaluate(() => {
      const f = earthLab.scene.lumen.finalGather;
      f._compositeEnabled = true;
      f.freezeSampling = false;
      earthLab.scene.lumen.debugMode = 0;
    });
  }
  // A source preset and emissive material change use exactly the display/GI asset transaction.
  await p.evaluate(() => {
    earthLab.widget.useDefaultRenderLoop = true;
    document.getElementById("galleryLight").value = "night";
    document.getElementById("galleryLight").dispatchEvent(new Event("change"));
    earthLab.camera("emitter");
  });
  await p.waitForFunction(
    () =>
      earthLab.world?.status === "ready" &&
      earthLab.world.options.sunRadiance.every((x) => x === 0),
    null,
    { timeout: 180000 },
  );
  await p.evaluate(() => {
    const f = earthLab.scene.lumen.finalGather;
    earthLab.widget.useDefaultRenderLoop = false;
    f._historyWorld = undefined;
    f._stableFrames = 0;
    for (let i = 0; i < 32; i++) earthLab.widget.render();
  });
  await p.screenshot({ path: out + "/emitter-night-on.png" });
  report.nightOn = await p.evaluate(() => earthLab.saveView());
  const previous = await p.evaluate(() => earthLab.world.requestedRevision);
  await p.evaluate(() => {
    earthLab.widget.useDefaultRenderLoop = true;
    document.getElementById("emitter").checked = false;
    document.getElementById("emitter").dispatchEvent(new Event("change"));
  });
  await p.waitForFunction(
    () =>
      earthLab.world?.status === "ready" &&
      earthLab.metadata.name === "earth-gi-gallery-off",
    null,
    { timeout: 180000 },
  );
  await p.evaluate(() => {
    const f = earthLab.scene.lumen.finalGather;
    earthLab.widget.useDefaultRenderLoop = false;
    f._historyWorld = undefined;
    f._stableFrames = 0;
    for (let i = 0; i < 32; i++) earthLab.widget.render();
  });
  await p.screenshot({ path: out + "/emitter-night-off.png" });
  report.nightOff = await p.evaluate(() => earthLab.saveView());
  report.errors.push(...(await p.evaluate(() => earthLab.errors)));
  assert(
    report.rows.every(
      (x) =>
        x.valid > 0 && x.lengthMax >= 31 && x.metrics.productionReadbacks === 0,
    ),
  );
  assert(
    report.rows.every((x) => x.metrics.totalAdditionalBytes <= 64 * 1048576),
  );
  assert(report.rows[0].grid.total <= 4096);
  assert.equal(report.nightOn.exposure, report.nightOff.exposure);
  assert.equal(report.nightOff.galleryEmitter, false);
  assert.equal(report.nightOff.assetName, "earth-gi-gallery-off");
  await p.goto("http://localhost:8090/demo/gallery.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.default = await p.evaluate(() => ({
    mode: earthLab.scene.lumen.finalGather.mode,
    modelGeometryBytes: earthLab.model.geometryByteLength,
    modelTextureBytes: earthLab.model.texturesByteLength,
    imageryLayers: earthLab.scene.imageryLayers.length,
    asset: earthLab.world.options.url,
    terrain: earthLab.scene.terrainProvider.constructor.name,
  }));
  assert.equal(report.default.mode, "ddgi");
  await p.screenshot({ path: out + "/home.png" });
  await p.evaluate(() => earthLab.camera("earth"));
  await p.waitForFunction(() => earthLab.scene.globe.tilesLoaded, null, {
    timeout: 30000,
  });
  await p.screenshot({ path: out + "/earth.png" });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requests, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(out + "/data.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.map((x) => ({
      view: x.view,
      probes: x.grid?.total,
      valid: x.valid,
      lengthMean: x.lengthMean,
      totalBytes: x.metrics?.totalAdditionalBytes,
    })),
    errors: report.errors,
    error: report.error,
  }),
);
