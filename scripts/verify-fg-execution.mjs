import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = {
    version: sourceVersion(["scripts/verify-fg-execution.mjs"]),
    rows: [],
    errors: [],
  },
  b = await launchBrowser();
await mkdir(
  process.env.LUMEN_REPORT_DIRECTORY ?? "reports/fg-runtime-budget-v7",
  { recursive: true },
);
try {
  for (const query of ["", "?heldOut=1", "?scene=gallery"]) {
    const p = await b.newPage({ viewport: { width: 640, height: 400 } });
    p.on("pageerror", (e) => report.errors.push(String(e)));
    await p.goto(
      "http://localhost:8090/demo/" +
        (query.includes("gallery") ? "gallery.html" : "globe.html") +
        query,
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    const rows = await p.evaluate(async () => {
      const d = earthLab,
        C = Cesium,
        f = d.scene.lumen.finalGather,
        w = d.world;
      d.camera(d.metadata.name.includes("gallery") ? "courtyard" : "boxFoot");
      await f.configure({
        mode: "fg",
        quality: "high",
        sampling: "reconstructed",
        model: d.model,
      });
      await w.completed;
      d.widget.useDefaultRenderLoop = false;
      d.scene.requestRenderMode = false;
      const rows = [];
      for (const seed of [0, 5, 19])
        for (const epoch of [0, 1, 31]) {
          let baseline;
          for (const execution of ["split", "fused4", "fused8"])
            for (const rayLayout of execution === "split"
              ? ["interleaved", "planar"]
              : ["interleaved"])
              for (const rayOrder of ["original", "azimuth"])
                for (const reconstruction of [false, true]) {
                  await f.configure({
                    execution,
                    rayLayout,
                    rayOrder,
                    reconstruction,
                    seed,
                    sequenceEpoch: epoch,
                  });
                  d.widget.render();
                  if (!f.ready) throw Error(f.metrics.status);
                  const data = w._read(
                    f.ping[f.ping.findIndex((x) => x.texture === f.texture)]
                      .framebuffer,
                    f.resultSize.x,
                    f.resultSize.y,
                  );
                  if (!baseline) baseline = data;
                  let delta = 0,
                    invalidMismatch = 0,
                    nonfinite = 0,
                    valid = 0;
                  for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] > 0.5) valid++;
                    if (data[i + 3] !== baseline[i + 3]) invalidMismatch++;
                    for (let c = 0; c < 3; c++) {
                      delta = Math.max(
                        delta,
                        Math.abs(data[i + c] - baseline[i + c]),
                      );
                      if (!Number.isFinite(data[i + c])) nonfinite++;
                    }
                  }
                  rows.push({
                    seed,
                    epoch,
                    execution,
                    rayOrder,
                    rayLayout,
                    reconstruction,
                    delta,
                    invalidMismatch,
                    nonfinite,
                    valid,
                    hitAllocated: !!f.hits,
                    bytes: f.metrics.totalAdditionalBytes,
                    round: f.metrics.round,
                    revision: f.metrics.revision,
                  });
                }
        }
      // Same frozen raw and reconstruction, production PBR color, eager vs lazy.
      f.freezeSampling = true;
      f.lazyFallback = false;
      d.widget.render();
      const manager = d.scene._view.sceneFramebuffer._colorFramebuffer;
      const fb =
          manager._multisampleFramebuffer?.getColorFramebuffer() ??
          manager.framebuffer,
        width = d.scene.drawingBufferWidth,
        height = d.scene.drawingBufferHeight;
      const eager = w._read(fb, width, height);
      f.lazyFallback = true;
      d.widget.render();
      const lazy = w._read(fb, width, height);
      let colorDelta = 0;
      for (let i = 0; i < eager.length; i++)
        colorDelta = Math.max(colorDelta, Math.abs(eager[i] - lazy[i]));
      rows.push({
        name: "production lazy PBR comparison",
        colorDelta,
        buffer: [width, height],
      });
      // Keep a valid FG texture while moving only the resident volume away.
      // Both eager and lazy paths must match the real FG-disabled PBR output.
      const savedOrigin = C.Cartesian3.clone(w.origin);
      try {
        w.origin.x += 100000;
        f._compositeEnabled = false;
        d.widget.render();
        const outsideBaseline = w._read(fb, width, height);
        f._compositeEnabled = true;
        for (const lazyFallback of [false, true]) {
          f.lazyFallback = lazyFallback;
          d.widget.render();
          const outside = w._read(fb, width, height);
          let colorDelta = 0;
          for (let i = 0; i < outside.length; i++)
            colorDelta = Math.max(
              colorDelta,
              Math.abs(outside[i] - outsideBaseline[i]),
            );
          rows.push({
            name: "outside resident volume",
            lazyFallback,
            colorDelta,
            fgReady: f.ready,
          });
        }
      } finally {
        C.Cartesian3.clone(savedOrigin, w.origin);
        f._compositeEnabled = true;
        f.lazyFallback = true;
      }
      return rows;
    });
    report.rows.push({ query, rows });
    await p.close();
  }
  for (const group of report.rows)
    for (const row of group.rows) {
      if (row.name) {
        assert(row.colorDelta < 0.003, row.name + " PBR mismatch");
        if (row.name === "outside resident volume") assert(row.fgReady);
      } else {
        assert(row.delta < 0.0002, "same-sample Float accumulation bound");
        assert.equal(row.invalidMismatch, 0);
        assert.equal(row.nonfinite, 0);
        assert(row.valid > 1000);
        assert.equal(row.hitAllocated, row.execution === "split");
      }
    }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    (process.env.LUMEN_REPORT_DIRECTORY ?? "reports/fg-runtime-budget-v7") +
      "/execution.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    groups: report.rows.map((g) => ({
      query: g.query,
      maxDelta: Math.max(...g.rows.map((r) => r.delta ?? 0)),
      color: g.rows.at(-1),
    })),
  }),
);
