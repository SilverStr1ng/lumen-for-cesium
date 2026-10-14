import assert from "node:assert/strict";
import { createBallPool, ballPoolGltf } from "../lumen/ballpool-scene.js";
import { BallPoolPhysics } from "../demo/ballpool-physics.js";
import { loadGeometry } from "../lumen/gltf.js";
import { mkdir, writeFile } from "node:fs/promises";
const rows = [];
for (const count of [1, 2, 16, 64, 128]) {
  const d = createBallPool({ count }),
    { gltf, bufferBytes, triangles } = ballPoolGltf(d),
    url = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`,
    g = await loadGeometry(url);
  assert.equal(g.positions.length / 9, triangles);
  assert.equal(new Set(d.balls.map((b) => b.ballId)).size, count);
  assert.equal(
    gltf.nodes.filter((n) => n.name.startsWith("ball-")).length,
    count,
  );
  assert.deepEqual(d, createBallPool({ count }));
  let outward = 0;
  for (let i = d.container.length * 12; i < g.normals.length / 3; i++) {
    const ball =
        d.balls[
          Math.floor((i - d.container.length * 12) / (24 * (12 - 1) * 2))
        ],
      p = [0, 1, 2].map(
        (k) =>
          (g.positions[i * 9 + k] +
            g.positions[i * 9 + 3 + k] +
            g.positions[i * 9 + 6 + k]) /
            3 -
          ball.position[k],
      );
    assert(
      p.reduce((s, x, k) => s + x * g.normals[i * 3 + k], 0) > 0,
      "sphere winding must be outward",
    );
    outward++;
  }
  const a = await BallPoolPhysics.create(structuredClone(d)),
    b = await BallPoolPhysics.create(structuredClone(d));
  a.wake();
  b.wake();
  a.toss(1);
  b.toss(1);
  for (let i = 0; i < 180; i++) {
    a.step();
    b.step();
  }
  assert(
    JSON.stringify(a.descriptor.balls) === JSON.stringify(b.descriptor.balls),
    `same runtime fixed step must reproduce ${count} ball poses`,
  );
  assert(
    a.descriptor.balls.some(
      (v, i) =>
        Math.hypot(...v.position.map((x, k) => x - d.balls[i].position[k])) >
        0.05,
    ),
  );
  assert(
    a.descriptor.balls.every(
      (v) => v.position.every(Number.isFinite) && v.position[2] > -0.5,
    ),
  );
  rows.push({ count, triangles, bufferBytes, outward, physics: a.metrics() });
  a.destroy();
  b.destroy();
}
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/initial";
await mkdir(out, { recursive: true });
await writeFile(
  out + "/descriptor-physics.json",
  JSON.stringify({ status: "passed", rows }, null, 2),
);
console.log(
  "shared display/physics/GI descriptors and reproducible Rapier steps passed",
  rows.map((r) => [r.count, r.triangles]),
);
