import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import {
  newOutput,
  openPilot,
  referenceDataset,
  waitFg,
  pilotBase,
} from "./pilot-validation.mjs";
import { installFixtureImageDecoder } from "./cpu-image-fixtures.mjs";
import { loadDatasetGeometry, identity } from "../lumen/local-dataset.js";
import { BVH } from "../lumen/bvh.js";
import { materialAt, accepts } from "../lumen/gltf.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
import {
  receiverRays,
  oracleRemainder,
  integrateParts,
} from "../lumen/contact-transport.js";
installFixtureImageDecoder();
const output = await newOutput("equivalence");
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-equivalence.mjs",
    "scripts/pilot-validation.mjs",
    "docs/product/local-gi-v0.1.md",
    ...[
      "models-enhanced-day-overview",
      "models-enhanced-day-doorway",
      "tiles-enhanced-night-emitter",
    ].map(
      (name) => `reports/local-gi-pilot-v10/quality-candidate-3/${name}.json`,
    ),
  ]),
  configuration: {
    buffer: [1920, 1080],
    cache: false,
    queryTolerance: 1e-4,
    usedAbsoluteTolerance: 0.02,
    usedRelativeTolerance: 0.03,
    geometryTolerance: 1e-5,
    highSampleQuery: 8192,
    referenceSamples: 32768,
    physicalTarget: true,
  },
  rows: [],
  errors: [],
};
let browser;
try {
  const { manifest, geometry } = await referenceDataset(),
    bvh = new BVH(geometry),
    base = new URL("../fixtures/local-pilot/dataset.json", pilotBase());
  const merged = {
    ...manifest,
    datasetId: manifest.datasetId + "-equivalent",
    assets: [
      {
        id: "merged",
        renderUri: new URL("parent.glb", base).href,
        localTransform: identity(),
        upAxis: "Z",
        forwardAxis: "X",
      },
    ],
    resources: Object.fromEntries(
      Object.entries(manifest.resources).map(([u, h]) => [
        new URL(u, base).href,
        h,
      ]),
    ),
  };
  merged.version = createHash("sha256")
    .update(JSON.stringify(merged))
    .digest("hex");
  const parent = await loadDatasetGeometry(merged, base.href);
  assert.equal(parent.materialIds.length, geometry.materialIds.length);
  const signature = (g) =>
    Array.from(g.materialIds, (_, t) =>
      JSON.stringify({
        p: Array.from(g.positions.slice(t * 9, t * 9 + 9), (v) =>
          Math.round(v * 1e5),
        ),
        n: Array.from(g.normals.slice(t * 3, t * 3 + 3), (v) =>
          Math.round(v * 1e5),
        ),
        uv: Array.from(g.uvs.slice(t * 6, t * 6 + 6), (v) =>
          Math.round(v * 1e5),
        ),
        m: materialAt(g, t, 1 / 3, 1 / 3),
      }),
    ).sort();
  const a = signature(geometry),
    b = signature(parent);
  // Material indices/asset owners may be remapped; compare actual linear PBR values.
  const strip = (s) =>
    JSON.stringify(JSON.parse(s), (k, v) => (k === "material" ? undefined : v));
  report.geometry = {
    triangles: a.length,
    equivalent: a
      .map(strip)
      .sort()
      .every((s, i) => s === b.map(strip).sort()[i]),
    ownersUnique: new Set(geometry.owners).size === geometry.owners.length,
  };
  const sources = [
    "models-enhanced-day-overview",
    "models-enhanced-day-doorway",
    "tiles-enhanced-night-emitter",
  ];
  const points = [];
  for (const name of sources) {
    const row = JSON.parse(
      await readFile(
        `reports/local-gi-pilot-v10/quality-candidate-3/${name}.json`,
        "utf8",
      ),
    );
    const ranked = row.points
      .map((p, i) => ({
        p,
        error: p.usedE.reduce(
          (n, v, k) => n + (v - row.reference[i].irradiance[k]) ** 2,
          0,
        ),
      }))
      .sort((a, b) => b.error - a.error);
    points.push({
      ...ranked[0].p,
      originalCase: name,
      originalSquaredError: ranked[0].error,
    });
  }
  report.failurePoints = points;
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  const camera = JSON.parse(
    await readFile("fixtures/earth-gi-gallery.json", "utf8"),
  ).cameras.overview;
  const pixels = Array.from({ length: 24 }, (_, i) => [
    Math.floor((((i % 6) + 0.5) * 1920) / 6),
    Math.floor(((Math.floor(i / 6) + 0.5) * 1080) / 4),
  ]);
  for (const representation of [
    "single",
    "models",
    "tiles-parent",
    "tiles-children",
  ]) {
    console.log("Comparing " + representation);
    if (representation === "single") {
      await openPilot(page, "models");
      await page.evaluate(async (m) => {
        const uri = URL.createObjectURL(
          new Blob([JSON.stringify(m)], { type: "application/json" }),
        );
        try {
          await pilotSession.replaceDataset(uri);
        } finally {
          URL.revokeObjectURL(uri);
        }
      }, merged);
    } else if (representation === "models" || representation === "tiles-parent")
      await openPilot(page, representation === "models" ? "models" : "tiles");
    if (representation.startsWith("tiles-")) {
      await page.evaluate(
        (d) => pilotSession.setDisplayDetail(d),
        representation.slice(6),
      );
      await page.waitForFunction(
        (n) => pilotSession.status().targets === n,
        representation === "tiles-parent" ? 1 : 8,
        { timeout: 60000 },
      );
    }
    await page.evaluate((c) => pilotHost.view(c), camera);
    await waitFg(page);
    const query = await page.evaluate(
      (p) => pilotSession.diagnostics({ points: p }),
      points,
    );
    const capture = await page.evaluate(
      (p) => pilotSession.diagnostics({ pixels: p }),
      pixels,
    );
    const state = await page.evaluate(() => pilotSession.status());
    const row = { representation, query, capture, state };
    report.rows.push(row);
    if (representation === "models") {
      report.attribution = [];
      for (const point of points) {
        const lighting = point.originalCase.includes("-night-")
          ? {
              sunDirection: [0.8, 0.2, 0.15],
              sunRadiance: [0.4, 0.15, 0.05],
              skyRadiance: [0.03, 0.04, 0.08],
            }
          : {
              sunDirection: [-0.8, 0.6, 1.1],
              sunRadiance: [2, 2, 2],
              skyRadiance: [0.15, 0.18, 0.22],
            };
        await page.evaluate((l) => pilotSession.setLighting(l), lighting);
        const light = {
          ...lighting,
          bounces: 3,
          environmentMode: "upper-hemisphere",
        };
        const high = await page.evaluate(async (p) => {
          const out = [];
          for (let i = 0; i < 8; i++)
            out.push(
              await pilotSession.world.sampleFinalGather([p], {
                samples: 1024,
                seed: i,
                epoch: 31,
                sampling: "reconstructed",
              }),
            );
          return out.map((r) => r[0]);
        }, point);
        const rays = receiverRays(point, 64, 0, 31),
          parts = await page.evaluate(
            (r) => pilotSession.world.diagnoseTransport(r),
            rays,
          );
        const physical = referenceIrradiance(
          bvh,
          point.position,
          point.normal,
          { ...light, rayOriginPolicy: "physical" },
          32768,
          5019,
          point.geometricNormal,
          point.sourceHit,
        );
        const legacy = referenceIrradiance(
          bvh,
          point.position,
          point.normal,
          { ...light, rayOriginPolicy: "legacy" },
          32768,
          5019,
          point.geometricNormal,
          point.sourceHit,
        );
        const integrated = integrateParts(
          rays,
          parts,
          oracleRemainder(
            bvh,
            parts,
            { ...light, rayOriginPolicy: "physical" },
            3,
            2048,
          ),
          3,
        );
        report.attribution.push({
          point,
          lighting,
          highSamples: high,
          highMean: [0, 1, 2].map(
            (k) => high.reduce((n, r) => n + r.irradiance[k], 0) / 8,
          ),
          physical,
          legacy,
          integrated,
          diagnostic: parts,
        });
      }
    }
    await writeFile(output + `/${representation}.json`, JSON.stringify(row), {
      flag: "wx",
    });
  }
  const first = report.rows[0],
    surface = pixels.map((_, i) => {
      const r = first.capture.rays[i];
      return (
        bvh.trace(r.origin, r.direction, {
          accept: (t, u, v) => accepts(geometry, t, u, v),
          budget: Infinity,
        }).status === "Hit"
      );
    });
  report.equivalence = report.rows.slice(1).map((row) => {
    const queryMax = Math.max(
      ...row.query.values.flatMap((v, i) =>
        v.irradiance.map((x, k) =>
          Math.abs(x - first.query.values[i].irradiance[k]),
        ),
      ),
    );
    const usedMax = Math.max(
      ...row.capture.usedE.flatMap((v, i) =>
        surface[i]
          ? v.map(
              (x, k) =>
                Math.abs(x - first.capture.usedE[i][k]) /
                (0.02 + 0.03 * Math.abs(first.capture.usedE[i][k])),
            )
          : [],
      ),
    );
    const denominator = surface.filter(Boolean).length;
    const supported = [first, row].every(
      (r) =>
        r.query.values.every((q) => q.valid && !q.unknown) &&
        r.capture.usedE.every(
          (_, i) =>
            !surface[i] ||
            (r.capture.coverage[i][0] > 0 &&
              r.capture.fgWeight[i][0] > 0.5 &&
              r.capture.fallback[i][0] < 0.5),
        ),
    );
    return {
      representation: row.representation,
      queryMax,
      usedToleranceRatio: usedMax,
      denominator,
      supported,
      passed: denominator > 0 && supported && queryMax <= 1e-4 && usedMax <= 1,
    };
  });
  report.status =
    report.rows.length === 4 &&
    report.geometry.equivalent &&
    report.geometry.ownersUnique &&
    report.equivalence.every((r) => r.passed) &&
    !report.errors.length
      ? "passed"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser?.close();
}
await writeFile(output + "/equivalence.json", JSON.stringify(report), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    geometry: report.geometry,
    equivalence: report.equivalence,
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
