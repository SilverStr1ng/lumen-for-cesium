import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const browser = await launchBrowser(),
  report = {
    startedAt: new Date().toISOString(),
    version: sourceVersion(["lumen/bvh.js"]),
    mode: "diagnostic readbacks; not performance",
    errors: [],
  };
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(
    "http://localhost:8090/demo/index.html?backend=gpu&publication=progressive",
  );
  await page.waitForFunction(
    () =>
      window.lumenDemo?.scene.lumen.world?.status === "ready" ||
      window.lumenDemo?.errors.length,
    null,
    { timeout: 600000 },
  );
  report.result = await page.evaluate(async () => {
    const d = lumenDemo,
      initial = d.scene.lumen.world,
      base = { ...initial.options },
      sunDirection = [0.1, -1, 0.65];
    const first =
      initial.options.bvhStrategy === "median" &&
      initial.options.visibilityMode === "reference"
        ? initial
        : d.scene.lumen.loadWorld({
            ...base,
            bvhStrategy: "median",
            visibilityMode: "reference",
          });
    await first.completed;
    const { loadGeometry } = await import("/lumen/gltf.js");
    const geometry = await loadGeometry(base.url, base.axisMatrix);
    const read = (w) => {
      const g = w.packet.grid;
      return {
        grid: g,
        hits: w._read(w._hitFB, g.rays, g.total),
        positions: w.snapshot().positions,
        E: w.snapshot().irradiance,
        visibility: w._read(
          w._visibilityFB,
          g.rays,
          g.total,
          0,
          Cesium.PixelDatatype.UNSIGNED_BYTE,
        ),
        order: w._order.slice(),
      };
    };
    const directions = [
        [1, 0, 0.65],
        [-1, 0.1, 0.65],
        [0.1, -1, 0.65],
      ],
      references = [];
    for (const direction of directions) {
      await first.solve({ sunDirection: direction });
      references.push(read(first));
    }
    const a = references.at(-1);
    await first.solve({
      sunDirection: [1, 0, 0.65],
      visibilityMode: "optimized",
    });
    await first.solve({ sunDirection, visibilityMode: "optimized" });
    for (let i = 0; i < 120 && first._queries.length; i++)
      await new Promise(requestAnimationFrame);
    const c = read(first);
    let cMaxE = 0,
      cFailures = 0,
      cVisibilityDifferences = 0;
    for (let i = 0; i < a.E.length; i++) {
      const delta = Math.abs(a.E[i] - c.E[i]);
      cMaxE = Math.max(cMaxE, delta);
      if (delta > 2e-4 + 1e-3 * Math.abs(a.E[i])) cFailures++;
    }
    for (let i = 0; i < a.visibility.length; i++)
      if (a.visibility[i] !== c.visibility[i]) cVisibilityDifferences++;
    const medianOptimized = {
      maxE: cMaxE,
      failures: cFailures,
      visibilityDifferences: cVisibilityDifferences,
      metrics: structuredClone(first.metrics.updates.at(-1)),
    };
    const second = d.scene.lumen.loadWorld({
      ...base,
      bvhStrategy: "sah",
      bvhBins: 12,
      visibilityMode: "optimized",
    });
    await second.completed;
    const directionalComparisons = [];
    let b;
    for (let index = 0; index < directions.length; index++) {
      await second.solve({ sunDirection: directions[index] });
      b = read(second);
      const reference = references[index];
      let maxE = 0,
        failures = 0,
        visibilityDifferences = 0;
      for (let i = 0; i < reference.E.length; i++) {
        const delta = Math.abs(reference.E[i] - b.E[i]);
        maxE = Math.max(maxE, delta);
        if (delta > 2e-4 + 1e-3 * Math.abs(reference.E[i])) failures++;
      }
      for (let i = 0; i < reference.visibility.length; i++)
        if (reference.visibility[i] !== b.visibility[i])
          visibilityDifferences++;
      directionalComparisons.push({
        sunDirection: directions[index],
        maxE,
        failures,
        visibilityDifferences,
      });
    }
    const hitInfo = (state, i) => {
      const h = Array.from(state.hits.slice(i, i + 4)),
        triangle = state.order[Math.abs(h[0]) - 2];
      return {
        h,
        triangle,
        material: geometry.materialIds[triangle],
        vertices: Array.from(
          geometry.positions.slice(triangle * 9, triangle * 9 + 9),
        ),
        uv: Array.from(geometry.uvs.slice(triangle * 6, triangle * 6 + 6)),
      };
    };
    const differences = [],
      visibilityDifferences = [];
    let differentHits = 0,
      deltaDistance = 0;
    for (let i = 0; i < a.hits.length; i += 4) {
      const ta = a.order[Math.abs(a.hits[i]) - 2],
        tb = b.order[Math.abs(b.hits[i]) - 2];
      if (ta !== tb || Math.sign(a.hits[i]) !== Math.sign(b.hits[i])) {
        differentHits++;
        if (differences.length < 100)
          differences.push({ slot: i / 4, a: hitInfo(a, i), b: hitInfo(b, i) });
      }
      deltaDistance = Math.max(
        deltaDistance,
        Math.abs(a.hits[i + 3] - b.hits[i + 3]),
      );
    }
    for (let i = 0; i < a.visibility.length; i += 4)
      if (
        a.visibility.slice(i, i + 4).some((v, k) => v !== b.visibility[i + k])
      ) {
        const slot = i / 4,
          probe = Math.floor(slot / a.grid.rays),
          ray = slot % a.grid.rays,
          z = 1 - (2 * (ray + 0.5)) / a.grid.rays,
          angle = ray * 2.399963229728653,
          r = Math.sqrt(Math.max(0, 1 - z * z));
        visibilityDifferences.push({
          slot,
          origin: Array.from(a.positions.slice(probe * 4, probe * 4 + 3)),
          direction: [Math.cos(angle) * r, Math.sin(angle) * r, z],
          a: hitInfo(a, i),
          b: hitInfo(b, i),
          visibilityA: Array.from(a.visibility.slice(i, i + 4)),
          visibilityB: Array.from(b.visibility.slice(i, i + 4)),
        });
      }
    let maxE = 0,
      failures = 0;
    for (let i = 0; i < a.E.length; i++) {
      const delta = Math.abs(a.E[i] - b.E[i]);
      maxE = Math.max(maxE, delta);
      if (delta > 2e-4 + 1e-3 * Math.abs(a.E[i])) failures++;
    }
    return {
      medianOptimized,
      directionalComparisons,
      differentHits,
      deltaDistance,
      maxE,
      failures,
      differences,
      visibilityDifferences,
    };
  });
  for (const direction of report.result.directionalComparisons) {
    assert.equal(direction.maxE, 0);
    assert.equal(direction.failures, 0);
    assert.equal(direction.visibilityDifferences, 0);
  }
  assert.equal(
    report.result.differentHits,
    0,
    "Original median nearest-hit identity including exact-distance ties",
  );
  assert.equal(report.result.deltaDistance, 0);
  assert.equal(report.result.maxE, 0);
  assert.equal(report.result.failures, 0);
  assert.equal(report.result.visibilityDifferences.length, 0);
  assert.equal(report.result.medianOptimized.maxE, 0);
  assert.equal(report.result.medianOptimized.visibilityDifferences, 0);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(
    JSON.stringify({
      medianOptimized: report.result.medianOptimized,
      differentHits: report.result.differentHits,
      deltaDistance: report.result.deltaDistance,
      maxE: report.result.maxE,
      failures: report.result.failures,
      visibilityDifferences: report.result.visibilityDifferences,
    }),
  );
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ??
      "reports/globe-visibility-v3/visibility-sponza-diagnosis.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
