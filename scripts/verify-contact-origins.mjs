import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { BVH } from "../lumen/bvh.js";
// Analytic plane intersection derives physical visibility without either spawn policy.
const rows = [];
for (const scale of [0.1, 1, 10])
  for (const translation of [0, 10, 100])
    for (const gap of [0.001, 0.01, 0.02]) {
      const point = [translation, 0, 0],
        direction = [0, 0, 1],
        planeZ = gap * scale,
        physicalDistance = planeZ - point[2],
        legacyOrigin = [point[0], 0, 0.015],
        legacyDistance = planeZ - legacyOrigin[2],
        positions = new Float32Array([
          translation - scale,
          -scale,
          planeZ,
          translation + scale,
          -scale,
          planeZ,
          translation,
          scale,
          planeZ,
        ]),
        bvh = new BVH({ positions }),
        legacy = bvh.trace(legacyOrigin, direction, { tMin: 0 });
      assert(physicalDistance > 0);
      assert.equal(legacy.status, legacyDistance > 0 ? "Hit" : "Miss");
      rows.push({
        scale,
        translation,
        gap,
        physicalDistance,
        legacyDistance,
        legacy: legacy.status,
        physical: "Hit",
      });
    }
assert(rows.some((r) => r.legacy === "Miss"));
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/origin-legacy";
await mkdir(out, { recursive: true });
await writeFile(
  out + "/ray-origin.json",
  JSON.stringify(
    {
      status: "passed",
      purpose:
        "Independent analytic red counterexamples; legacy is physically wrong in recorded narrow gaps",
      rows,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  "Independent plane counterexamples pinned; legacy misses real blockers",
);
