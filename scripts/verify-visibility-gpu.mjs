import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, environment, sourceVersion } from "./browser-tools.mjs";
const report = {
  startedAt: new Date().toISOString(),
  version: sourceVersion(["lumen/bvh.js"]),
  mode: "numerical readback only; not a performance run",
  tolerance: { absolute: 2e-4, relative: 1e-3 },
  runs: [],
  errors: [],
};
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  for (const fixture of ["untextured", "alpha-mask", "two-rooms"]) {
    await page.goto(
      `http://localhost:8090/demo/regression.html?fixture=${fixture}`,
    );
    await page.waitForFunction(
      () =>
        window.lumenTest?.world?.status === "ready" ||
        window.lumenTest?.errors.length,
      null,
      { timeout: 180000 },
    );
    assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
    report.environment = await environment(page, browser);
    const result = await page.evaluate(async () => {
      const d = lumenTest,
        results = [];
      let reference;
      const { loadGeometry } = await import("/lumen/gltf.js");
      const geometry = await loadGeometry(
        d.world.options.url,
        d.world.options.axisMatrix,
      );
      let seed = 421;
      const random = () =>
        (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
      const rays = Array.from({ length: 512 }, () => {
        const direction = [random() - 0.5, random() - 0.5, random() - 0.5],
          l = Math.hypot(...direction);
        return {
          origin: geometry.bounds
            .slice(0, 3)
            .map((v, i) => v - 1 + random() * (geometry.bounds[i + 3] - v + 2)),
          direction: direction.map((v) => v / l),
          maxDistance: 1000,
        };
      });
      for (const strategy of ["median", "sah"])
        for (const mode of ["reference", "optimized"]) {
          const w = d.load({
            bvhStrategy: strategy,
            bvhBins: 12,
            visibilityMode: mode,
          });
          await w.completed;
          const runs = [];
          for (const sunDirection of [
            [1, 0, 0.65],
            [-1, 0.1, 0.65],
            [1e-12, -1, 0.5],
          ]) {
            await w.solve({ sunDirection });
            const g = w.packet.grid;
            runs.push({
              visibility: Array.from(
                w._read(
                  w._visibilityFB,
                  g.rays,
                  g.total,
                  0,
                  Cesium.PixelDatatype.UNSIGNED_BYTE,
                ),
              ),
              irradiance: Array.from(w.snapshot().irradiance),
            });
          }
          if (!reference) reference = runs;
          let maxE = 0,
            maxVisibility = 0,
            failures = 0;
          for (let r = 0; r < runs.length; r++)
            for (const key of ["visibility", "irradiance"])
              for (let i = 0; i < runs[r][key].length; i++) {
                const a = runs[r][key][i],
                  b = reference[r][key][i],
                  delta = Math.abs(a - b);
                if (key === "visibility")
                  maxVisibility = Math.max(maxVisibility, delta);
                else maxE = Math.max(maxE, delta);
                if (
                  !Number.isFinite(delta) ||
                  delta > 2e-4 + 1e-3 * Math.abs(b)
                )
                  failures++;
              }
          const g = w.packet.grid;
          w._diagnosticBudget = 1;
          w._draw("visibility", w._visibilityFB, 0, 0, g.rays, g.total);
          w._diagnosticBudget = undefined;
          const low = w._read(
            w._visibilityFB,
            g.rays,
            g.total,
            0,
            Cesium.PixelDatatype.UNSIGNED_BYTE,
          );
          let unknown = 0;
          for (let i = 0; i < low.length; i += 4)
            if (low[i + 2] === 255 && low[i + 1] === 0) {
              unknown++;
              if (low[i] !== 0) failures++;
            }
          // Reproduce actual production sun origins from cached hits; query statistics
          // are a separate diagnostic run and never pollute production timing.
          const hits = w._read(w._hitFB, g.rays, g.total),
            sunRays = [];
          const directVisibility = runs.at(-1).visibility;
          for (let i = 0; i < hits.length; i += 4)
            if (directVisibility[i + 2] === 255) {
              const t = w._order[Math.abs(hits[i]) - 2],
                p = geometry.positions;
              const a = Array.from(p.slice(t * 9, t * 9 + 3)),
                b = Array.from(p.slice(t * 9 + 3, t * 9 + 6)),
                c = Array.from(p.slice(t * 9 + 6, t * 9 + 9));
              const e = b.map((v, k) => v - a[k]),
                f = c.map((v, k) => v - a[k]),
                n = [
                  e[1] * f[2] - e[2] * f[1],
                  e[2] * f[0] - e[0] * f[2],
                  e[0] * f[1] - e[1] * f[0],
                ],
                scale = (hits[i] < 0 ? -1 : 1) / Math.hypot(...n);
              const origin = a.map(
                (v, k) =>
                  v * (1 - hits[i + 1] - hits[i + 2]) +
                  b[k] * hits[i + 1] +
                  c[k] * hits[i + 2] +
                  n[k] * scale * 0.015,
              );
              const direction = [1e-12, -1, 0.5],
                length = Math.hypot(...direction);
              sunRays.push({
                origin,
                direction: direction.map((v) => v / length),
                ignore: t,
                maxDistance: 1000,
              });
            }
          const sunStatistics = [];
          for (let i = 0; i < sunRays.length; i += 1024)
            sunStatistics.push(
              ...(await w.trace(sunRays.slice(i, i + 1024), {
                anyHit: true,
                statistics: true,
              })),
            );
          const sunSummary = {
            rays: sunRays.length,
            hit: sunStatistics.filter((s) => s.status === "Hit").length,
            miss: sunStatistics.filter((s) => s.status === "Miss").length,
            unknown: sunStatistics.filter((s) => s.status === "Unknown").length,
          };
          for (const key of ["nodeVisits", "triangleTests", "alphaTests"]) {
            const values = sunStatistics
              .map((s) => s[key])
              .sort((a, b) => a - b);
            sunSummary[key] = {
              sum: values.reduce((a, b) => a + b, 0),
              p50: values[Math.floor(values.length * 0.5)] ?? 0,
              p95: values[Math.floor(values.length * 0.95)] ?? 0,
              max: values.at(-1) ?? 0,
            };
          }
          const cpu = await w.referenceTrace(rays),
            nearest = await w.trace(rays),
            any = await w.trace(rays, { anyHit: true }),
            statistics = await w.trace(rays, {
              anyHit: true,
              statistics: true,
            });
          for (let i = 0; i < rays.length; i++) {
            if (
              cpu[i].status !== nearest[i].status ||
              cpu[i].status !== any[i].status ||
              statistics[i].status !== any[i].status
            )
              failures++;
            if (
              cpu[i].status === "Hit" &&
              Math.abs(cpu[i].distance - nearest[i].distance) > 2e-4
            )
              failures++;
          }
          const distribution = {};
          for (const key of ["nodeVisits", "triangleTests", "alphaTests"]) {
            const values = statistics.map((s) => s[key]).sort((a, b) => a - b);
            distribution[key] = {
              sum: values.reduce((a, b) => a + b, 0),
              p50: values[256],
              p95: values[486],
              max: values.at(-1),
            };
          }
          results.push({
            strategy,
            mode,
            maxE,
            maxVisibility,
            failures,
            budgetUnknown: unknown,
            sunSummary,
            sunStatistics,
            bvh: w.packet.bvh,
            distribution,
            statistics,
            rays,
          });
        }
      return results;
    });
    report.runs.push({ fixture, result });
    assert.ok(
      result.every((x) => x.failures === 0),
      JSON.stringify(result),
    );
    console.log(
      fixture,
      JSON.stringify(
        result.map(
          ({ statistics, rays, sunStatistics, ...summary }) => summary,
        ),
      ),
    );
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  process.exitCode = 1;
  console.error(e);
} finally {
  await mkdir("reports/globe-visibility-v3", { recursive: true });
  await writeFile(
    `reports/globe-visibility-v3/visibility-gpu-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    "reports/globe-visibility-v3/visibility-gpu.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
