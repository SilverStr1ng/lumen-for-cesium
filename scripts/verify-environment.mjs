import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DDGI } from "../lumen/ddgi.js";
import { BVH } from "../lumen/bvh.js";
import { octDecode } from "../lumen/math.js";
import { completeTraceDistance } from "../lumen/trace-domain.js";

const report = { tolerance: 0.025, checks: [], status: "failed" };
try {
  const empty = {
    geometry: {
      bounds: [0, 0, 0, 1, 1, 1],
      materials: [],
      materialIds: [],
      positions: [],
      uvs: [],
      normals: [],
    },
    stats: {},
    trace: () => ({ status: "Miss", distance: 100 }),
  };
  const solver = new DDGI(empty, {
    spacing: 2,
    rays: 256,
    traversalBudget: 1000,
  });
  await solver.initialize(
    () => {},
    () => false,
  );
  for (const mode of ["sphere", "upper-hemisphere"]) {
    await solver.solve(
      {
        sunDirection: [0, 0, 1],
        sunRadiance: [0, 0, 0],
        skyRadiance: [1, 1, 1],
        bounces: 2,
        environmentMode: mode,
      },
      () => {},
      () => false,
      () => {},
    );
    let maximumError = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const n = octDecode((x + 0.5) / 4 - 1, (y + 0.5) / 4 - 1);
        const expected = Math.PI * (mode === "sphere" ? 1 : (1 + n[2]) / 2);
        const offset = ((y + 1) * solver.grid.width + x + 1) * 4;
        maximumError = Math.max(
          maximumError,
          Math.abs(solver.field.irradiance[offset] - expected),
        );
      }
    assert.ok(maximumError < report.tolerance, `${mode} analytic irradiance`);
    assert.equal(solver.history[0].energy, solver.history[1].energy);
    report.checks.push({
      name: `${mode}: analytic directional irradiance; no energy growth`,
      maximumError,
      passed: true,
    });
  }
  const geometry = {
    positions: new Float32Array([200, -2, -2, 200, 2, -2, 200, 0, 2]),
    bounds: [200, -2, -2, 200, 2, 2],
  };
  const bvh = new BVH(geometry);
  const maximum = completeTraceDistance(geometry.bounds, [0, 0, 0]);
  assert.equal(bvh.trace([0, 0, 0], [1, 0, 0]).status, "Miss");
  const full = bvh.trace([0, 0, 0], [1, 0, 0], { maxDistance: maximum });
  assert.equal(full.status, "Hit");
  assert.equal(full.distance, 200);
  assert.equal(completeTraceDistance([0, 0, 0, 1, 1, 1], [0, 0, 0]), 100);
  report.checks.push({
    name: "root domain includes 200m blocker and retains historical 100m floor",
    maximum,
    full,
    passed: true,
  });
  report.status = "passed";
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
}
const output =
  process.env.LUMEN_REPORT ?? "reports/globe-visibility-v3/environment.json";
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
