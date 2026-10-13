import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { cross, dot, normalize, sub, add, mul } from "../lumen/math.js";

const directory = new URL("../fixtures/", import.meta.url);
await mkdir(directory, { recursive: true });
const diffuse = (rgb, emission = [0, 0, 0]) => ({
  doubleSided: false,
  extras: { giSolid: true },
  pbrMetallicRoughness: {
    baseColorFactor: [...rgb, 1],
    metallicFactor: 0,
    roughnessFactor: 1,
  },
  emissiveFactor: emission,
});
const white = diffuse([0.6, 0.6, 0.6]);
const red = diffuse([0.75, 0.04, 0.02], [0.5, 0, 0]);
function scene() {
  const groups = new Map();
  const quad = (points, material = 0) => {
    const group = groups.get(material) ?? {
      positions: [],
      normals: [],
      uv: [],
    };
    const a = points[0],
      b = points[1],
      c = points[2];
    const x = b.map((v, i) => v - a[i]),
      y = c.map((v, i) => v - a[i]);
    const n = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
    const length = Math.hypot(...n);
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      group.positions.push(...points[i]);
      group.normals.push(...n.map((v) => v / length));
      group.uv.push(...uv[i]);
    }
    groups.set(material, group);
  };
  const box = (lo, hi, material = 0) => {
    const [x, y, z] = lo,
      [X, Y, Z] = hi;
    for (const p of [
      [
        [x, y, z],
        [X, y, z],
        [X, Y, z],
        [x, Y, z],
      ],
      [
        [x, y, Z],
        [x, Y, Z],
        [X, Y, Z],
        [X, y, Z],
      ],
      [
        [x, y, z],
        [x, Y, z],
        [x, Y, Z],
        [x, y, Z],
      ],
      [
        [X, y, z],
        [X, y, Z],
        [X, Y, Z],
        [X, Y, z],
      ],
      [
        [x, y, z],
        [x, y, Z],
        [X, y, Z],
        [X, y, z],
      ],
      [
        [x, Y, z],
        [X, Y, z],
        [X, Y, Z],
        [x, Y, Z],
      ],
    ])
      quad(p, material);
  };
  const triangle = (points, material, smoothNormals) => {
    const group = groups.get(material) ?? {
      positions: [],
      normals: [],
      uv: [],
    };
    const n = normalize(
      cross(sub(points[1], points[0]), sub(points[2], points[0])),
    );
    if (Math.hypot(...n) < 0.5) return;
    points.forEach((p, i) => {
      group.positions.push(...p);
      group.normals.push(...(smoothNormals?.[i] ?? n));
      group.uv.push(p[0] / 2, p[1] / 2);
    });
    groups.set(material, group);
  };
  return { groups, quad, box, triangle };
}
async function save(name, geometry, materials, metadata, textured = false) {
  const chunks = [],
    bufferViews = [],
    accessors = [],
    primitives = [];
  let byteLength = 0;
  const attribute = (data, type) => {
    const buffer = Buffer.from(Float32Array.from(data).buffer);
    const view = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: buffer.length,
      target: 34962,
    });
    chunks.push(buffer);
    byteLength += buffer.length;
    const size = type === "VEC2" ? 2 : 3;
    const index = accessors.length;
    const accessor = {
      bufferView: view,
      componentType: 5126,
      count: data.length / size,
      type,
    };
    if (type === "VEC3") {
      accessor.min = Array.from({ length: size }, (_, i) =>
        Math.min(...data.filter((_, j) => j % size === i)),
      );
      accessor.max = Array.from({ length: size }, (_, i) =>
        Math.max(...data.filter((_, j) => j % size === i)),
      );
    }
    accessors.push(accessor);
    return index;
  };
  for (const [material, g] of geometry.groups)
    primitives.push({
      material,
      attributes: {
        POSITION: attribute(g.positions, "VEC3"),
        NORMAL: attribute(g.normals, "VEC3"),
        TEXCOORD_0: attribute(g.uv, "VEC2"),
      },
    });
  const gltf = {
    asset: {
      version: "2.0",
      generator: "lumen-for-cesium deterministic fixtures v1 (Z up)",
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    buffers: [{ uri: `${name}.bin`, byteLength }],
    bufferViews,
    accessors,
  };
  if (textured)
    Object.assign(gltf, {
      images: [{ uri: "pavilion-detail.png" }],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [
        { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 },
      ],
    });
  await writeFile(new URL(`${name}.bin`, directory), Buffer.concat(chunks));
  await writeFile(
    new URL(`${name}.gltf`, directory),
    JSON.stringify(gltf, null, 2) + "\n",
  );
  await writeFile(
    new URL(`${name}.json`, directory),
    JSON.stringify({ name, upAxis: "Z", ...metadata }, null, 2) + "\n",
  );
}

// Convex chamfer: original extents retained, each edge/corner is real GI geometry.

const s = scene(),
  mats = [
    diffuse([0.65, 0.65, 0.65]),
    diffuse([0.5, 0.5, 0.5]),
    diffuse([0.7, 0.05, 0.02], [0.8, 0.04, 0.02]),
  ];
for (const [lo, hi, m] of [
  [[-8, -7, -0.4], [8, 7, 0.15], 0],
  [[-8, -7, 0.15], [-7.6, 7, 3.5], 1],
  [[7.6, -7, 0.15], [8, 7, 3.5], 1],
  [[-8, -7, 0.15], [8, -6.6, 3.5], 1],
  [[-8, 6.6, 0.15], [8, 7, 3.5], 1],
  [[-8, -7, 3.2], [8, 7, 3.5], 1],
  [[-7.59, -2, 1], [-7.49, 2, 2.6], 2],
])
  s.box(lo, hi, m);
const wall = scene();
wall.box([-0.025, -10, 0.15], [0.025, 10, 3.2], 1);
const angle = (25 * Math.PI) / 180;
const group = wall.groups.get(1);
for (const field of ["positions", "normals"])
  for (let i = 0; i < group[field].length; i += 3) {
    const x = group[field][i],
      y = group[field][i + 1];
    group[field][i] = x * Math.cos(angle) - y * Math.sin(angle);
    group[field][i + 1] = x * Math.sin(angle) + y * Math.cos(angle);
  }
const dest = s.groups.get(1);
for (const field of ["positions", "normals", "uv"])
  dest[field].push(...group[field]);
// All solids are initially inward boxes; consistently invert winding and normals.
for (const g of s.groups.values()) {
  for (let i = 0; i < g.positions.length; i += 9) {
    for (const field of ["positions", "normals"]) {
      const a = g[field].slice(i + 3, i + 6),
        b = g[field].slice(i + 6, i + 9);
      g[field].splice(i + 3, 6, ...b, ...a);
    }
    const j = (i / 3) * 2,
      a = g.uv.slice(j + 2, j + 4),
      b = g.uv.slice(j + 4, j + 6);
    g.uv.splice(j + 2, 4, ...b, ...a);
  }
  for (let i = 0; i < g.normals.length; i++) g.normals[i] = -g.normals[i];
}
await save("fg-slanted-barrier", s, mats, {
  anchor: { longitude: 114.1, latitude: 22.3, height: 1.5, heading: 0 },
  spacing: 2,
  rays: 128,
  bounces: 3,
  cameras: {
    overview: { eye: [5, -5, 2], target: [0, 0, 0.5] },
    left: { eye: [-3, -4, 1.6], target: [-4, 1, 0.4] },
    right: { eye: [3, -4, 1.6], target: [3, 1, 0.4] },
  },
  lightingPresets: {
    night: {
      sunDirection: [1, 0, 0.65],
      sunRadiance: [0, 0, 0],
      skyRadiance: [0, 0, 0],
    },
  },
  receivers: [
    { position: [-2, 0, 0.151], normal: [0, 0, 1] },
    { position: [2, 0, 0.151], normal: [0, 0, 1] },
  ],
  barrier: { angleDegrees: 25, thickness: 0.05, height: 3.05 },
  coverage:
    "Closed divided room; a 25 degree thin wall splits the SAME floor primitive. Only the left room contains emission.",
});
console.log("Generated actual slanted thin-wall receiver scenario.");
