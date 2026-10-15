import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { installFixtureImageDecoder } from "./cpu-image-fixtures.mjs";
import { accepts } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
import { cross, sub, normalize, dot } from "../lumen/math.js";
import {
  newOutput,
  openPilot,
  referenceDataset,
  waitFg,
} from "./pilot-validation.mjs";
installFixtureImageDecoder();
const output = await newOutput("quality");
const configuration = {
  buffer: [1920, 1080],
  views: ["overview", "courtyard", "skylight", "doorway", "emitter"],
  profiles: ["baseline", "enhanced"],
  displays: ["models", "tiles"],
  lights: {
    day: {
      sunDirection: [-0.8, 0.6, 1.1],
      sunRadiance: [2, 2, 2],
      skyRadiance: [0.15, 0.18, 0.22],
    },
    night: {
      sunDirection: [0.8, 0.2, 0.15],
      sunRadiance: [0.4, 0.15, 0.05],
      skyRadiance: [0.03, 0.04, 0.08],
    },
  },
  referenceSamples: 8192,
  grid: [6, 4],
  limits: { queryNRMSE: 0.12, usedNRMSE: 0.2 },
  denominatorFloor: 1e-5,
  cache: false,
  convergence:
    "32 fresh FG epochs and stable history at same generation/revision/final round; baseline no FG",
  physicalReference: true,
  legacyCounterpart: true,
};
const report = {
  version: sourceVersion([
    "scripts/verify-pilot-quality.mjs",
    "scripts/pilot-validation.mjs",
    "docs/product/local-gi-v0.1.md",
  ]),
  configuration,
  rows: [],
  errors: [],
  status: "not-run",
};
const metadata = JSON.parse(
  await readFile("fixtures/earth-gi-gallery.json", "utf8"),
);
const nrmse = (actual, refs) =>
  Math.sqrt(
    actual.reduce(
      (sum, a, i) => sum + a.reduce((s, v, k) => s + (v - refs[i][k]) ** 2, 0),
      0,
    ) /
      Math.max(
        1e-5,
        refs.reduce((sum, a) => sum + a.reduce((s, v) => s + v * v, 0), 0),
      ),
  );
let browser;
const references = new Map();
try {
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  for (const display of configuration.displays) {
    await openPilot(page, display, "baseline");
    const { manifest, geometry, diagnosticCpuPeak } = await referenceDataset();
    assert.equal(
      manifest.version,
      await page.evaluate(() => pilotSession.manifest.version),
    );
    report.referencePreparationPeak = diagnosticCpuPeak;
    const bvh = new BVH(geometry);
    for (const profile of configuration.profiles) {
      if ((await page.evaluate(() => pilotSession.profile)) !== profile)
        await page.evaluate((p) => pilotSession.setQuality(p), profile);
      for (const [light, lighting] of Object.entries(configuration.lights)) {
        await page.evaluate((l) => pilotSession.setLighting(l), lighting);
        for (const view of configuration.views) {
          console.log(
            JSON.stringify({ display, profile, light, view, phase: "capture" }),
          );
          await page.evaluate(
            (camera) => pilotHost.view(camera),
            metadata.cameras[view],
          );
          const convergence =
            profile === "enhanced"
              ? await waitFg(page)
              : await page.evaluate(() => pilotSession.waitForVisible());
          const pixels = Array.from({ length: 24 }, (_, i) => [
              Math.floor((((i % 6) + 0.5) * 1920) / 6),
              Math.floor(((Math.floor(i / 6) + 0.5) * 1080) / 4),
            ]),
            capture = await page.evaluate(
              (p) => pilotSession.diagnostics({ pixels: p }),
              pixels,
            ),
            points = [],
            background = [];
          for (let i = 0; i < pixels.length; i++) {
            const ray = capture.rays[i],
              hit = bvh.trace(ray.origin, ray.direction, {
                budget: Infinity,
                accept: (t, u, v) => accepts(geometry, t, u, v),
              });
            if (hit.status !== "Hit") {
              background.push({ pixel: pixels[i], status: hit.status });
              continue;
            }
            const t = hit.triangle,
              a = Array.from(geometry.positions.slice(t * 9, t * 9 + 3)),
              b = Array.from(geometry.positions.slice(t * 9 + 3, t * 9 + 6)),
              c = Array.from(geometry.positions.slice(t * 9 + 6, t * 9 + 9));
            let ng = normalize(cross(sub(b, a), sub(c, a))),
              ns = Array.from(geometry.normals.slice(t * 3, t * 3 + 3));
            if (ns.length !== 3 || !ns.every(Number.isFinite))
              throw Error("Invalid per-triangle diagnostic normal");
            if (dot(ng, ray.direction) > 0) {
              ng = ng.map((v) => -v);
              ns = ns.map((v) => -v);
            }
            const position = ray.origin.map(
                (v, k) => v + ray.direction[k] * hit.distance,
              ),
              asset = geometry.assets.find(
                (a) => t >= a.start && t < a.start + a.triangles,
              )?.id;
            points.push({
              pixel: pixels[i],
              position,
              normal: ns,
              geometricNormal: ng,
              sourceHit: hit,
              asset,
              usedE: capture.usedE[i],
              coverage: capture.coverage[i][0],
              fgWeight: capture.fgWeight[i][0],
              fallback: capture.fallback[i][0],
            });
          }
          const query = await page.evaluate(
              (p) => pilotSession.diagnostics({ points: p }),
              points,
            ),
            refs = points.map((p, i) => {
              const key = JSON.stringify([
                p.position,
                p.normal,
                p.sourceHit,
                lighting,
                i,
              ]);
              if (!references.has(key))
                references.set(
                  key,
                  referenceIrradiance(
                    bvh,
                    p.position,
                    p.normal,
                    {
                      ...lighting,
                      bounces: 3,
                      environmentMode: "upper-hemisphere",
                      rayOriginPolicy: "physical",
                    },
                    8192,
                    5019 + i,
                    p.geometricNormal,
                    p.sourceHit,
                  ),
                );
              return references.get(key);
            });
          const legacy = points.map((p, i) =>
            referenceIrradiance(
              bvh,
              p.position,
              p.normal,
              {
                ...lighting,
                bounces: 3,
                environmentMode: "upper-hemisphere",
                rayOriginPolicy: "legacy",
              },
              8192,
              5019 + i,
              p.geometricNormal,
              p.sourceHit,
            ),
          );
          const usedNRMSE = nrmse(
              points.map((p) => p.usedE),
              refs.map((r) => r.irradiance),
            ),
            queryNRMSE = nrmse(
              query.values.map((q) => q.irradiance),
              refs.map((r) => r.irradiance),
            ),
            regions = Object.fromEntries(
              [...new Set(points.map((p) => p.asset))].map((asset) => {
                const ids = points.flatMap((p, i) =>
                  p.asset === asset ? [i] : [],
                );
                return [
                  asset,
                  {
                    denominator: ids.length,
                    referenceEnergy: ids.reduce(
                      (s, i) =>
                        s + refs[i].irradiance.reduce((n, v) => n + v * v, 0),
                      0,
                    ),
                    usedNRMSE: nrmse(
                      ids.map((i) => points[i].usedE),
                      ids.map((i) => refs[i].irradiance),
                    ),
                    queryNRMSE: nrmse(
                      ids.map((i) => query.values[i].irradiance),
                      ids.map((i) => refs[i].irradiance),
                    ),
                    fgCoverage:
                      ids.filter((i) => points[i].fgWeight > 0.5).length /
                      ids.length,
                  },
                ];
              }),
            );
          const status = await page.evaluate(() => pilotSession.status()),
            row = {
              display,
              profile,
              light,
              view,
              points,
              background,
              query,
              reference: refs,
              legacyReference: legacy,
              legacyQueryNRMSE: nrmse(
                query.values.map((q) => q.irradiance),
                legacy.map((r) => r.irradiance),
              ),
              physicalLegacyNRMSE: nrmse(
                legacy.map((r) => r.irradiance),
                refs.map((r) => r.irradiance),
              ),
              convergence,
              usedNRMSE,
              queryNRMSE,
              regions,
              status,
              absoluteRMSE: Math.sqrt(
                points.reduce(
                  (s, p, i) =>
                    s +
                    p.usedE.reduce(
                      (n, v, k) => n + (v - refs[i].irradiance[k]) ** 2,
                      0,
                    ),
                  0,
                ) / Math.max(1, points.length * 3),
              ),
              passed:
                points.length > 0 &&
                usedNRMSE <= 0.2 &&
                queryNRMSE <= 0.12 &&
                Object.values(regions).every(
                  (r) => r.usedNRMSE <= 0.2 && r.queryNRMSE <= 0.12,
                ) &&
                query.values.every(
                  (q) => (q.valid ?? q.coverage > 0) && !q.unknown,
                ) &&
                refs.every((r) => r.counts.unknown === 0),
            };
          report.rows.push(row);
          await writeFile(
            output + `/${display}-${profile}-${light}-${view}.json`,
            JSON.stringify(row, null, 2),
            { flag: "wx" },
          );
          console.log(
            JSON.stringify({
              display,
              profile,
              light,
              view,
              points: points.length,
              usedNRMSE,
              queryNRMSE,
              passed: row.passed,
            }),
          );
        }
      }
    }
  }
  report.status =
    report.rows.length === 40 &&
    report.rows.every((r) => r.passed) &&
    !report.errors.length
      ? "passed"
      : "failed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  console.error(error);
} finally {
  await browser?.close();
}
report.caseStatuses = configuration.displays.flatMap((display) =>
  configuration.profiles.flatMap((profile) =>
    Object.keys(configuration.lights).flatMap((light) =>
      configuration.views.map((view) => {
        const row = report.rows.find(
          (r) =>
            r.display === display &&
            r.profile === profile &&
            r.light === light &&
            r.view === view,
        );
        return {
          display,
          profile,
          light,
          view,
          status: row ? (row.passed ? "passed" : "failed") : "not-run",
        };
      }),
    ),
  ),
);
await writeFile(output + "/quality.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
