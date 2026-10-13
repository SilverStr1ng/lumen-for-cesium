import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

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
  return { groups, quad, box };
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
      images: [{ uri: "alpha-mask.png" }],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [
        { wrapS: 33071, wrapT: 33071, magFilter: 9728, minFilter: 9728 },
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

const pavilion = scene();
// Z-up metres. Reverse box face winding: outward normals on all solid surfaces.
const solid = (a, b, m = 0) => {
  const before = new Map(
    [...pavilion.groups].map(([k, g]) => [k, g.normals.length]),
  );
  pavilion.box(a, b, m);
  const g = pavilion.groups.get(m);
  for (let i = before.get(m) ?? 0; i < g.normals.length; i++)
    g.normals[i] *= -1;
  for (let i = before.get(m) ?? 0; i < g.positions.length; i += 9)
    for (let k = 0; k < 3; k++) {
      const v = g.positions[i + 3 + k];
      g.positions[i + 3 + k] = g.positions[i + 6 + k];
      g.positions[i + 6 + k] = v;
    }
};
solid([-12, -9, -1.5], [12, 9, 0], 3);
solid([-11, -8, 0], [11, 8, 0.15]);
solid([-11, 7.7, 0.15], [11, 8, 5.5]);
solid([-11, -8, 0.15], [-10.7, 8, 5.5], 1);
solid([10.7, -8, 0.15], [11, 8, 5.5], 2);
// Deep rear gallery, side corridors, and a central open courtyard.
// Four roof slabs leave a true 3 x 2 m skylight, shared by rendering and GI.
solid([-11, 3, 5.2], [-1, 8, 5.5]);
solid([2, 3, 5.2], [11, 8, 5.5]);
solid([-1, 3, 5.2], [2, 4.5, 5.5]);
solid([-1, 6.5, 5.2], [2, 8, 5.5]);
solid([-11, -8, 5.2], [-7, 3, 5.5]);
solid([7, -8, 5.2], [11, 3, 5.5]);
for (const x of [-7, 7])
  for (const y of [-7, -2, 3])
    solid([x - 0.18, y - 0.18, 0.15], [x + 0.18, y + 0.18, 5.2]);
// Room divider with doorway and roof aperture.
solid([-7, 3, 0.15], [-3, 3.25, 5.2]);
solid([0.5, 3, 0.15], [7, 3.25, 5.2]);
solid([-3, 3, 3.4], [0.5, 3.25, 5.2]);
solid([-3.5, 5.5, 0.15], [-1, 7.5, 0.75], 3);
solid([2, 7.64, 2], [4, 7.69, 2.5], 4);
solid([-10.6, -3, 0.15], [-9, -1, 1.1]);
await save(
  "earth-pavilion",
  pavilion,
  [
    white,
    diffuse([0.68, 0.12, 0.06]),
    diffuse([0.08, 0.38, 0.56]),
    diffuse([0.28, 0.29, 0.3]),
    diffuse([0.6, 0.52, 0.38], [0.45, 0.32, 0.16]),
  ],
  {
    anchor: { longitude: 114.1, latitude: 22.3, height: 1.5, heading: 0 },
    bounds: [-12, -9, -1.5, 12, 9, 5.5],
    spacing: 2,
    rays: 128,
    bounces: 3,
    cameras: {
      overview: { eye: [30, -37, 27], target: [0, 0, 1] },
      context: { eye: [32, -42, 8], target: [0, 0, 2] },
      top: { eye: [0, -1, 47], target: [0, 0, 0] },
      corridor: { eye: [-6, -7, 2], target: [-9, 3, 1.5] },
      inside: { eye: [-1, 6.8, 1.7], target: [-1, 1, 2.5] },
      bounce: { eye: [-4, -5, 2.5], target: [-9, -3.8, 0.8] },
    },
    receivers: [{ position: [-9, -4, 0.17], normal: [0, 0, 1] }],
    coverage:
      "Local pavilion and foundation only; Globe and terrain do not participate in GI.",
  },
);
console.log("Generated deterministic Earth GI Lab pavilion");
