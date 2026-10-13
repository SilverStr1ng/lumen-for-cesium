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
    // Receiver world positions, rather than decoded depth, guide this history.
    d.camera("boxFoot");
    const position = () => {
      const a = d.world._read(
        f.receiver.framebuffer,
        f.receiver.position.width,
        f.receiver.position.height,
        0,
      );
      return Array.from(a);
    };
    const originalRatio = d.scene.farToNearRatio,
      originalLogRatio = d.scene.logarithmicDepthFarToNearRatio;
    for (const logarithmic of [false, true]) {
      d.scene.logarithmicDepthBuffer = logarithmic;
      d.scene.farToNearRatio = 10;
      d.scene.logarithmicDepthFarToNearRatio = 10;
      f.reconstruction.invalidate("depth contract test");
      f._stableFrames = 0;
      for (let i = 0; i < 4; i++) d.widget.render();
      const before = position(),
        count = f.metrics.frames;
      d.widget.render();
      const after = position();
      let maxPositionDelta = 0,
        maxLocalMagnitude = 0,
        owned = 0;
      for (let i = 0; i < after.length; i += 4)
        if (before[i + 3] > 0 && after[i + 3] > 0) {
          owned++;
          for (let c = 0; c < 3; c++) {
            maxPositionDelta = Math.max(
              maxPositionDelta,
              Math.abs(before[i + c] - after[i + c]),
            );
            maxLocalMagnitude = Math.max(
              maxLocalMagnitude,
              Math.abs(after[i + c]),
            );
          }
        }
      rows.push({
        name: logarithmic
          ? "log depth multifrustum"
          : "ordinary depth multifrustum",
        ...snapshot(),
        owned,
        maxPositionDelta,
        maxLocalMagnitude,
        splits: [...d.scene.frameState.frustumSplits],
        sampledOnce: f.metrics.frames === count + 1,
      });
    }
    d.scene.farToNearRatio = originalRatio;
    d.scene.logarithmicDepthFarToNearRatio = originalLogRatio;
    d.scene.camera.frustum = new C.OrthographicFrustum({
      width: 6,
      aspectRatio: 1.6,
      near: 0.1,
      far: 100000,
    });
    f.reconstruction.invalidate("orthographic test");
    f._stableFrames = 0;
    for (let i = 0; i < 32; i++) d.widget.render();
    const orthoFrames = f.metrics.frames;
    d.widget.render();
    const orthoPaused = f.metrics.frames === orthoFrames;
    d.scene.camera.frustum.width = 6.2;
    d.widget.render();
    rows.push({
      name: "orthographic width change",
      paused: orthoPaused,
      sampled: f.metrics.frames > orthoFrames,
      ...snapshot(),
    });
    return rows;
  });
  for (const r of report.rows) assert.equal(r.nonfinite, 0);
  assert(report.rows.find((x) => x.frame === 32).max >= 31);
  assert(report.rows.find((x) => x.name === "static stopped").sameSampling);
  assert(report.rows.find((x) => x.name === "projection change").sampled);
  assert(report.rows.find((x) => x.name === "camera reproject").max >= 30);
  assert(report.rows.find((x) => x.name === "camera cut").max <= 1.01);
  assert(report.rows.find((x) => x.name === "new revision").max <= 2.01);
  for (const row of report.rows.filter((x) =>
    x.name?.endsWith("depth multifrustum"),
  )) {
    assert(row.owned > 1000);
    assert(row.splits.length >= 3, "must actually exercise multiple frustums");
    assert(row.sampledOnce, "one FG execution per Scene lifecycle");
    assert(row.maxPositionDelta < 0.005);
    assert(
      row.maxLocalMagnitude < 1000,
      "history guides stay in local coordinates",
    );
    assert(row.max >= 4);
  }
  const ortho = report.rows.find((x) => x.name === "orthographic width change");
  assert(ortho.paused && ortho.sampled && ortho.valid > 1000);
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
