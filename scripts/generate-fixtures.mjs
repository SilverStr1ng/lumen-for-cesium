import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const directory = new URL("../fixtures/", import.meta.url);
await mkdir(directory, { recursive: true });
const diffuse = (rgb, emission = [0, 0, 0]) => ({
  doubleSided: true,
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
const simple = scene();
simple.quad([
  [-2, -2, 0],
  [2, -2, 0],
  [2, 2, 0],
  [-2, 2, 0],
]);
simple.quad(
  [
    [-2, -2, 0],
    [-2, 2, 0],
    [-2, 2, 2.5],
    [-2, -2, 2.5],
  ],
  1,
);
simple.box([1.7, 0.8, 0], [2, 1.1, 1]);
await save("untextured", simple, [white, red], {
  receivers: [{ position: [-0.7, 0, 0.02], normal: [0, 0, 1] }],
  camera: { eye: [0.8, -1.5, 1.3], target: [-0.7, 0, 0.02] },
  sourceMaterial: 1,
});
const rooms = scene();
rooms.quad([
  [-3, -2, 0],
  [3, -2, 0],
  [3, 2, 0],
  [-3, 2, 0],
]);
rooms.quad([
  [-3, -2, 2.5],
  [-3, 2, 2.5],
  [3, 2, 2.5],
  [3, -2, 2.5],
]);
rooms.quad(
  [
    [-3, -2, 0],
    [-3, 2, 0],
    [-3, 2, 2.5],
    [-3, -2, 2.5],
  ],
  1,
);
rooms.quad([
  [3, -2, 0],
  [3, -2, 2.5],
  [3, 2, 2.5],
  [3, 2, 0],
]);
rooms.quad([
  [-3, -2, 0],
  [-3, -2, 2.5],
  [3, -2, 2.5],
  [3, -2, 0],
]);
rooms.quad([
  [-3, 2, 0],
  [3, 2, 0],
  [3, 2, 2.5],
  [-3, 2, 2.5],
]);
rooms.box([-0.08, -2, 0], [0.08, 2, 2.5]);
await save("two-rooms", rooms, [white, red], {
  receivers: [
    { position: [-1.5, 0, 0.02], normal: [0, 0, 1] },
    { position: [1.5, 0, 0.02], normal: [0, 0, 1] },
  ],
  camera: { eye: [-1.3, -0.8, 1.2], target: [-1.5, 0, 0.02] },
  sourceMaterial: 1,
  crossingRay: { origin: [-1.5, 0, 1], direction: [1, 0, 0], distance: 1.42 },
});
const mask = scene();
mask.quad([
  [-2, -1, 0],
  [2, -1, 0],
  [2, 1, 0],
  [-2, 1, 0],
]);
mask.quad(
  [
    [0, -1, 0],
    [0, 1, 0],
    [0, 1, 2],
    [0, -1, 2],
  ],
  1,
);
mask.quad([
  [1, -1, 0],
  [1, 1, 0],
  [1, 1, 2],
  [1, -1, 2],
]);
const maskMaterial = {
  ...white,
  alphaMode: "MASK",
  alphaCutoff: 0.5,
  pbrMetallicRoughness: {
    ...white.pbrMetallicRoughness,
    baseColorTexture: { index: 0 },
  },
};
await save(
  "alpha-mask",
  mask,
  [white, maskMaterial],
  {
    receivers: [{ position: [-1, 0, 0.02], normal: [0, 0, 1] }],
    camera: { eye: [-1.5, -0.8, 1.4], target: [0, 0, 0.6] },
    rays: [
      { origin: [-1, -0.5, 1], direction: [1, 0, 0], distance: 2 },
      { origin: [-1, 0.5, 1], direction: [1, 0, 0], distance: 1 },
    ],
  },
  true,
);
// Minimal PNG encoder: deterministic RGBA8, transparent left half and opaque right half.
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(8, 0);
header.writeUInt32BE(8, 4);
header[8] = 8;
header[9] = 6;
const pixels = Buffer.alloc(8 * (1 + 8 * 4));
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 8; x++) {
    const i = y * 33 + 1 + x * 4;
    pixels.set([255, 255, 255, x < 4 ? 0 : 255], i);
  }
await writeFile(
  new URL("alpha-mask.png", directory),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log("Generated 3 deterministic static glTF fixtures");
