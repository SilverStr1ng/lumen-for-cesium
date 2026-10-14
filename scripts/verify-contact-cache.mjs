import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
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
      row.status = Object.values(row.regions).every(
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
