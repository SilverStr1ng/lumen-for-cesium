import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out =
  process.env.LUMEN_FG_REPORT ?? "reports/fg-reconstruction-showcase-v6";
const auto = process.env.LUMEN_FG_AUTO === "1";
const viewport = {
  width: Number(process.env.LUMEN_FG_WIDTH ?? 1280),
  height: Number(process.env.LUMEN_FG_HEIGHT ?? 800),
};
const smoke = process.argv.includes("--smoke");
const output = out + (smoke ? "/canonical-smoke.json" : "/canonical.json");
const referenceFile = "reports/receiver-final-gather-v5/abcd.json";
const reference = JSON.parse(await readFile(referenceFile, "utf8"));
const prior = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/before/diagnostics.json",
    "utf8",
  ),
);
const report = {
  version: sourceVersion(["demo/fg-reconstruction-diagnostics.js"]),
  configuration: { auto, viewport },
  errors: [],
  cases: [],
  reference: {
    file: referenceFile,
    sha256: createHash("sha256")
      .update(await readFile(referenceFile))
      .digest("hex"),
    note: "Frozen independent 8192-path D for identical original/17 degree geometry and source parameters. Current A/C/Eused are newly executed.",
  },
  cameras: {
    boxFloor: { eye: [-8, -1.5, 4.2], target: [-8.95, -1.5, 0.15] },
    boxFace: { eye: [-8, -2, 2.5], target: [-9, -2, 0.6] },
    wallFoot: { eye: [-5, 5.75, 2.6], target: [-10.69, 5.75, 0.151] },
    pillarFoot: { eye: [-3.7, -5, 1.6], target: [-6.81, -2, 0.151] },
    ceiling: { eye: [-6.5, 3.5, 0.3], target: [-6.5, 7.3, 5.199] },
    doorway: { eye: [-1.5, 7.5, 4.9], target: [-1.5, 3.3, 0.151] },
  },
  scope:
    "All 49 canonical points retained. Exact main composite helper evaluated at projected canonical surface positions with physical Ng; supplementary fixed line-fit cameras. Original issue bookmarks are measured separately.",
};
await mkdir(out, { recursive: true });
const b = await launchBrowser(),
  p = await b.newPage({ viewport });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  for (const heldOut of smoke ? [false] : [false, true]) {
    await p.goto(
      "http://localhost:8090/demo/globe.html?diagnostic=1" +
        (heldOut ? "&heldOut=1" : ""),
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    await p.evaluate(async (saved) => {
      await earthLab.restoreView(saved);
      earthLab.world.setDisplayTransition(0);
      await earthLab.scene.lumen.finalGather.configure({
        mode: "fg",
        quality: "high",
        sampling: "reconstructed",
        model: earthLab.model,
      });
      await earthLab.world.completed;
      earthLab.widget.useDefaultRenderLoop = false;
      window.fgDiag = await import("./fg-reconstruction-diagnostics.js");
    }, prior.settings);
    const frozen = reference.cases.find(
      (c) => c.heldOut === heldOut && c.k === 3,
    );
    const lighting = await p.evaluate(() => earthLab.lighting);
    assert.deepEqual(
      lighting,
      frozen.lighting,
      "frozen independent D source must match exactly",
    );
    for (const samples of smoke || auto ? [32] : [16, 32]) {
      for (const seed of smoke ? [0] : [0, 5, 19]) {
        const row = {
          heldOut,
          samples,
          seed,
          lines: {},
          frames: [1, 4, 8, 16, 32],
          cameras: report.cameras,
        };
        for (const [name, line] of Object.entries(frozen.lines)) {
          const points = line.map((x) => ({
            position: x.position,
            normal: x.normal,
          }));
          const data = await p.evaluate(
            async ({ points, camera, heldOut, samples, seed, auto }) => {
              const d = earthLab,
                f = d.scene.lumen.finalGather;
              await f.configure({
                mode: "fg",
                quality: auto ? "auto" : samples === 16 ? "balanced" : "high",
                sampling: "reconstructed",
                seed,
                model: d.model,
              });
              const rotate = (v) =>
                heldOut
                  ? [
                      v[0] * Math.cos((17 * Math.PI) / 180) -
                        v[1] * Math.sin((17 * Math.PI) / 180) +
                        0.37,
                      v[0] * Math.sin((17 * Math.PI) / 180) +
                        v[1] * Math.cos((17 * Math.PI) / 180) +
                        0.21,
                      v[2],
                    ]
                  : v;
              d.metadata.cameras.__line = {
                eye: rotate(camera.eye),
                target: rotate(camera.target),
              };
              d.camera("__line");
              f.reconstruction?.invalidate("canonical capture");
              f._historyWorld = undefined;
              f._stableFrames = 0;
              f._sampleEpoch = 0;
              const frames = [];
              for (let frame = 1; frame <= 32; frame++) {
                d.widget.render();
                if ([1, 4, 8, 16, 32].includes(frame)) {
                  f.freezeSampling = true;
                  const composite = await fgDiag.sampleComposite(d, points);
                  const r = fgDiag.readReconstruction(d);
                  frames.push({
                    frame,
                    composite,
                    counts: r.counts,
                    revision: f.metrics.revision,
                    round: f.metrics.round,
                    sampleEpoch: f.metrics.sampleEpoch,
                  });
                  f.freezeSampling = false;
                }
              }
              const high = [];
              for (const refSeed of [1, 5, 19])
                high.push(
                  await d.world.sampleFinalGather(points, {
                    samples: 1024,
                    seed: refSeed,
                    budget: 4096,
                  }),
                );
              return {
                frames,
                high,
                metrics: {
                  ...f.metrics,
                  stages: undefined,
                  completedTimings: undefined,
                },
                settings: await d.saveView(),
              };
            },
            {
              points,
              camera: report.cameras[name],
              heldOut,
              samples,
              seed,
              auto,
            },
          );
          assert(data.high.flat().every((x) => x.valid && !x.unknown));
          row.lines[name] = {
            ...data,
            reference: line.map((x) => ({ D: x.D, A: x.A, C: x.C })),
            scoredIndices: frozen.metrics.C[name].scoredIndices,
          };
        }
        report.cases.push(row);
        await writeFile(output, JSON.stringify(report, null, 2));
        console.log(
          JSON.stringify({
            heldOut,
            samples,
            seed,
            coverage: Object.fromEntries(
              Object.entries(row.lines).map(([name, l]) => [
                name,
                l.frames.at(-1).composite.filter((p) => p.weight > 0.99).length,
              ]),
            ),
          }),
        );
      }
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
  await writeFile(output, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    cases: report.cases.length,
    error: report.error,
  }),
);
