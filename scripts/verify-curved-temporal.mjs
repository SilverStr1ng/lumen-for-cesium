import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/temporal-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 960, height: 600 } }),
  report = {
    version: sourceVersion(["scripts/verify-curved-temporal.mjs"]),
    rows: [],
    windows: [],
    errors: [],
    limit: 0.2,
  };
page.on("pageerror", (e) => report.errors.push(String(e)));
const error = (points, reference) =>
  Math.sqrt(
    points.reduce(
      (s, p, i) =>
        s +
        p.E.reduce((v, x, k) => v + (x - reference[i].irradiance[k]) ** 2, 0),
      0,
    ) /
      Math.max(
        0.00001,
        reference.reduce(
          (s, p) => s + p.irradiance.reduce((v, x) => v + x * x, 0),
          0,
        ),
      ),
  );
try {
  await page.goto(
    "http://localhost:8090/demo/ballpool.html?count=16&camera=close&diagnostic=1",
  );
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  report.environment = await environment(page, browser);
  const gltf = await page.evaluate(
      async () => await (await fetch(ballPool.world.options.url)).json(),
    ),
    geometry = await loadGeometry(
      `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`,
    ),
    bvh = new BVH(geometry, { strategy: "sah" });
  const setup = async (quality, seed) =>
    page.evaluate(
      async ({ quality, seed }) => {
        const f = ballPool.scene.lumen.finalGather;
        ballPool.widget.useDefaultRenderLoop = false;
        f.freezeSampling = false;
        await f.configure({
          quality,
          seed,
          sequenceEpoch: null,
          reconstruction: true,
          sampling: "reconstructed",
          model: ballPool.model,
        });
        f.release();
        f._sampleEpoch = 0;
      },
      { quality, seed },
    );
  const capture = () =>
    page.evaluate(async () => {
      const { captureCurved } = await import("/demo/curved-diagnostics.js");
      const c = captureCurved(ballPool, { primary: false });
      c.points = c.points.slice(0, 24);
      return {
        capture: c,
        lighting: structuredClone(ballPool.lighting),
        frames: ballPool.scene.lumen.finalGather._stableFrames,
      };
    });
  let reference;
  for (const quality of ["auto", "interactive16"])
    for (const seed of [0, 5, 19]) {
      await setup(quality, seed);
      const samples = quality === "auto" ? 32 : 16,
        target = quality === "auto" ? 32 : 64;
      for (let frame = 1; frame <= target; frame++) {
        await page.evaluate(() => ballPool.widget.render());
        if (![1, 4, 8, 16, 32, 64].includes(frame)) continue;
        const c = await capture();
        reference ??= c.capture.points.map((p, i) =>
          referenceIrradiance(
            bvh,
            p.position,
            p.normal,
            c.lighting,
            8192,
            2019 + i,
            p.geometricNormal,
          ),
        );
        const row = {
          quality,
          seed,
          frame,
          effectiveSamples: frame * samples,
          samples,
          frames: c.frames,
          error: error(c.capture.points, reference),
          capture: c.capture,
        };
        report.rows.push(row);
        assert(
          row.frames === frame,
          "history must count distinct actual epochs",
        );
        if (frame === target) {
          assert(row.error <= report.limit);
          assert(c.capture.meanWeight >= 0.95);
        }
      }
      for (const milliseconds of [100, 250, 500, 1000]) {
        await setup(quality, seed);
        const window = await page.evaluate(async (milliseconds) => {
          const f = ballPool.scene.lumen.finalGather,
            before = f.metrics.frames,
            start = performance.now();
          let renders = 0;
          while (performance.now() - start < milliseconds) {
            await new Promise(requestAnimationFrame);
            ballPool.widget.render();
            renders++;
          }
          const elapsed = performance.now() - start,
            actual = f.metrics.frames - before,
            epoch = f.metrics.sampleEpoch,
            { captureCurved } = await import("/demo/curved-diagnostics.js"),
            c = captureCurved(ballPool, { primary: false });
          c.points = c.points.slice(0, 24);
          return {
            requestedMilliseconds: milliseconds,
            elapsedMilliseconds: elapsed,
            renders,
            actualFGFrames: actual,
            epoch,
            capture: c,
          };
        }, milliseconds);
        const row = {
          quality,
          seed,
          ...window,
          error: error(window.capture.points, reference),
          effectiveSamples: window.actualFGFrames * samples,
        };
        report.windows.push(row);
        assert(
          window.actualFGFrames > 0 && window.actualFGFrames <= window.renders,
        );
        assert(window.capture.meanWeight >= 0.95);
        if (milliseconds === 1000) assert(row.error <= report.limit);
        console.log(
          JSON.stringify({
            quality,
            seed,
            milliseconds,
            frames: window.actualFGFrames,
            error: row.error,
          }),
        );
      }
    }
  report.reference = reference;
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
} finally {
  await browser.close();
  await writeFile(
    out + "/curved-temporal.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    rows: report.rows.length,
    windows: report.windows.length,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
