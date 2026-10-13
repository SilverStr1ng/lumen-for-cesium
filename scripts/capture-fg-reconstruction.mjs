import assert from "node:assert/strict";
import { installFixtureImageDecoder } from "./cpu-image-fixtures.mjs";
installFixtureImageDecoder();
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const base =
  process.env.LUMEN_FG_REPORT ?? "reports/fg-reconstruction-showcase-v6";
const auto = process.env.LUMEN_FG_AUTO === "1";
const viewport = {
  width: Number(process.env.LUMEN_FG_WIDTH ?? 1280),
  height: Number(process.env.LUMEN_FG_HEIGHT ?? 800),
};
const out = base + "/screen",
  smoke = process.argv.includes("--smoke");
await mkdir(out, { recursive: true });
const prior = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/before/diagnostics.json",
    "utf8",
  ),
);
const report = {
  version: sourceVersion([
    "demo/fg-reconstruction-diagnostics.js",
    "demo/receiver-diagnostics.js",
    "lumen/path-reference.js",
  ]),
  cases: [],
  errors: [],
  scope:
    "Actual linear Scene E_used plus full-resolution receiver guides; synchronized diagnostic windows excluded from GPU timing. ROI is a contiguous 64x48 low-pixel block; every ROI pixel retained.",
};
const scenes = smoke
  ? [
      {
        id: "original",
        url: "globe.html",
        asset: "earth-pavilion",
        views: ["boxFoot"],
        qualities: ["high"],
      },
    ]
  : [
      {
        id: "original",
        url: "globe.html",
        asset: "earth-pavilion",
        views: ["boxFoot", "pillarFoot", "ceiling"],
        qualities: ["balanced", "high"],
      },
      {
        id: "held-out",
        url: "globe.html?heldOut=1",
        asset: "earth-pavilion-held-out",
        views: ["boxFoot", "pillarFoot", "ceiling"],
        qualities: ["balanced", "high"],
      },
      {
        id: "gallery",
        url: "gallery.html",
        asset: "earth-gi-gallery",
        views: ["courtyard", "skylight", "emitter"],
        qualities: ["high"],
      },
      {
        id: "slanted-thin",
        url: "globe.html?barrier=1",
        asset: "fg-slanted-barrier",
        views: ["left", "right"],
        qualities: ["high"],
      },
      {
        id: "original-scale",
        url: "globe.html",
        asset: "earth-pavilion",
        views: ["boxFoot"],
        qualities: ["roi", "fast"],
      },
    ];
if (auto) {
  for (const s of scenes) s.qualities = ["auto"];
  const index = scenes.findIndex((s) => s.id === "original-scale");
  if (index >= 0) scenes.splice(index, 1);
}
report.configuration = { auto, viewport, scenes };
if (process.argv.includes("--resume")) {
  const previous = JSON.parse(await readFile(out + "/data.json", "utf8"));
  for (const [file, hash] of Object.entries(previous.version.sources)) {
    if (report.version.sources[file] !== hash)
      throw Error("resume source mismatch: " + file);
  }
  report.cases = previous.cases;
  report.resume = { cases: previous.cases.length, reason: previous.error };
}
const b = await launchBrowser(),
  p = await b.newPage({ viewport });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  for (const scenario of scenes) {
    await p.goto(
      "http://localhost:8090/demo/" +
        scenario.url +
        (scenario.url.includes("?") ? "&" : "?") +
        "diagnostic=1" +
        (auto ? "&nativeBuffer=1" : ""),
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    if (scenario.id.startsWith("original") || scenario.id === "held-out")
      await p.evaluate((saved) => earthLab.restoreView(saved), prior.settings);
    await p.evaluate(async () => {
      const d = earthLab;
      d.world.setDisplayTransition(0);
      await d.scene.lumen.finalGather.configure({
        mode: "fg",
        quality: "high",
        sampling: "reconstructed",
        model: d.model,
      });
      await d.world.completed;
      d.widget.useDefaultRenderLoop = false;
      window.rdiag = await import("./fg-reconstruction-diagnostics.js");
      window.cdiag = await import("./receiver-diagnostics.js");
    });
    await p.addStyleTag({
      content: "aside,footer,.cesium-widget-credits{display:none!important}",
    });
    const geometry = await loadGeometry(
      "http://localhost:8090/fixtures/" + scenario.asset + ".gltf",
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
    const bvh = new BVH(geometry, { strategy: "sah" }),
      references = new Map();
    report.environment = await environment(p, b);
    for (const quality of scenario.qualities)
      for (const view of scenario.views)
        for (const seed of smoke ? [0] : [0, 5, 19]) {
          const name = scenario.id + "-" + view + "-" + quality + "-s" + seed;
          if (report.cases.some((c) => c.name === name)) continue;
          const result = await p.evaluate(
            async ({ quality, view, seed }) => {
              const d = earthLab,
                f = d.scene.lumen.finalGather;
              d.camera(view);
              await f.configure({
                mode: "fg",
                quality,
                sampling: "reconstructed",
                seed,
                model: d.model,
              });
              f.reconstruction?.invalidate("screen capture");
              f._historyWorld = undefined;
              f._stableFrames = 0;
              f._sampleEpoch = 0;
              const frames = [],
                w = d.scene.drawingBufferWidth,
                h = d.scene.drawingBufferHeight;
              // Separate full-resolution diagnostic guide, replaying already-prepared commands.
              const guide = new Cesium.LumenReceiverPass();
              try {
                for (let frame = 1; frame <= 32; frame++) {
                  d.widget.render();
                  if (![1, 4, 8, 16, 32].includes(frame)) continue;
                  f.freezeSampling = true;
                  const r = rdiag.readReconstruction(d),
                    roi = [],
                    rois = [];
                  const cx = Math.floor(r.width * 0.5),
                    cy = Math.floor(r.height * 0.28);
                  const ox = Math.max(0, Math.min(r.width - 64, cx - 32)),
                    oy = Math.max(0, Math.min(r.height - 48, cy - 24));
                  for (let y = oy; y < oy + 48; y++)
                    for (let x = ox; x < ox + 64; x++) {
                      const i = (y * r.width + x) * 4,
                        j = ((y + f.offset.y) * r.rw + x + f.offset.x) * 4;
                      roi.push({
                        pixel: [x, y],
                        position: Array.from(r.positions.slice(j, j + 3)),
                        normal: Array.from(r.normals.slice(j, j + 3)),
                        owner: r.positions[j + 3],
                        raw: Array.from(r.raw.slice(i, i + 4)),
                        temporal: Array.from(r.temporal.slice(i, i + 4)),
                        filtered: Array.from(r.filtered.slice(i, i + 4)),
                        moments: Array.from(r.moments.slice(i, i + 4)),
                        mask: r.mask[i] / 255,
                        connections: Array.from(
                          r.connections.slice(i, i + 4),
                        ).map((v) => v / 255),
                      });
                    }
                  guide.execute(
                    d.scene,
                    d.scene._view.passState,
                    d.scene._view.frustumCommandsList,
                    w,
                    h,
                  );
                  const P = d.world._read(guide.framebuffer, w, h, 0),
                    N = d.world._read(guide.framebuffer, w, h, 1);
                  const E = cdiag.linearFrame(d, 4),
                    weights = cdiag.linearFrame(d, 15),
                    fallback = cdiag.linearFrame(d, 17);
                  const screen = [];
                  let surfacePixels = 0,
                    weightedPixels = 0,
                    weightSum = 0;
                  const reasons = {};
                  for (let i = 0; i < P.length; i += 4)
                    if (P[i + 3] > 0.5) {
                      surfacePixels++;
                      if (weights[i] > 0.99) weightedPixels++;
                      weightSum += weights[i];
                      const code = Math.round(fallback[i]);
                      reasons[code] = (reasons[code] ?? 0) + 1;
                    }
                  for (let gy = 0; gy < 16; gy++)
                    for (let gx = 0; gx < 24; gx++) {
                      const x = Math.floor(((gx + 0.5) * w) / 24),
                        y = Math.floor(((gy + 0.5) * h) / 16),
                        i = (y * w + x) * 4;
                      screen.push({
                        pixel: [x, y],
                        position: Array.from(P.slice(i, i + 3)),
                        normal: Array.from(N.slice(i, i + 3)),
                        owner: P[i + 3],
                        Eused: Array.from(E.slice(i, i + 3)),
                        weight: weights[i],
                        fallback: fallback[i],
                      });
                    }
                  frames.push({
                    frame,
                    roi,
                    screen,
                    counts: r.counts,
                    coverage: {
                      surfacePixels,
                      weightedPixels,
                      meanWeight: weightSum / Math.max(1, surfacePixels),
                      reasons,
                    },
                    sceneFrame: d.scene.frameState.frameNumber,
                    actualFGFrames: f.metrics.frames,
                    accumulatedPasses: f.reconstruction.frames,
                    revision: f.metrics.revision,
                    round: f.metrics.round,
                    sampleEpoch: f.metrics.sampleEpoch,
                  });
                  d.scene.lumen.debugMode = 0;
                  d.widget.render();
                  if (seed === 0)
                    frames.at(-1).screenshot =
                      d.scene.canvas.toDataURL("image/png");
                  f.freezeSampling = false;
                }
                // Current DDGI from the same source, and high FG for the exact low receiver positions.
                const last = frames.at(-1),
                  valid = last.roi.filter((x) => x.owner > 0.5);
                const high = [];
                for (const refSeed of [1, 5, 19])
                  high.push(
                    await d.world.sampleFinalGather(
                      valid.map((x) => ({
                        position: x.position,
                        normal: x.normal,
                      })),
                      { samples: 1024, seed: refSeed, budget: 4096 },
                    ),
                  );
                const A = await d.world.sample(
                  last.screen.map((x) => ({
                    position: x.position,
                    normal: x.normal,
                  })),
                );
                return {
                  frames,
                  high,
                  roiReferenceIndices: last.roi
                    .map((x, i) => (x.owner > 0.5 ? i : -1))
                    .filter((i) => i >= 0),
                  A,
                  metrics: {
                    ...f.metrics,
                    stages: undefined,
                    completedTimings: undefined,
                  },
                  settings: await d.saveView(),
                  lighting: structuredClone(d.lighting),
                };
              } finally {
                guide.destroy();
                f.freezeSampling = false;
                d.scene.lumen.debugMode = 0;
              }
            },
            { quality, view, seed },
          );
          // Values at new physical receiver locations are scored against fresh independent D.
          const key =
            view +
            "-" +
            (quality === "roi" || quality === "fast" ? quality : "half");
          if (!references.has(key)) {
            const D = result.frames
              .at(-1)
              .screen.map((point, i) =>
                point.owner > 0.5
                  ? referenceIrradiance(
                      bvh,
                      point.position,
                      point.normal,
                      { ...result.lighting, bounces: 3 },
                      4096,
                      72109 + i * 997,
                    )
                  : null,
              );
            references.set(key, D);
          }
          result.D = references.get(key);
          assert(
            result.high.flat().every((x) => x.valid && !x.unknown),
            "high reference must be complete",
          );
          assert(
            result.frames.every(
              (x) =>
                x.counts.rawReasons["primary-unknown"] === undefined &&
                x.counts.rawReasons["solar-unknown"] === undefined,
            ),
            "Unknown production pixels are not hidden",
          );
          const rgbError = (values, ref) =>
            Math.sqrt(
              values
                .flatMap((rgb, i) => rgb.map((v, c) => (v - ref[i][c]) ** 2))
                .reduce((a, b) => a + b, 0) / Math.max(1, values.length * 3),
            );
          const C = result.high[0].map((_, i) =>
            [0, 1, 2].map((c) =>
              result.high.reduce((s, run) => s + run[i].irradiance[c] / 3, 0),
            ),
          );
          const frameStats = result.frames.map((frame) => {
            const values = (kind) =>
              result.roiReferenceIndices.map((i) =>
                frame.roi[i][kind].slice(0, 3),
              );
            const indices = frame.screen
              .map((x, i) => (x.owner > 0.5 ? i : -1))
              .filter((i) => i >= 0);
            const D = indices.map((i) => result.D[i].irradiance);
            const err = values("raw").map((v, i) =>
              v.map((x, c) => x - C[i][c]),
            );
            const autocorrelation = (dx, dy) => {
              const ids = new Map(
                result.roiReferenceIndices.map((j, i) => [
                  frame.roi[j].pixel.join(":"),
                  i,
                ]),
              );
              let numerator = 0,
                denominator = 0,
                pairs = 0;
              result.roiReferenceIndices.forEach((j, i) => {
                const p = frame.roi[j].pixel,
                  k = ids.get([p[0] + dx, p[1] + dy].join(":"));
                if (k === undefined) return;
                for (let c = 0; c < 3; c++) {
                  numerator += err[i][c] * err[k][c];
                  denominator += err[i][c] ** 2;
                }
                pairs++;
              });
              return {
                value: denominator ? numerator / denominator : 0,
                pairs,
              };
            };
            return {
              frame: frame.frame,
              rawRmseC: rgbError(values("raw"), C),
              temporalRmseC: rgbError(values("temporal"), C),
              filteredRmseC: rgbError(values("filtered"), C),
              EusedRmseD: rgbError(
                indices.map((i) => frame.screen[i].Eused),
                D,
              ),
              DdgirmseD: rgbError(
                indices.map((i) => result.A[i].irradiance),
                D,
              ),
              rawHorizontalErrorCorrelation: autocorrelation(1, 0),
              rawVerticalErrorCorrelation: autocorrelation(0, 1),
              coverage: frame.coverage,
              lengthMean: frame.counts.lengthMean,
              independentPoints: indices.length,
              roiPoints: C.length,
            };
          });
          for (const frame of result.frames) {
            if (frame.screenshot) {
              await writeFile(
                out + "/" + name + "-frame-" + frame.frame + ".png",
                Buffer.from(frame.screenshot.split(",")[1], "base64"),
              );
              delete frame.screenshot;
            }
          }
          const payload = { ...result, frameStats };
          await writeFile(
            out + "/" + name + ".json.deflate",
            deflateSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
          );
          report.cases.push({
            name,
            scenario: scenario.id,
            view,
            quality,
            seed,
            frameStats,
            metrics: result.metrics,
            data: name + ".json.deflate",
            settings: result.settings,
          });
          // Static final and same-sampling component screenshots.
          for (const [mode, label] of [
            [0, "final-32"],
            [13, "raw-32"],
            [14, "filtered-32"],
            [15, "weight-32"],
            [17, "fallback-32"],
          ]) {
            if (seed !== 0) break;
            await p.evaluate((mode) => {
              const d = earthLab;
              d.scene.lumen.finalGather.freezeSampling = true;
              d.scene.lumen.debugMode = mode;
              d.widget.render();
            }, mode);
            await p.screenshot({
              path: out + "/" + name + "-" + label + ".png",
            });
          }
          await p.evaluate(() => {
            earthLab.scene.lumen.finalGather.freezeSampling = false;
            earthLab.scene.lumen.debugMode = 0;
          });
          await writeFile(out + "/data.json", JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              name,
              first: frameStats[0].rawRmseC,
              final: frameStats.at(-1).filteredRmseC,
              total: frameStats.at(-1).EusedRmseD,
              coverage: frameStats.at(-1).coverage.meanWeight,
            }),
          );
        }
  }
  assert.deepEqual(report.errors, []);
  report.status = "executed";
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
    cases: report.cases.length,
    error: report.error,
  }),
);
