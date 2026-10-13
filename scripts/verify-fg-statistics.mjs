import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = { version: sourceVersion(), errors: [] };
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await page.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await page.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.rows = await page.evaluate(() => {
    const C = Cesium,
      w = earthLab.world;
    earthLab.widget.useDefaultRenderLoop = false;
    const raw = w._texture(2, 2),
      position = w._texture(2, 2),
      normal = w._texture(2, 2),
      mask = w._texture(2, 2);
    const rawFramebuffer = w._framebuffer([raw]);
    const data = new Float32Array(16);
    const fill = (texture, value) => {
      for (let i = 0; i < 4; i++) data.set(value, i * 4);
      texture.copyFrom({
        source: { width: 2, height: 2, arrayBufferView: data },
      });
    };
    fill(position, [0, 0, 0, 1]);
    fill(normal, [0, 0, 1, 1]);
    fill(mask, [1, 1, 1, 1]);
    const controller = {
      scene: w.scene,
      offset: C.Cartesian2.ZERO,
      traversalBudget: 256,
      metrics: { draws: 0 },
      _measure: (stage, draw) => draw(),
      _inputUniforms: {
        u_nodes: () => w._nodes,
        u_vertices: () => w._vertices,
        u_nodesCount: () => 0,
      },
    };
    const r = new C.LumenFinalGatherReconstruction(controller);
    r.update(2, 2);
    const state = {
      key: "rare",
      raw,
      receiver: { position, normal },
      neighborhood: mask,
      vp: C.Matrix4.IDENTITY,
      localToEye: C.Matrix4.IDENTITY,
      eye: new C.Cartesian3(0, 0, 1),
      direction: new C.Cartesian3(0, 0, -1),
    };
    const result = (name) => ({
      name,
      E: Array.from(
        w._read(r.history[r._index].framebuffer, 2, 2, 0).slice(0, 4),
      ),
      moments: Array.from(
        w._read(r.history[r._index].framebuffer, 2, 2, 1).slice(0, 4),
      ),
      filtered: Array.from(
        w._read(r.filterTargets[1].framebuffer, 2, 2).slice(0, 4),
      ),
    });
    const rows = [];
    try {
      for (let epoch = 0; epoch < 32; epoch++) {
        fill(raw, [
          epoch === 31 ? 100 : 0,
          epoch === 31 ? 100 : 0,
          epoch === 31 ? 100 : 0,
          1,
        ]);
        r.execute({ ...state, epoch });
      }
      rows.push(result("31 dark plus one rare bright"));
      fill(raw, [-1, -1, -1, -1]);
      r.execute({ ...state, epoch: 32 });
      rows.push(result("Unknown current invalidates pixel"));
      fill(raw, [10000, 10000, 10000, 1]);
      r.execute({ ...state, epoch: 33 });
      rows.push(result("HDR rejected by half storage without altering raw"));
      rows.at(-1).raw = Array.from(w._read(rawFramebuffer, 2, 2).slice(0, 4));
      fill(raw, [0.123456, 1.23456, 23.4567, 1]);
      for (let epoch = 0; epoch < 32; epoch++)
        r.execute({ ...state, key: "quantization", epoch });
      rows.push(result("constant FP16 accuracy"));
      const repeated = r.frames;
      r.execute({ ...state, key: "quantization", epoch: 31 });
      rows.push({
        ...result("repeated direction does not add information"),
        before: repeated,
        after: r.frames,
      });
      fill(raw, [0, 0, 0, 1]);
      r.execute({ ...state, key: "known-black", epoch: 0 });
      rows.push(result("known black valid"));
    } finally {
      r.destroy();
      w._freeTexture(raw, rawFramebuffer);
      for (const t of [position, normal, mask]) w._freeTexture(t);
    }
    return rows;
  });
  const rare = report.rows[0];
  assert(Math.abs(rare.E[0] - 3.125) < 0.01);
  assert.equal(rare.E[3], 32);
  assert(Math.abs(rare.moments[0] - 3.125) < 0.01);
  assert(Math.abs(rare.moments[1] - 312.5) < 0.5);
  assert.equal(report.rows[1].E[3], 0);
  assert.equal(report.rows[2].E[3], 0);
  assert.deepEqual(report.rows[2].raw, [10000, 10000, 10000, 1]);
  report.maxRelativeHalfError = Math.max(
    ...report.rows[3].E.slice(0, 3).map(
      (x, i) =>
        Math.abs(x - [0.123456, 1.23456, 23.4567][i]) /
        [0.123456, 1.23456, 23.4567][i],
    ),
  );
  assert(report.maxRelativeHalfError < 0.005);
  assert.equal(report.rows[4].before, report.rows[4].after);
  assert.deepEqual(report.rows[5].E, [0, 0, 0, 1]);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    "reports/fg-reconstruction-showcase-v6/statistics.json",
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
