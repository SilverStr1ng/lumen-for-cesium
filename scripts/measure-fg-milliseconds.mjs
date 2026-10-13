import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out = process.env.LUMEN_FG_REPORT ?? "reports/fg-runtime-budget-v7/fixed",
  auto = process.env.LUMEN_FG_AUTO === "1";
const viewport = {
  width: Number(process.env.LUMEN_FG_WIDTH ?? 1280),
  height: Number(process.env.LUMEN_FG_HEIGHT ?? 800),
};
const report = {
  version: sourceVersion(["scripts/measure-fg-milliseconds.mjs"]),
  configuration: { auto, viewport },
  rows: [],
  errors: [],
  scope:
    "Independent fresh accumulation windows at 100/250/500/1000 ms; diagnostics only after each window. References from current capture at verified identical physical receiver positions.",
};
const saved = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/before/diagnostics.json",
    "utf8",
  ),
);
const b = await launchBrowser();
try {
  for (const scene of ["original", "held-out", "gallery"]) {
    const view = scene === "gallery" ? "courtyard" : "boxFoot",
      quality = auto ? "auto" : "high";
    const p = await b.newPage({ viewport });
    p.on("pageerror", (e) => report.errors.push(String(e)));
    await p.goto(
      "http://localhost:8090/demo/" +
        (scene === "gallery"
          ? "gallery.html?nativeBuffer=1"
          : scene === "held-out"
            ? "globe.html?heldOut=1"
            : "globe.html?") +
        "&diagnostic=1",
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    if (scene !== "gallery")
      await p.evaluate((s) => earthLab.restoreView(s), saved.settings);
    await p.evaluate(
      async ({ quality, view }) => {
        const d = earthLab;
        d.camera(view);
        d.world.setDisplayTransition(0);
        await d.scene.lumen.finalGather.configure({
          mode: "fg",
          quality,
          sampling: "reconstructed",
          model: d.model,
        });
        await d.world.completed;
        d.widget.useDefaultRenderLoop = false;
        d.scene.requestRenderMode = false;
        window.msDiag = await import("./fg-reconstruction-diagnostics.js");
      },
      { quality, view },
    );
    for (const seed of [0, 5, 19]) {
      const raw = JSON.parse(
        inflateSync(
          await readFile(
            out +
              "/screen/" +
              scene +
              "-" +
              view +
              "-" +
              quality +
              "-s" +
              seed +
              ".json.deflate",
          ),
        ),
      );
      const last = raw.frames.at(-1),
        ids = raw.roiReferenceIndices;
      const points = last.screen
        .filter((x, i) => x.owner > 0.5 && raw.D[i])
        .map((x) => ({ position: x.position, normal: x.normal }));
      const D = last.screen
        .map((x, i) => (x.owner > 0.5 && raw.D[i] ? raw.D[i].irradiance : null))
        .filter(Boolean);
      const C = ids.map((_, i) =>
        [0, 1, 2].map((c) =>
          raw.high.reduce((s, r) => s + r[i].irradiance[c] / 3, 0),
        ),
      );
      for (const target of [100, 250, 500, 1000]) {
        const data = await p.evaluate(
          async ({ seed, target, ids, pixels, points }) => {
            const d = earthLab,
              f = d.scene.lumen.finalGather;
            await f.configure({ seed });
            f.continuousSampling = true;
            f.freezeSampling = false;
            f.reconstruction?.invalidate("fresh millisecond window");
            f._historyWorld = undefined;
            f._stableFrames = 0;
            f._sampleEpoch = 0;
            const before = f.metrics.frames,
              start = performance.now();
            do {
              await new Promise(requestAnimationFrame);
              d.widget.render();
            } while (performance.now() - start < target);
            const elapsed = performance.now() - start,
              frames = f.metrics.frames - before;
            f.freezeSampling = true;
            const r = msDiag.readReconstruction(d),
              roi = ids.map((j, i) => {
                const [x, y] = pixels[i],
                  k = (y * r.width + x) * 4;
                return {
                  position: Array.from(r.positions.slice(k, k + 3)),
                  normal: Array.from(r.normals.slice(k, k + 3)),
                  raw: Array.from(r.raw.slice(k, k + 3)),
                  filtered: Array.from(r.filtered.slice(k, k + 3)),
                };
              });
            const composite = await msDiag.sampleComposite(d, points);
            f.freezeSampling = false;
            return {
              elapsed,
              frames,
              roi,
              composite,
              round: f.metrics.round,
              revision: f.metrics.revision,
              receiver: [r.width, r.height],
              history: r.counts.lengthMean,
            };
          },
          {
            seed,
            target,
            ids,
            pixels: ids.map((i) => last.roi[i].pixel),
            points,
          },
        );
        const rmse = (values, refs) =>
          Math.sqrt(
            values
              .flatMap((v, i) => v.map((x, c) => (x - refs[i][c]) ** 2))
              .reduce((a, b) => a + b, 0) /
              (values.length * 3),
          );
        const positionDelta = Math.max(
          ...data.roi.flatMap((v, i) =>
            v.position.map((x, c) =>
              Math.abs(x - last.roi[ids[i]].position[c]),
            ),
          ),
        );
        assert(positionDelta < 0.00002 && data.frames > 0 && data.round === 3);
        assert(data.composite.every((x) => x.Eused.every(Number.isFinite)));
        const row = {
          scene,
          view,
          seed,
          targetMilliseconds: target,
          actualMilliseconds: data.elapsed,
          actualFGFrames: data.frames,
          historyMean: data.history,
          receiver: data.receiver,
          positionDelta,
          rawRmseC: rmse(
            data.roi.map((x) => x.raw),
            C,
          ),
          filteredRmseC: rmse(
            data.roi.map((x) => x.filtered),
            C,
          ),
          EusedRmseD: rmse(
            data.composite.map((x) => x.Eused),
            D,
          ),
          coverage:
            data.composite.reduce((s, x) => s + x.weight, 0) /
            data.composite.length,
          round: data.round,
        };
        report.rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    await p.close();
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
    out + "/same-milliseconds.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    error: report.error,
  }),
);
