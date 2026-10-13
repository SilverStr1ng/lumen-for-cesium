import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = { version: sourceVersion(), checks: [], errors: [] },
  b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
p.on("console", (m) => {
  if (m.type() === "error") console.log(m.text().slice(0, 2000));
});
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.rows = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather,
      C = Cesium;
    d.world.setDisplayTransition(0);
    d.camera("boxFoot");
    await f.configure({
      mode: "fg",
      quality: "high",
      sampling: "reconstructed",
      model: d.model,
    });
    await d.world.completed;
    d.widget.useDefaultRenderLoop = false;
    f.reconstruction?.invalidate("capture boundary");
    f._stableFrames = 0;
    f._historyWorld = undefined;
    f._sampleEpoch = 0;
    const snapshot = () => {
        if (!f.ready || !f.reconstruction) throw Error(f.metrics.status);
        const r = f.reconstruction,
          w = r.width,
          h = r.height,
          a = d.world._read(r.history[r._index].framebuffer, w, h, 0),
          m = d.world._read(r.history[r._index].framebuffer, w, h, 1);
        let max = 0,
          valid = 0,
          sum = 0,
          nonfinite = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i + 3] > 0.5) {
            max = Math.max(max, a[i + 3]);
            sum += a[i + 3];
            valid++;
          }
          if (!Number.isFinite(a[i]) || !Number.isFinite(m[i])) nonfinite++;
        }
        return {
          max,
          mean: sum / Math.max(1, valid),
          valid,
          nonfinite,
          passes: r.frames,
          source: f.metrics.revision,
          round: f.metrics.round,
          status: f.metrics.status,
          bytes: f.metrics.totalAdditionalBytes,
        };
      },
      rows = [];
    for (let i = 1; i <= 32; i++) {
      d.widget.render();
      if ([1, 4, 8, 16, 32].includes(i)) rows.push({ frame: i, ...snapshot() });
    }
    const frames = f.metrics.frames;
    d.widget.render();
    rows.push({
      name: "static stopped",
      sameSampling: f.metrics.frames === frames,
      ...snapshot(),
    });
    d.scene.camera.frustum.aspectRatio *= 1.01;
    d.widget.render();
    rows.push({
      name: "projection change",
      sampled: f.metrics.frames > frames,
      ...snapshot(),
    });
    d.scene.camera.moveRight(0.05);
    d.widget.render();
    rows.push({ name: "camera reproject", ...snapshot() });
    d.scene.camera.lookRight(1.6);
    d.widget.render();
    rows.push({ name: "camera cut", ...snapshot() });
    d.widget.useDefaultRenderLoop = true;
    await d.world.solve({ skyRadiance: [0.04, 0.08, 0.1] });
    d.widget.useDefaultRenderLoop = false;
    d.widget.render();
    rows.push({ name: "new revision", ...snapshot() });
    return rows;
  });
  for (const r of report.rows) assert.equal(r.nonfinite, 0);
  assert(report.rows.find((x) => x.frame === 32).max >= 31);
  assert(report.rows.find((x) => x.name === "static stopped").sameSampling);
  assert(report.rows.find((x) => x.name === "projection change").sampled);
  assert(report.rows.find((x) => x.name === "camera reproject").max >= 30);
  assert(report.rows.find((x) => x.name === "camera cut").max <= 1.01);
  assert(report.rows.find((x) => x.name === "new revision").max <= 2.01);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    "reports/fg-reconstruction-showcase-v6/history.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows,
    error: report.error,
  }),
);
