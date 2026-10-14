import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
import { surfaceRadianceLayout } from "../lumen/surface-radiance-layout.js";
import { materialAt, accepts } from "../lumen/gltf.js";
import { referenceSpawn } from "../lumen/ray-spawn.js";
import { normalize, dot } from "../lumen/math.js";
import { completeTraceDistance } from "../lumen/trace-domain.js";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/cache-first";
await mkdir(out, { recursive: true });
const baseline = JSON.parse(
    await readFile(
      "reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved.json",
      "utf8",
    ),
  ),
  browser = await launchBrowser(),
  report = {
    version: sourceVersion(["scripts/verify-contact-cache.mjs"]),
    rows: [],
    errors: [],
    recommended: false,
  };
const counts = (process.env.LUMEN_CACHE_COUNTS ?? "1,2").split(",").map(Number);
try {
  for (const count of counts) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") report.errors.push(m.text());
    });
    await page.goto(
      `http://localhost:8090/demo/ballpool.html?diagnostic=1&count=${count}&camera=contact`,
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
    for (const depth of [1, 2, 3]) {
      await page.evaluate(async (depth) => {
        ballPool.widget.useDefaultRenderLoop = true;
        await ballPool.relight({ bounces: depth });
      }, depth);
      const started = performance.now();
      await page.evaluate(() => ballPool.setRadianceSource("cache"));
      await page.waitForFunction(
        () =>
          ballPool.world.surfaceCache?.ready ||
          document.getElementById("sourceState").textContent.includes("回退"),
        null,
        { timeout: 180000 },
      );
      const ready = await page.evaluate(
        () => ballPool.world.surfaceCache?.ready === true,
      );
      assert(ready, "candidate actually built");
      await page.waitForFunction(
        () => ballPool.world.surfaceCache.metrics.pendingQueries === 0,
        null,
        { timeout: 10000 },
      );
      const row = {
        count,
        depth,
        wallMilliseconds: performance.now() - started,
        resource: await page.evaluate(() => ballPool.snapshot().resources),
        cache: await page.evaluate(() => ({
          ...ballPool.world.surfaceCache.metrics,
        })),
      };
      const old = baseline.rows.find(
        // Freeze the original regional point lists; do not select candidate winners.
        (r) =>
          r.count === count &&
          r.scenario === "day" &&
          r.seed === 0 &&
          r.view === "contact",
      );
      row.regions = {};
      row.cacheValidity = await page.evaluate(() => {
        const c = ballPool.world.surfaceCache,
          w = ballPool.world,
          fb = c.images.find((r) => r.texture === c.texture).fb,
          a = w._read(fb, c.texture.width, c.texture.height);
        let valid = 0,
          unknown = 0,
          missing = 0;
        for (let i = 0; i < c.metrics.count; i++) {
          if (a[i * 4 + 3] > 0.5) valid++;
          else if (a[i * 4 + 3] < 0) unknown++;
          else missing++;
        }
        return { valid, unknown, missing, total: c.metrics.count };
      });
      const sourcePoints = await page.evaluate(() => {
        const w = ballPool.world,
          c = w.surfaceCache,
          fb = c.images.find((r) => r.texture === c.texture).fb,
          a = w._read(fb, c.texture.width, c.texture.height);
        return {
          order: Array.from(w._order),
          samples: Array.from({ length: 24 }, (_, i) => {
            const index = Math.min(
              c.metrics.count - 1,
              Math.floor((i * c.metrics.count) / 24),
            );
            return {
              index,
              radiance: Array.from(a.slice(index * 4, index * 4 + 3)),
              valid: a[index * 4 + 3],
            };
          }),
        };
      });
      const layout = surfaceRadianceLayout(
        { geometry, order: sourcePoints.order },
        { spacing: 0.08 },
      );
      row.surfaceReference = sourcePoints.samples.map(
        ({ index, radiance, valid }) => {
          const o = index * 4,
            triangle = sourcePoints.order[layout.samples.data[o] - 2],
            u = layout.samples.data[o + 1],
            v = layout.samples.data[o + 2],
            m = materialAt(geometry, triangle, u, v),
            normal = m.normal,
            position = [0, 1, 2].map(
              (k) =>
                geometry.positions[triangle * 9 + k] * (1 - u - v) +
                geometry.positions[triangle * 9 + 3 + k] * u +
                geometry.positions[triangle * 9 + 6 + k] * v,
            ),
            lighting = {
              sunDirection: normalize([-0.8, 0.6, 1.1]),
              sunRadiance: [2, 2, 2],
              skyRadiance: [0.15, 0.18, 0.22],
              bounces: depth - 1,
              environmentMode: "upper-hemisphere",
              rayOriginPolicy: "physical",
            },
            solar = referenceSpawn(
              geometry.positions,
              triangle,
              u,
              v,
              normal,
              lighting.sunDirection,
            ),
            shadow = bvh.trace(solar, lighting.sunDirection, {
              ignore: triangle,
              tMin: 0,
              accept: (t, u, v) => accepts(geometry, t, u, v),
              maxDistance: completeTraceDistance(geometry.bounds, solar),
            }),
            indirect =
              depth > 1
                ? referenceIrradiance(
                    bvh,
                    position,
                    normal,
                    lighting,
                    8192,
                    1019 + index,
                    normal,
                    { triangle, u, v },
                  )
                : { irradiance: [0, 0, 0], standardError: [0, 0, 0] },
            reference = indirect.irradiance.map(
              (E, k) =>
                m.emissive[k] +
                (m.albedo[k] *
                  (E +
                    (shadow.status === "Miss"
                      ? lighting.sunRadiance[k] *
                        Math.max(0, dot(normal, lighting.sunDirection))
                      : 0))) /
                  Math.PI,
            );
          return {
            index,
            triangle,
            u,
            v,
            position,
            normal,
            radiance,
            valid,
            reference,
            referenceStandardError: indirect.standardError.map(
              (v, k) => (v * m.albedo[k]) / Math.PI,
            ),
            shadow,
          };
        },
      );
      row.surfacePointNRMSE = Math.sqrt(
        row.surfaceReference.reduce(
          (s, r) =>
            s +
            r.radiance.reduce((a, v, k) => a + (v - r.reference[k]) ** 2, 0),
          0,
        ) /
          Math.max(
            0.00001,
            row.surfaceReference.reduce(
              (s, r) => s + r.reference.reduce((a, v) => a + v * v, 0),
              0,
            ),
          ),
      );
      for (const [name, data] of Object.entries(old?.regionErrors ?? {})) {
        if (!data.points.length) continue;
        const refs = data.points.map((p, i) =>
          referenceIrradiance(
            bvh,
            p.position,
            p.normal,
            {
              sunDirection: [-0.8, 0.6, 1.1],
              sunRadiance: [2, 2, 2],
              skyRadiance: [0.15, 0.18, 0.22],
              bounces: depth,
              environmentMode: "upper-hemisphere",
              rayOriginPolicy: "physical",
            },
            8192,
            5019 + i,
            p.geometricNormal,
          ),
        );
        const values = await page.evaluate(async (points) => {
          ballPool.widget.useDefaultRenderLoop = false;
          return await ballPool.world.sampleFinalGather(points, {
            samples: 1024,
            seed: 0,
            sampling: "reconstructed",
            epoch: 31,
          });
        }, data.points);
        const nrmse = Math.sqrt(
          values.reduce(
            (s, v, i) =>
              s +
              v.irradiance.reduce(
                (a, x, k) => a + (x - refs[i].irradiance[k]) ** 2,
                0,
              ),
            0,
          ) /
            Math.max(
              0.00001,
              refs.reduce(
                (s, r) => s + r.irradiance.reduce((a, x) => a + x * x, 0),
                0,
              ),
            ),
        );
        row.regions[name] = {
          points: data.points,
          reference: refs,
          query: values,
          nrmse,
        };
      }
      row.status =
        row.surfacePointNRMSE <= 0.12 &&
        row.cacheValidity.unknown === 0 &&
        row.cacheValidity.missing === 0 &&
        Object.values(row.regions).every(
          (r) => r.nrmse <= 0.12 && r.query.every((q) => q.valid && !q.unknown),
        )
          ? "passed"
          : "failed";
      report.rows.push(row);
      console.log(
        JSON.stringify({
          count,
          depth,
          cache: row.cache,
          status: row.status,
          regions: Object.fromEntries(
            Object.entries(row.regions).map(([k, r]) => [k, r.nrmse]),
          ),
        }),
      );
      await page.evaluate(() => {
        ballPool.widget.useDefaultRenderLoop = true;
        return ballPool.setRadianceSource("immediate");
      });
    }
    await page.screenshot({ path: out + `/cache-${count}.png` });
    await page.close();
  }
} catch (e) {
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser.close();
}
report.status =
  report.errors.length || report.rows.some((r) => r.status !== "passed")
    ? "failed"
    : "passed";
await writeFile(out + "/surface-cache.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
if (report.status !== "passed") process.exitCode = 1;
