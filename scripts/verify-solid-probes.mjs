import assert from "node:assert/strict";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { DDGI } from "../lumen/ddgi.js";
const geometry = await loadGeometry(
  "http://localhost:8090/fixtures/earth-pavilion.gltf",
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
);
const solver = new DDGI(new BVH(geometry), {
  spacing: 2,
  rays: 128,
  traversalBudget: 4096,
});
await solver.initialize(
  () => {},
  () => false,
);
let activeInside = 0,
  totalInside = 0;
for (let id = 0; id < solver.grid.total; id++) {
  const [x, y, z, state] = solver.positions.slice(id * 4, id * 4 + 4);
  if (x > -12 && x < 12 && y > -9 && y < 9 && z > -1.5 && z < 0) {
    totalInside++;
    if (state >= 0.5) activeInside++;
  }
}
console.log(
  JSON.stringify({ totalInside, activeInside, probes: solver.grid.total }),
);
assert.equal(
  activeInside,
  0,
  "actual pavilion foundation interior must not remain an active black-light probe",
);
console.log(
  "PASS actual glTF -> BVH -> relocation/classification rejects solid interiors",
);
assert.equal(
  totalInside,
  0,
  "touching foundation/floor must escape without cycling",
);
assert.equal(
  solver.positions[213 * 4 + 3],
  1,
  "foundation/floor/column junction has a bounded safe exit",
);

// Real intersections/classification/integration, including an explicitly double-sided solid.
function geometryFor(
  boxes,
  material = {
    doubleSided: true,
    extras: { giSolid: true },
    pbrMetallicRoughness: {
      baseColorFactor: [0.6, 0.6, 0.6, 1],
      metallicFactor: 0,
    },
  },
) {
  const positions = [],
    normals = [];
  for (const [lo, hi] of boxes) {
    const [x, y, z] = lo,
      [X, Y, Z] = hi;
    const faces = [
      [
        [x, y, z],
        [x, Y, z],
        [X, Y, z],
        [X, y, z],
      ],
      [
        [x, y, Z],
        [X, y, Z],
        [X, Y, Z],
        [x, Y, Z],
      ],
      [
        [x, y, z],
        [x, y, Z],
        [x, Y, Z],
        [x, Y, z],
      ],
      [
        [X, y, z],
        [X, Y, z],
        [X, Y, Z],
        [X, y, Z],
      ],
      [
        [x, y, z],
        [X, y, z],
        [X, y, Z],
        [x, y, Z],
      ],
      [
        [x, Y, z],
        [x, Y, Z],
        [X, Y, Z],
        [X, Y, z],
      ],
    ];
    for (const f of faces)
      for (const inds of [
        [0, 1, 2],
        [0, 2, 3],
      ]) {
        const a = f[inds[0]],
          b = f[inds[1]],
          c = f[inds[2]],
          u = b.map((v, i) => v - a[i]),
          v = c.map((v, i) => v - a[i]),
          n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
          ],
          l = Math.hypot(...n);
        positions.push(...a, ...b, ...c);
        normals.push(...n.map((v) => v / l));
      }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: new Float32Array((positions.length / 3) * 2),
    materialIds: new Uint16Array(positions.length / 9),
    materials: [material],
    images: [],
    textures: [],
    samplers: [],
    bounds: [
      ...Array.from({ length: 3 }, (_, i) =>
        Math.min(...boxes.map((b) => b[0][i])),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        Math.max(...boxes.map((b) => b[1][i])),
      ),
    ],
  };
}
const make = async (g) => {
  const d = new DDGI(new BVH(g), {
    spacing: 1,
    rays: 128,
    traversalBudget: 4096,
  });
  await d.initialize(
    () => {},
    () => false,
  );
  return d;
};
const box = await make(
  geometryFor([
    [
      [-1, -1, -1],
      [1, 1, 1],
    ],
  ]),
);
let inside = 0;
for (let id = 0; id < box.grid.total; id++) {
  const p = box.positions.slice(id * 4, id * 4 + 4);
  if (p.slice(0, 3).every((v) => v > -1 && v < 1)) {
    inside++;
    assert.equal(p[3], 0);
  }
}
assert.ok(inside > 0);
console.log("PASS explicitly double-sided solid interior rejected");
const sheet = geometryFor(
  [
    [
      [-2, -2, 0],
      [2, 2, 0.01],
    ],
  ],
  {
    doubleSided: true,
    extras: { thinSurface: true },
    pbrMetallicRoughness: { metallicFactor: 0 },
  },
);
const thin = await make(sheet);
assert.equal(thin.active, thin.grid.total);
console.log("PASS double-sided thin sheet supports both sides");
const slabs = [
  [
    [-2, -2, -0.2],
    [2, 2, 0],
  ],
  [
    [-2, -2, 3],
    [2, 2, 3.2],
  ],
  [
    [-2, -2, 0],
    [-1.8, 2, 3],
  ],
  [
    [1.8, -2, 0],
    [2, 2, 3],
  ],
  [
    [-2, 1.8, 0],
    [2, 2, 3],
  ],
  [
    [-2, -2, 0],
    [-0.5, -1.8, 3],
  ],
  [
    [0.5, -2, 0],
    [2, -1.8, 3],
  ],
  [
    [-0.5, -2, 2],
    [0.5, -1.8, 3],
  ],
];
const room = await make(geometryFor(slabs));
await room.solve(
  {
    sunDirection: [0, 0, 1],
    sunRadiance: [0, 0, 0],
    skyRadiance: [0, 0, 0],
    bounces: 3,
  },
  () => {},
  () => false,
  () => {},
);
const dark = room.field.sample([0, 0, 1], [0, 0, 1]);
assert.ok(dark.coverage > 0.9);
assert.deepEqual(dark.irradiance, [0, 0, 0]);
console.log(
  "PASS doorway room valid dark free space survives classification/integration/material transport",
);
const overlaps = await make(
  geometryFor([
    [
      [-2, -2, -1],
      [2, 2, 0],
    ],
    [
      [-2, -2, -0.1],
      [2, 2, 0.15],
    ],
  ]),
);
for (let id = 0; id < overlaps.grid.total; id++) {
  const p = Array.from(overlaps.positions.slice(id * 4, id * 4 + 4));
  const logical = [
    id % overlaps.grid.counts[0],
    Math.floor(id / overlaps.grid.counts[0]) % overlaps.grid.counts[1],
    Math.floor(id / (overlaps.grid.counts[0] * overlaps.grid.counts[1])),
  ].map((v, i) => overlaps.grid.origin[i] + v);
  assert.ok(
    Math.hypot(...p.slice(0, 3).map((v, i) => v - logical[i])) <= 0.45001,
  );
  if (
    p[0] > -2 &&
    p[0] < 2 &&
    p[1] > -2 &&
    p[1] < 2 &&
    p[2] > -1 &&
    p[2] < 0.15
  )
    assert.equal(p[3], 0);
}
console.log("PASS overlapping slabs / cumulative relocation bound");
