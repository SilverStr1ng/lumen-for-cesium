import { mkdir, readFile, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion, environment } from "./browser-tools.mjs";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { ProbeField } from "../lumen/ddgi.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
import {
  receiverRays,
  oracleRemainder,
  integrateParts,
} from "../lumen/contact-transport.js";
const policy = process.env.LUMEN_CONTACT_POLICY ?? "legacy-15mm";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/root-cause-legacy";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  report = {
    version: sourceVersion(["scripts/diagnose-contact-transport.mjs"]),
    policy,
    rows: [],
    errors: [],
  };
const baseline = JSON.parse(
  await readFile(
    "reports/ballpool-curved-receivers-v8/acceptance-20261014-final-safe/curved.json",
    "utf8",
  ),
);
try {
  for (const count of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    await page.goto(
      `http://localhost:8090/demo/ballpool.html?diagnostic=1&count=${count}&camera=contact&transport=${policy === "legacy-15mm" ? "legacy" : "bounded"}`,
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
        ballPool.widget.useDefaultRenderLoop = false;
        const f = ballPool.scene.lumen.finalGather;
        await f.configure({
          seed: 0,
          sequenceEpoch: null,
          model: ballPool.model,
          sampling: "reconstructed",
        });
        ballPool.camera("contact");
        f._sampleEpoch = 0;
        for (let i = 0; i < 32; i++) ballPool.widget.render();
      }, depth);
      const reconstruction = await page.evaluate(async () => {
        const { captureCurved } = await import("/demo/curved-diagnostics.js");
        return captureCurved(ballPool, { primary: false });
      });
      const field = await page.evaluate(() => {
        const w = ballPool.world,
          s = w.finalGatherSnapshot;
        return {
          grid: s.grid,
          positions: Array.from(w.snapshot().positions),
          irradiance: Array.from(
            w._read(s.resources[0].fb, s.previous.width, s.previous.height),
          ),
          moments: Array.from(w.snapshot().moments),
        };
      });
      // Probe diagnostics use the same-revision previous complete round, never display E.
      const probe = new ProbeField(
        {
          ...field.grid,
          normalBias: policy === "legacy-15mm" ? field.grid.normalBias : 0,
        },
        Float32Array.from(field.positions),
        Float32Array.from(field.irradiance),
        Float32Array.from(field.moments),
      );
      const old = baseline.rows.find(
        (r) =>
          r.count === count &&
          r.scenario === "day" &&
          r.seed === 0 &&
          r.view === "contact",
      );
      for (const [region, data] of Object.entries(old.regionErrors)) {
        for (const point of data.points) {
          const rays = receiverRays(point, 128, 0, 31),
            diagnostic = await page.evaluate(
              (rays) => ballPool.world.diagnoseTransport(rays),
              rays,
            ),
            lighting = {
              ...(await page.evaluate(() => ({ ...ballPool.lighting }))),
              rayOriginPolicy: policy,
            },
            oracle = oracleRemainder(bvh, diagnostic, lighting, depth),
            ref = referenceIrradiance(
              bvh,
              point.position,
              point.normal,
              { ...lighting, bounces: depth },
              8192,
              5019 + data.points.indexOf(point),
              point.geometricNormal,
            ),
            integrated = integrateParts(rays, diagnostic, oracle, depth);
          const probes = diagnostic.position.map((p, i) =>
            Math.abs(diagnostic.hit[i][0]) > 1
              ? probe?.sample(p.slice(0, 3), diagnostic.normal[i].slice(0, 3), {
                  diagnostics: true,
                })
              : null,
          );
          report.rows.push({
            count,
            depth,
            region,
            point,
            seed: 0,
            epoch: 31,
            samples: rays.length,
            rays,
            diagnostic,
            oracle,
            probes,
            reference: ref,
            reconstruction: {
              regions: reconstruction.regions,
              points: reconstruction.regionPoints[region],
              fallback: reconstruction.fallback,
              revision: reconstruction.revision,
              round: reconstruction.round,
            },
            ...integrated,
          });
          console.log(
            JSON.stringify({
              count,
              depth,
              region,
              instant: integrated.instant,
              oracle: integrated.oracleReplaced,
              reference: ref.irradiance,
            }),
          );
        }
      }
    }
    await page.close();
  }
} catch (e) {
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser.close();
}
report.status = report.errors.length ? "failed" : "measured";
await writeFile(out + "/root-cause.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
if (report.errors.length) process.exitCode = 1;
