import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createBallPool, ballPoolGltf } from "../lumen/ballpool-scene.js";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
import { normalize } from "../lumen/math.js";
const rows = [],
  lighting = {
    sunDirection: [-0.8, 0.6, 1.1],
    sunRadiance: [2, 2, 2],
    skyRadiance: [0.15, 0.18, 0.22],
    bounces: 3,
    environmentMode: "upper-hemisphere",
  };
for (const segments of [16, 24, 48]) {
  const d = createBallPool({ count: 2, segments }),
    gltf = ballPoolGltf(d).gltf,
    g = await loadGeometry(
      `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`,
    ),
    bvh = new BVH(g, { strategy: "sah" }),
    points = [];
  for (const direction of [
    [0, 0, 1],
    [0.6, 0, 0.8],
    [-0.6, 0, 0.8],
    [0, -0.8, 0.6],
  ]) {
    const ns = normalize(direction),
      center = d.balls[0].position,
      origin = center.map((v, k) => v + ns[k] * 0.8),
      incoming = ns.map((x) => -x),
      h = bvh.trace(origin, incoming);
    assert(h.status === "Hit");
    const p = origin.map((v, k) => v + incoming[k] * h.distance),
      ng = Array.from(g.normals.slice(h.triangle * 3, h.triangle * 3 + 3));
    points.push({
      p,
      ns,
      ng,
      radiusError: Math.abs(
        Math.hypot(...p.map((v, k) => v - center[k])) - 0.34,
      ),
      reference: referenceIrradiance(bvh, p, ns, lighting, 16384, 19, ng),
    });
  }
  rows.push({ segments, triangles: g.positions.length / 9, points });
}
const high = rows.at(-1);
for (const row of rows) {
  row.relativeDifference = Math.sqrt(
    row.points.reduce(
      (s, p, i) =>
        s +
        p.reference.irradiance.reduce(
          (a, x, k) => a + (x - high.points[i].reference.irradiance[k]) ** 2,
          0,
        ),
      0,
    ) /
      high.points.reduce(
        (s, p) => s + p.reference.irradiance.reduce((a, x) => a + x * x, 0),
        0,
      ),
  );
  assert(row.relativeDifference <= 0.2);
}
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/topology-first";
await mkdir(out, { recursive: true });
await writeFile(
  out + "/topology.json",
  JSON.stringify(
    {
      status: "passed",
      scope:
        "receiver Ns/Ng plus triangle-Ng Lambert hit approximation, low/default/high actual geometry",
      rows,
    },
    null,
    2,
  ),
);
console.log(
  rows.map((r) => ({ segments: r.segments, error: r.relativeDifference })),
);
