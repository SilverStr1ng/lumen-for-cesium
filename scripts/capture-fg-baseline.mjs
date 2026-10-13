import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
const out = "reports/fg-reconstruction-showcase-v6/before";
await mkdir(out + "/images", { recursive: true });
const prior = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/before/diagnostics.json",
    "utf8",
  ),
);
const report = {
  version: sourceVersion([
    "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
  ]),
  scope:
    "fixed R6 directions, localization bookmarks; unknown user free camera not reproduced",
  cases: [],
  errors: [],
};
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=high",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.evaluate(async (saved) => {
    await earthLab.restoreView(saved);
    await earthLab.scene.lumen.finalGather.configure({
      mode: "fg",
      quality: "high",
      model: earthLab.model,
    });
    window.diag = await import("./receiver-diagnostics.js");
  }, prior.settings);
  report.environment = await environment(p, b);
  await p.addStyleTag({
    content: "aside,footer,.cesium-widget-credits{display:none!important}",
  });
  for (const camera of ["boxFoot", "pillarFoot", "ceiling"]) {
    await p.evaluate((camera) => {
      const f = earthLab.scene.lumen.finalGather;
      f.freezeSampling = false;
      earthLab.camera(camera);
      earthLab.scene.lumen.debugMode = 0;
      earthLab.widget.render();
      f.freezeSampling = true;
    }, camera);
    const data = await p.evaluate(() => {
      const d = earthLab,
        f = d.scene.lumen.finalGather,
        [w, h] = f.metrics.resolution,
        [rw, rh] = f.metrics.receiverResolution;
      return {
        settings: d.saveView(),
        raw: Array.from(
          d.world._read(f.ping[(f.samples / 4 - 1) % 2].framebuffer, w, h),
        ),
        P: Array.from(d.world._read(f.receiver.framebuffer, rw, rh, 0)),
        N: Array.from(d.world._read(f.receiver.framebuffer, rw, rh, 1)),
        mask: Array.from(
          d.world._read(
            f.neighborhood.framebuffer,
            w,
            h,
            0,
            Cesium.PixelDatatype.UNSIGNED_BYTE,
          ),
        ),
        metrics: {
          ...f.metrics,
          stages: undefined,
          completedTimings: undefined,
        },
      };
    });
    // saveView is async; collect it explicitly, never serialize a Promise.
    data.settings = await p.evaluate(() => earthLab.saveView());
    const components = {},
      samplingFrame = data.metrics.frames;
    for (const [name, mode] of [
      ["final", 0],
      ["DDGI-E", 18],
      ["raw-E", 13],
      ["reconstructed-E", 14],
      ["weight", 15],
      ["neighborhood", 16],
      ["fallback-reason", 17],
      ["E-used", 4],
      ["direct", 1],
      ["shadow", 6],
    ]) {
      if (mode === 18) {
        await p.evaluate(() => {
          earthLab.scene.lumen.finalGather._compositeEnabled = false;
        });
      }
      const arr = await p.evaluate(
        (mode) =>
          Array.from(diag.linearFrame(earthLab, mode === 18 ? 4 : mode)),
        mode,
      );
      await p.evaluate(() => {
        earthLab.scene.lumen.finalGather._compositeEnabled = true;
      });
      components[name] = arr;
      await p.screenshot({
        path: out + "/images/" + camera + "-" + name + ".png",
      });
    }
    const last = await p.evaluate(
      () => earthLab.scene.lumen.finalGather.metrics.frames,
    );
    assert.equal(
      last,
      samplingFrame,
      "components must retain the same FG sample result",
    );
    const payload = { ...data, components };
    await writeFile(
      out + "/" + camera + ".json.deflate",
      deflateSync(Buffer.from(JSON.stringify(payload))),
    );
    const valid = data.raw.filter(
      (_, i) => i % 4 === 3 && data.P[i] > 0.5,
    ).length;
    report.cases.push({
      camera,
      settings: data.settings,
      metrics: data.metrics,
      rawValid: valid,
      payload: camera + ".json.deflate",
      sameSamplingFrame: true,
    });
    console.log("CAPTURE", camera);
  }
  // Resolution/seed ablations retain all component parameters.
  for (const quality of ["fast", "high", "roi"])
    for (const seed of [0, 5, 19]) {
      const r = await p.evaluate(
        async ({ quality, seed }) => {
          const f = earthLab.scene.lumen.finalGather;
          f.freezeSampling = false;
          f.seed = seed;
          await f.configure({ mode: "fg", quality });
          earthLab.camera("boxFoot");
          earthLab.widget.render();
          return diag.receiverSamples(earthLab);
        },
        { quality, seed },
      );
      report.cases.push({ quality, seed, ablation: r });
    }
  assert.deepEqual(report.errors, []);
  report.status = "executed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(out + "/diagnostics.json", JSON.stringify(report, null, 2));
}
