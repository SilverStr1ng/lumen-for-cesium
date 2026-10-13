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
      generator: "lumen-for-cesium Earth GI Gallery R7 (Z up)",
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
      images: [{ uri: "gallery-mineral.png" }],
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
function bevelBox(scene, lo, hi, material, width = 0.04) {
  const center = lo.map((v, i) => (v + hi[i]) / 2),
    extent = lo.map((v, i) => (hi[i] - v) / 2),
    planes = [];
  const plane = (n, d) => {
    const length = Math.hypot(...n);
    planes.push({ n: n.map((v) => v / length), d: d / length });
  };
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const n = [0, 0, 0];
      n[axis] = sign;
      plane(n, extent[axis]);
    }
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++)
      for (const sa of [-1, 1])
        for (const sb of [-1, 1]) {
          const n = [0, 0, 0];
          n[a] = sa;
          n[b] = sb;
          plane(n, extent[a] + extent[b] - width);
        }
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        plane([x, y, z], extent.reduce((a, b) => a + b, 0) - 2 * width);
  const vertices = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const A = planes[i],
          B = planes[j],
          D = planes[k],
          det = dot(A.n, cross(B.n, D.n));
        if (Math.abs(det) < 1e-8) continue;
        const v = mul(
          add(
            add(mul(cross(B.n, D.n), A.d), mul(cross(D.n, A.n), B.d)),
            mul(cross(A.n, B.n), D.d),
          ),
          1 / det,
        );
        if (planes.some((p) => dot(p.n, v) > p.d + 1e-6)) continue;
        if (!vertices.some((p) => Math.hypot(...sub(p, v)) < 1e-6))
          vertices.push(v);
      }
  for (const p of planes) {
    const face = vertices.filter((v) => Math.abs(dot(p.n, v) - p.d) < 1e-6);
    if (face.length < 3) continue;
    const mid = face.reduce(
        (s, v) => add(s, mul(v, 1 / face.length)),
        [0, 0, 0],
      ),
      t = normalize(cross(Math.abs(p.n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], p.n)),
      b = cross(p.n, t);
    face.sort(
      (u, v) =>
        Math.atan2(dot(sub(u, mid), b), dot(sub(u, mid), t)) -
        Math.atan2(dot(sub(v, mid), b), dot(sub(v, mid), t)),
    );
    for (let i = 1; i < face.length - 1; i++)
      scene.triangle(
        [face[0], face[i], face[i + 1]].map((v) => add(v, center)),
        material,
      );
  }
}

const materials = [
  diffuse([0.64, 0.62, 0.57]),
  diffuse([0.72, 0.69, 0.61]),
  diffuse([0.48, 0.13, 0.07]),
  diffuse([0.24, 0.13, 0.065]),
  diffuse([0.12, 0.14, 0.15]),
  diffuse([0.8, 0.75, 0.65], [1, 0.64, 0.34]),
];
materials.forEach((m, i) => {
  m.name = [
    "Honed limestone",
    "Warm mineral plaster",
    "Terracotta",
    "Oiled oak",
    "Basalt",
    "Large luminous wall",
  ][i];
  m.pbrMetallicRoughness.roughnessFactor = [0.76, 0.91, 0.86, 0.72, 0.8, 0.85][
    i
  ];
  if (i < 5) m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
});
const s = scene();
function solid(lo, hi, material = 0) {
  // Historical box helper is inward wound; change only each newly added face.
  const before = new Map(
    [...s.groups].map(([m, g]) => [m, g.positions.length]),
  );
  s.box(lo, hi, material);
  const g = s.groups.get(material),
    offset = before.get(material) ?? 0;
  for (let i = offset; i < g.positions.length; i += 9) {
    for (const field of ["positions", "normals"]) {
      const a = g[field].slice(i + 3, i + 6),
        b = g[field].slice(i + 6, i + 9);
      g[field].splice(i + 3, 6, ...b, ...a);
    }
    const uvIndex = (i / 3) * 2,
      a = g.uv.slice(uvIndex + 2, uvIndex + 4),
      b = g.uv.slice(uvIndex + 4, uvIndex + 6);
    g.uv.splice(uvIndex + 2, 4, ...b, ...a);
  }
  for (let i = offset; i < g.normals.length; i++) g.normals[i] = -g.normals[i];
}
solid([-15.5, -11.5, -1.5], [15.5, 11.5, 0], 4);
solid([-15.5, -11.5, 0], [15.5, 11.5, 0.2], 0);
// Connected courtyard / hall / luminous north bay. Every structure is GI geometry.
solid([-15.3, 10.7, 0.2], [15.3, 11.3, 7.5], 1);
solid([14.8, -10.8, 0.2], [15.3, 11.3, 7.5], 1);
solid([0, -10.8, 0.2], [0.5, -0.5, 7.5], 1);
solid([0, 3, 0.2], [0.5, 10.7, 7.5], 1);
solid([0, -0.5, 3.7], [0.5, 3, 7.5], 1);
// South facade, with a broad entrance and visible structural thickness.
solid([0.5, -10.8, 0.2], [4, -10.3, 7], 1);
solid([9, -10.8, 0.2], [14.8, -10.3, 7], 1);
solid([4, -10.8, 3.8], [9, -10.3, 7], 1);
// Real 6 x 6m skylight; no glass or emissive surrogate.
for (const [lo, hi] of [
  [
    [0, -10.8, 7],
    [4, 11.3, 7.65],
  ],
  [
    [10, -10.8, 7],
    [15.3, 11.3, 7.65],
  ],
  [
    [4, -10.8, 7],
    [10, -5, 7.65],
  ],
  [
    [4, 1, 7],
    [10, 11.3, 7.65],
  ],
])
  solid(lo, hi, 0);
for (const [lo, hi] of [
  [
    [3.75, -5.25, 6.8],
    [4.05, 1.25, 7.85],
  ],
  [
    [9.95, -5.25, 6.8],
    [10.25, 1.25, 7.85],
  ],
  [
    [4, -5.25, 6.8],
    [10, -4.95, 7.85],
  ],
  [
    [4, 0.95, 6.8],
    [10, 1.25, 7.85],
  ],
])
  solid(lo, hi, 0);
// Courtyard enclosure: the muted red wall is behind the bounce-view camera.
solid([-15.3, -7.4, 0.2], [-14.8, 9.8, 3.8], 2);
solid([-14.8, 9.5, 0.2], [0, 10.7, 3.8], 1);
solid([-15.45, -7.65, 3.8], [-14.65, 10, 4.1], 0);
solid([-14.8, 9.35, 3.8], [0, 10.9, 4.1], 0);
// Deep canopy and slender piers, open to the sky at the courtyard's centre.
solid([-14.8, 5.3, 4.8], [0.5, 9.5, 5.15], 0);
for (const x of [-12.3, -7.3, -2.3]) {
  bevelBox(s, [x - 0.22, 5.6, 0.2], [x + 0.22, 6.04, 4.8], 0, 0.025);
  bevelBox(s, [x - 0.34, 5.46, 0.2], [x + 0.34, 6.18, 0.48], 0, 0.025);
}
// Stone benches and real entrance steps.
for (const x of [-12.2, -7.4]) {
  bevelBox(s, [x, -2.8, 0.2], [x + 2.7, -1.95, 0.72], 0, 0.055);
  solid([x + 0.25, -2.55, 0.2], [x + 0.6, -2.2, 0.62], 4);
  solid([x + 2.1, -2.55, 0.2], [x + 2.45, -2.2, 0.62], 4);
}
solid([-5.5, -10.8, 0], [-0.5, -9.0, 0.1], 0);
solid([-4.8, -9.0, 0.1], [-1.2, -7.8, 0.2], 0);
// Hall exhibition plinths keep flat Ng/Ns and provide contact / disocclusion.
for (const [x, y] of [
  [6, -1.8],
  [11.6, 2.8],
]) {
  bevelBox(s, [x - 0.7, y - 0.7, 0.2], [x + 0.7, y + 0.7, 1.05], 0, 0.055);
  bevelBox(s, [x - 0.4, y - 0.4, 1.05], [x + 0.4, y + 0.4, 2.1], 3, 0.04);
}
solid([0.5, 6.4, 0.2], [3.6, 6.9, 7], 1);
solid([10, 6.4, 0.2], [14.8, 6.9, 7], 1);
solid([3.6, 6.4, 3.5], [10, 6.9, 7], 1);
solid([3.8, 10.15, 0.5], [10.8, 10.7, 5.2], 4);
solid([4.05, 10.05, 1], [10.55, 10.15, 4.8], 5);
bevelBox(s, [5.5, 8, 0.2], [9.1, 8.9, 0.8], 0, 0.05);
const metadata = {
  theme: "Earth GI Gallery — courtyard, skylight hall, luminous wall",
  anchor: { longitude: 114.1, latitude: 22.3, height: 1.5, heading: 0 },
  spacing: 2,
  rays: 128,
  bounces: 3,
  dimensions: [31, 23, 7.85],
  foundationCorners: [
    [-15.5, -11.5],
    [-15.5, 11.5],
    [15.5, -11.5],
    [15.5, 11.5],
  ],
  cameras: {
    overview: { eye: [-29, -34, 22], target: [0, 1, 2.4] },
    courtyard: { eye: [-12.7, -5.4, 1.8], target: [-5.3, 2.7, 0.65] },
    skylight: { eye: [11.8, -7.2, 2], target: [5.5, 2.4, 2.1] },
    doorway: { eye: [-3.2, -1.4, 1.7], target: [8.5, 2.5, 1.25] },
    emitter: { eye: [12.8, 7.4, 2], target: [7.2, 9.5, 1.4] },
  },
  receivers: [
    {
      position: [-12, -0.9, 0.202],
      normal: [0, 0, 1],
      name: "courtyard color bounce",
    },
    {
      position: [7, 3, 0.202],
      normal: [0, 0, 1],
      name: "skylight interior floor",
    },
    {
      position: [7.2, 9.5, 0.202],
      normal: [0, 0, 1],
      name: "luminous bay floor",
    },
  ],
  lightingPresets: {
    day: {
      sunDirection: [-1, -0.35, 1.1],
      sunRadiance: [2, 2, 2],
      skyRadiance: [0.15, 0.18, 0.25],
    },
    sunset: {
      sunDirection: [-0.8, -0.6, 0.22],
      sunRadiance: [1.6, 1.05, 0.68],
      skyRadiance: [0.09, 0.12, 0.18],
    },
    night: {
      sunDirection: [1, 0, 0.65],
      sunRadiance: [0, 0, 0],
      skyRadiance: [0.01, 0.015, 0.02],
    },
  },
  exposure: 1,
  ownership: "One self-authored static glTF; identical display and GI asset",
  coverage:
    "Gallery, foundation, roof, benches and steps participate in GI. Globe/terrain are background.",
  license:
    "Self-authored geometry and mineral texture, MIT (repository LICENSE); no baked lighting/AO.",
};
await save("earth-gi-gallery", s, materials, metadata, true);
const off = structuredClone(materials);
off[5].emissiveFactor = [0, 0, 0];
off[5].name += " (off)";
await save(
  "earth-gi-gallery-off",
  s,
  off,
  { ...metadata, emitter: false },
  true,
);
console.log(
  "Generated Earth GI Gallery: " +
    [...s.groups.values()].reduce((n, g) => n + g.positions.length / 9, 0) +
    " triangles; six materials.",
);

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
header.writeUInt32BE(64, 0);
header.writeUInt32BE(64, 4);
header[8] = 8;
header[9] = 6;
const pixels = Buffer.alloc(64 * (1 + 64 * 4));
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const i = y * 257 + 1 + x * 4;
    let hash = Math.imul(x + 19, 374761393) ^ Math.imul(y + 7, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    const value = 246 + (((hash ^ (hash >>> 16)) >>> 24) % 9);
    pixels.set([value, value, value, 255], i);
  }
await writeFile(
  new URL("gallery-mineral.png", directory),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
