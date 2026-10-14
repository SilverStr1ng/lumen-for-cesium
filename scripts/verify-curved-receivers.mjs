import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, environment, sourceVersion } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/curved-first";
const contact = process.env.LUMEN_CONTACT_TRANSPORT === "1",
  quick = process.env.LUMEN_CURVE_QUICK === "1";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  report = {
    version: sourceVersion(["scripts/verify-curved-receivers.mjs"]),
    limits: {
      coverage: 0.95,
      historyNormalDegrees: 0.25,
      linearNRMSE: 0.2,
      queryNRMSE: 0.12,
      backendDelta: 0.00001,
    },
    rows: [],
    configuration: {
      contact,
      quick,
      source: process.env.LUMEN_RADIANCE_SOURCE ?? "immediate",
      referencePolicy: contact ? "physical" : "legacy-15mm",
      legacyComparison: contact,
    },
    failures: [],
    errors: [],
    renderErrors: [],
  };
const nrmse = (actual, reference) =>
  Math.sqrt(
    actual.reduce(
      (s, a, i) => s + a.reduce((v, x, k) => v + (x - reference[i][k]) ** 2, 0),
      0,
    ) /
      Math.max(
        0.00001,
        reference.reduce((s, a) => s + a.reduce((v, x) => v + x * x, 0), 0),
      ),
  );
try {
  for (const count of quick ? [1] : [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") report.renderErrors.push(m.text());
    });
    await page.goto(
      `http://localhost:8090/demo/ballpool.html?diagnostic=1&count=${count}&camera=close&radianceSource=${process.env.LUMEN_RADIANCE_SOURCE ?? "immediate"}`,
    );
    await page.waitForFunction(
      () => ballPool.snapshot().phase === "static-ready",
      null,
      { timeout: 180000 },
    );
    report.environment ??= await environment(page, browser);
    const gltf = await page.evaluate(
        async () => await (await fetch(ballPool.world.options.url)).json(),
      ),
      geometry = await loadGeometry(
        `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`,
      ),
      bvh = new BVH(geometry, { strategy: "sah" });
    for (const scenario of quick
      ? ["day"]
      : ["day", "black", "white-sky", "sun-turned", "colored-bounce"]) {
      const light =
        scenario === "black"
          ? { sunRadiance: [0, 0, 0], skyRadiance: [0, 0, 0] }
          : scenario === "white-sky"
            ? { sunRadiance: [0, 0, 0], skyRadiance: [1, 1, 1] }
            : scenario === "sun-turned"
              ? {
                  sunRadiance: [2, 2, 2],
                  skyRadiance: [0.15, 0.18, 0.22],
                  sunDirection: [1, -1, 0.3],
                }
              : scenario === "colored-bounce"
                ? { sunRadiance: [0, 0, 0], skyRadiance: [0.5, 0.5, 0.5] }
                : {
                    sunRadiance: [2, 2, 2],
                    skyRadiance: [0.15, 0.18, 0.22],
                    sunDirection: [-0.8, 0.6, 1.1],
                  };
      await page.evaluate((changes) => {
        ballPool.widget.useDefaultRenderLoop = true;
        return ballPool.relight(changes);
      }, light);
      for (const seed of quick ? [0] : [0, 5, 19]) {
        for (const view of quick ? ["contact"] : ["close", "contact"]) {
          const capture = await page.evaluate(
              async ({ seed, view }) => {
                const f = ballPool.scene.lumen.finalGather;
                ballPool.widget.useDefaultRenderLoop = false;
                ballPool.camera(view);
                await f.configure({
                  seed,
                  sequenceEpoch: null,
                  model: ballPool.model,
                  execution: "split",
                  sampling: "reconstructed",
                  quality: "auto",
                  smoothReceivers: true,
                });
                f._sampleEpoch = 0;
                for (let i = 0; i < 32; i++) ballPool.widget.render();
                const { captureCurved } =
                    await import("/demo/curved-diagnostics.js"),
                  c = captureCurved(ballPool);
                c.points = c.points.slice(0, 32);
                const query = await ballPool.world.sampleFinalGather(c.points, {
                  samples: 1024,
                  seed,
                  sampling: "reconstructed",
                  epoch: 31,
                });
                const regionQueries = Object.fromEntries(
                  await Promise.all(
                    Object.entries(c.regionPoints).map(
                      async ([name, points]) => [
                        name,
                        points.length
                          ? await ballPool.world.sampleFinalGather(points, {
                              samples: 1024,
                              seed,
                              sampling: "reconstructed",
                              epoch: 31,
                            })
                          : [],
                      ],
                    ),
                  ),
                );
                return {
                  capture: c,
                  query,
                  regionQueries,
                  lighting: { ...ballPool.lighting },
                  state: ballPool.snapshot(),
                };
              },
              { seed, view },
            ),
            c = capture.capture;
          capture.lighting.rayOriginPolicy = contact
            ? "physical"
            : "legacy-15mm";
          assert(c.points.length >= 6, "must sample actual curved receivers");
          const reference = c.points.map((p, i) =>
              referenceIrradiance(
                bvh,
                p.position,
                p.normal,
                capture.lighting,
                8192,
                3019 + i,
                p.geometricNormal,
              ),
            ),
            refs = reference.map((r) => r.irradiance),
            row = {
              count,
              scenario,
              seed,
              view,
              geometry: geometry.positions.length / 9,
              ...c,
              reference,
              query: capture.query,
              linearNRMSE: nrmse(
                c.points.map((p) => p.E),
                refs,
              ),
              rawNRMSE: nrmse(
                c.points.map((p) => p.raw),
                refs,
              ),
              queryNRMSE: nrmse(
                capture.query.map((p) => p.irradiance),
                refs,
              ),
              regionErrors: Object.fromEntries(
                Object.entries(c.regionPoints).map(([name, points]) => {
                  const reference = points.map((p, i) =>
                    referenceIrradiance(
                      bvh,
                      p.position,
                      p.normal,
                      capture.lighting,
                      8192,
                      5019 + i,
                      p.geometricNormal,
                    ),
                  );
                  return [
                    name,
                    {
                      status: points.length ? "measured" : "not-run",
                      points,
                      reference,
                      legacyReference: contact
                        ? points.map((p, i) =>
                            referenceIrradiance(
                              bvh,
                              p.position,
                              p.normal,
                              {
                                ...capture.lighting,
                                rayOriginPolicy: "legacy-15mm",
                              },
                              8192,
                              5019 + i,
                              p.geometricNormal,
                            ),
                          )
                        : undefined,
                      linearNRMSE: points.length
                        ? nrmse(
                            points.map((p) => p.E),
                            reference.map((p) => p.irradiance),
                          )
                        : null,
                      query: capture.regionQueries[name],
                      queryNRMSE: points.length
                        ? nrmse(
                            capture.regionQueries[name].map(
                              (p) => p.irradiance,
                            ),
                            reference.map((p) => p.irradiance),
                          )
                        : null,
                      absoluteRMSE: points.length
                        ? Math.sqrt(
                            points.reduce(
                              (sum, p, i) =>
                                sum +
                                p.E.reduce(
                                  (s, x, k) =>
                                    s + (x - reference[i].irradiance[k]) ** 2,
                                  0,
                                ),
                              0,
                            ) /
                              (3 * points.length),
                          )
                        : null,
                    },
                  ];
                }),
              ),
              lighting: capture.lighting,
              resource: capture.state.resources,
            };
          if (contact) {
            for (const region of Object.values(row.regionErrors))
              if (region.points.length) {
                const error = (key) =>
                  region.points.flatMap((p, i) =>
                    (key === "query" ? region.query[i].irradiance : p.E).map(
                      (v, k) => Math.abs(v - region.reference[i].irradiance[k]),
                    ),
                  );
                for (const key of ["query", "image"]) {
                  const errors = error(key);
                  region[key + "AbsoluteRMSE"] = Math.sqrt(
                    errors.reduce((s, v) => s + v * v, 0) / errors.length,
                  );
                  region[key + "MaximumAbsoluteError"] = Math.max(...errors);
                }
                region.legacyQueryNRMSE = nrmse(
                  region.query.map((q) => q.irradiance),
                  region.legacyReference.map((r) => r.irradiance),
                );
                region.legacyImageNRMSE = nrmse(
                  region.points.map((p) => p.E),
                  region.legacyReference.map((r) => r.irradiance),
                );
              }
            row.legacyReference = c.points.map((p, i) =>
              referenceIrradiance(
                bvh,
                p.position,
                p.normal,
                { ...capture.lighting, rayOriginPolicy: "legacy-15mm" },
                8192,
                3019 + i,
                p.geometricNormal,
              ),
            );
            row.source = await page.evaluate(() => ({
              requested: document.getElementById("radianceSource").value,
              actual: ballPool.world.surfaceCache?.enabled
                ? "cache"
                : "immediate",
              cache: ballPool.world.surfaceCache?.metrics,
              resource: ballPool.snapshot().resources,
            }));
            row.sourceUse = await page.evaluate(async (points) => {
              const { receiverRays } =
                  await import("/lumen/contact-transport.js"),
                f = ballPool.scene.lumen.finalGather,
                all = points.flatMap((p) =>
                  receiverRays(p, f.samples, f.seed, f.metrics.sampleEpoch),
                ),
                rays = all.filter((r) => !r.knownZero),
                values = ballPool.world.diagnoseTransport(rays).cacheStatus;
              return {
                scheduled: all.length,
                knownZero: all.length - rays.length,
                executed: rays.length,
                cachedHits: values.filter((v) => v[0] > 0.5 && v[1] > 0.5)
                  .length,
                missOrKnownBlack: values.filter((v) => v[0] < 0.5 && v[1] > 0.5)
                  .length,
                unsupported: values.filter(
                  (v) => v[0] < 0.5 && v[3] > 0.5 && v[2] < 0.5,
                ).length,
                invalidCached: values.filter((v) => v[0] > 0.5 && v[1] < 0.5)
                  .length,
                unknown: values.filter((v) => v[2] > 0.5).length,
                fallback: values.filter((v) => v[3] > 0.5).length,
              };
            }, Object.values(c.regionPoints).flat());
          }
          report.rows.push(row);
          await writeFile(
            out + "/curved.json",
            JSON.stringify({ ...report, status: "running" }, null, 2),
          );
          try {
            assert(
              c.meanWeight >= report.limits.coverage,
              `curved coverage ${count}/${scenario}/${seed}: ${c.meanWeight}`,
            );
            assert(
              c.maxHistoryNormalDegrees <= report.limits.historyNormalDegrees,
            );
            for (const [name, region] of Object.entries(row.regionErrors)) {
              if (region.points.length) {
                assert(
                  region.linearNRMSE <= report.limits.linearNRMSE,
                  `${name} independent E NRMSE ${region.linearNRMSE}`,
                );
                if (contact) {
                  assert(
                    region.queryNRMSE <= report.limits.queryNRMSE,
                    `${name} independent query NRMSE ${region.queryNRMSE}`,
                  );
                }
              }
            }
            if (view === "contact")
              assert(
                c.regions.ballFloorContact.pixels > 0,
                "ground-contact pixels must be measured",
              );
            assert(
              c.regions.foregroundContour.pixels > 0,
              "foreground contour must be measured",
            );
            if (count === 2 && view === "contact")
              assert(
                c.regions.ballBallContact.pixels > 0,
                "dual-ball contact pixels must be measured",
              );
            if (view === "contact")
              assert(
                row.regionErrors.ballFloorContact.points.length > 0,
                "ground-contact reference must run",
              );
            if (count === 2 && view === "contact")
              assert(
                row.regionErrors.ballBallContact.points.length > 0,
                "dual-ball contact reference must run",
              );
            assert(capture.query.every((p) => p.valid && !p.unknown));
            assert(
              row.linearNRMSE <= report.limits.linearNRMSE,
              `curve display E NRMSE ${row.linearNRMSE}`,
            );
            assert(
              row.queryNRMSE <= report.limits.queryNRMSE,
              `independent curve query NRMSE ${row.queryNRMSE}`,
            );
            if (scenario === "black")
              assert(
                c.points.every(
                  (p) =>
                    p.raw.every((x) => x === 0) && p.E.every((x) => x === 0),
                ),
              );
            row.status = "passed";
          } catch (e) {
            row.status = "failed";
            row.error = String(e);
            report.failures.push({
              count,
              scenario,
              seed,
              view,
              error: String(e),
            });
          }
          if (seed === 0) {
            await page.screenshot({
              path: `${out}/curve-${count}-${view}-${scenario}.png`,
            });
            if (scenario === "day") {
              for (const [mode, label] of [
                [13, "raw-E"],
                [14, "filtered-E"],
                [20, "Ng-Ns-angle"],
                [15, "FG-weight"],
                [17, "fallback"],
                ...(contact
                  ? [
                      [6, "forward-shadow"],
                      [7, "forward-direct-sun"],
                      [3, "emission"],
                      [2, "indirect-diffuse"],
                      [4, "E-used"],
                    ]
                  : []),
              ]) {
                await page.evaluate((mode) => {
                  ballPool.scene.lumen.finalGather.freezeSampling = true;
                  ballPool.scene.lumen.debugMode = mode;
                  ballPool.widget.render();
                }, mode);
                await page.screenshot({
                  path: `${out}/curve-${count}-${view}-${label}.png`,
                });
              }
              await page.evaluate(() => {
                ballPool.scene.lumen.finalGather.freezeSampling = false;
                ballPool.scene.lumen.debugMode = 0;
              });
            }
          }
          console.log(
            JSON.stringify({
              count,
              scenario,
              seed,
              coverage: c.meanWeight,
              E: row.linearNRMSE,
              query: row.queryNRMSE,
            }),
          );
        }
      }
    }
    report.backends ??= [];
    report.backends.push(
      await page.evaluate(async () => {
        const d = ballPool,
          f = d.scene.lumen.finalGather,
          w = d.world,
          rows = [];
        let baseline;
        d.widget.useDefaultRenderLoop = true;
        await d.relight({
          sunRadiance: [2, 2, 2],
          skyRadiance: [0.15, 0.18, 0.22],
        });
        d.widget.useDefaultRenderLoop = false;
        for (const execution of ["split", "fused4", "fused8"]) {
          await f.configure({
            execution,
            seed: 19,
            sequenceEpoch: 5,
            reconstruction: false,
          });
          d.widget.render();
          const fb = f.ping.find((p) => p.texture === f.texture).framebuffer,
            a = w._read(fb, f.resultSize.x, f.resultSize.y);
          baseline ??= a;
          let delta = 0,
            invalid = 0;
          for (let i = 0; i < a.length; i++) {
            if (i % 4 === 3) {
              if (a[i] !== baseline[i]) invalid++;
            } else delta = Math.max(delta, Math.abs(a[i] - baseline[i]));
          }
          rows.push({
            execution,
            delta,
            invalid,
            samples: f.samples,
            epoch: f.metrics.sampleEpoch,
            receiver: f.metrics.resolution,
          });
        }
        return rows;
      }),
    );
    assert(
      report.backends
        .at(-1)
        .every((r) => r.delta <= report.limits.backendDelta && r.invalid === 0),
    );
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.renderErrors, []);
  assert(
    report.failures.length === 0,
    `${report.failures.length}/${report.rows.length} curved cases failed; full region and original point data retained`,
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
} finally {
  await browser.close();
  await writeFile(out + "/curved.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    rows: report.rows.length,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
