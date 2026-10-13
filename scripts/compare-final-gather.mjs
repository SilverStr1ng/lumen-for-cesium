import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const out = "reports/receiver-final-gather-v5",
  baseline = JSON.parse(
    await readFile(
      "reports/ddgi-visual-quality-v4/after/diagnostics.json",
      "utf8",
    ),
  ),
  oldRef = JSON.parse(
    await readFile(
      "reports/ddgi-visual-quality-v4/independent-reference.json",
      "utf8",
    ),
  );
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion([
      "lumen/path-reference.js",
      "cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSnapshot.js",
    ]),
    sampling: {
      C: {
        samplesPerSeed: 1024,
        seeds: [1, 5, 19],
        pdf: "cosine Ng; Ns=Ng only; pi/N",
      },
      D: { samples: 8192, seed: 543190, independent: "no DDGI/SurfaceCache" },
    },
    cases: [],
    errors: [],
  };
p.on("pageerror", (e) => report.errors.push(String(e)));
await mkdir(out, { recursive: true });
try {
  for (const heldOut of [false, true]) {
    await p.goto(
      "http://localhost:8090/demo/globe.html?diagnostic=1" +
        (heldOut ? "&heldOut=1" : ""),
    );
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    const angle = (17 * Math.PI) / 180,
      rotate = (v, point) =>
        heldOut
          ? [
              v[0] * Math.cos(angle) -
                v[1] * Math.sin(angle) +
                (point ? 0.37 : 0),
              v[0] * Math.sin(angle) +
                v[1] * Math.cos(angle) +
                (point ? 0.21 : 0),
              v[2],
            ]
          : [...v];
    const lines = Object.fromEntries(
      Object.entries(baseline.receivers.scans).map(([name, line]) => [
        name,
        line.map(({ position, normal }) => ({
          position: rotate(position, true),
          normal: rotate(normal, false),
        })),
      ]),
    );
    const points = Object.values(lines).flat(),
      geometry = await loadGeometry(
        "http://localhost:8090/fixtures/earth-pavilion" +
          (heldOut ? "-held-out" : "") +
          ".gltf",
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      ),
      bvh = new BVH(geometry, { strategy: "sah" });
    for (const k of [1, 2, 3]) {
      const data = await p.evaluate(
        async ({ points, k }) => {
          try {
            const w = earthLab.world;
            w.setFinalGatherCapture(true);
            await w.solve({ bounces: k, publicationMode: "snapshot" });
            const snapshot = w.finalGatherSnapshot;
            const A = await w.sample(points),
              B = await w.sampleExactProbeVisibility(points),
              C = [];
            for (const seed of [1, 5, 19])
              C.push(
                await w.sampleFinalGather(points, { samples: 1024, seed }),
              );
            return {
              A,
              B,
              C,
              lighting: earthLab.lighting,
              snapshot: {
                revision: snapshot.revision,
                round: snapshot.round,
                versions: snapshot.versions,
                bytes: snapshot.resources.reduce(
                  (s, r) => s + r.texture.sizeInBytes,
                  0,
                ),
              },
              grid: w.packet.grid,
            };
          } catch (e) {
            throw Error(e.message ?? String(e));
          }
        },
        { points, k },
      );
      assert.ok(
        data.B.every((v) => v.valid) && data.C.flat().every((v) => v.valid),
        "Unknown/missing query data is a test failure",
      );
      const lighting = { ...data.lighting, bounces: k },
        result = {
          heldOut,
          k,
          snapshot: data.snapshot,
          grid: data.grid,
          lighting,
          queryWork: {
            receivers: points.length,
            A: { probeCandidatesUpperBound: points.length * 8, worldRays: 0 },
            B: { worldSegmentsUpperBound: points.length * 8 },
            C: {
              seeds: 3,
              primaryRays: points.length * 1024 * 3,
              solarRaysUpperBound: points.length * 1024 * 3,
              traversalBudget: 4096,
            },
            D: {
              samplesPerPoint: 8192,
              actualPerPointCounts: "lines.*[].D.counts",
            },
          },
          lines: {},
          metrics: { A: {}, B: {}, C: {} },
        };
      let cursor = 0;
      for (const [name, line] of Object.entries(lines)) {
        result.lines[name] = line.map((point, index) => {
          const i = cursor++,
            D = referenceIrradiance(
              bvh,
              point.position,
              point.normal,
              lighting,
              8192,
              543190 + index * 997,
            ),
            seeds = data.C.map((run) => run[i]),
            C = {
              irradiance: [0, 1, 2].map(
                (c) =>
                  seeds.reduce((s, v) => s + v.irradiance[c], 0) / seeds.length,
              ),
              standardError: [0, 1, 2].map((c) => {
                const mean =
                  seeds.reduce((s, v) => s + v.irradiance[c], 0) / seeds.length;
                return Math.sqrt(
                  seeds.reduce((s, v) => s + (v.irradiance[c] - mean) ** 2, 0) /
                    (seeds.length * (seeds.length - 1)),
                );
              }),
              valid: true,
            };
          return {
            ...point,
            index,
            A: data.A[i],
            B: data.B[i],
            C,
            CSeeds: seeds,
            D,
          };
        });
        const scoredIndices = oldRef.scans[name].map((v) => v.index);
        for (const estimate of ["A", "B", "C"]) {
          const differences = scoredIndices.flatMap((i) =>
            result.lines[name][i].D.irradiance.map(
              (v, c) => result.lines[name][i][estimate].irradiance[c] - v,
            ),
          );
          result.metrics[estimate][name] = {
            rmse: Math.sqrt(
              differences.reduce((s, v) => s + v * v, 0) / differences.length,
            ),
            mae:
              differences.reduce((s, v) => s + Math.abs(v), 0) /
              differences.length,
            scoredIndices,
          };
        }
      }
      report.cases.push(result);
      await writeFile(out + "/abcd.json", JSON.stringify(report, null, 2));
      console.log(
        heldOut ? "HELD OUT" : "PAVILION",
        k,
        JSON.stringify(result.metrics.C),
      );
    }
  }
  const final = report.cases.find((c) => !c.heldOut && c.k === 3);
  report.metrics = final.metrics;
  report.acceptance = Object.entries(final.metrics.C).map(([name, m]) => ({
    name,
    status:
      m.rmse <= oldRef.composedError.before[name].rmse ? "passed" : "failed",
  }));
  report.status = "executed";
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(out + "/abcd.json", JSON.stringify(report, null, 2));
  await b.close();
}
