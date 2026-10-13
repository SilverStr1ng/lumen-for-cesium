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
function sphere(scene, center, radius, material) {
  const segments = 24,
    rings = 12,
    vertex = (r, s) => {
      const theta = (Math.PI * r) / rings,
        phi = (2 * Math.PI * s) / segments;
      const n = [
        Math.sin(theta) * Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
      ];
      return { p: add(center, mul(n, radius)), n };
    };
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = vertex(r, s),
        b = vertex(r + 1, s),
        c = vertex(r + 1, s + 1),
        d = vertex(r, s + 1);
      for (const f of [
        [a, b, c],
        [a, c, d],
      ])
        scene.triangle(
          f.map((v) => v.p),
          material,
          f.map((v) => v.n),
        );
    }
}
for (const preset of ["regression", "presentation"]) {
  const pavilion = scene();
  // Z-up metres. Reverse box face winding: outward normals on all solid surfaces.
  const solid = (a, b, m = 0) => {
    if (
      preset === "presentation" &&
      ((b[0] - a[0] < 0.5 && b[1] - a[1] < 0.5) ||
        (b[2] - a[2] < 1 && a[2] >= 0.15 && m !== 4))
    ) {
      bevelBox(pavilion, a, b, m, 0.035);
      return;
    }
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
  const materials = [
    white,
    diffuse([0.68, 0.12, 0.06]),
    diffuse([0.08, 0.38, 0.56]),
    diffuse([0.28, 0.29, 0.3]),
    diffuse([0.6, 0.52, 0.38], [0.45, 0.32, 0.16]),
  ];
  if (preset === "presentation") {
    materials.forEach((m, i) => {
      m.name = [
        "plaster / stone",
        "terracotta",
        "blue ceramic",
        "foundation concrete",
        "emissive brass",
      ][i];
      m.pbrMetallicRoughness.roughnessFactor = [0.78, 0.72, 0.36, 0.95, 0.28][
        i
      ];
      if (i < 4) m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
    });
    const samples = [
      [0.18, 0, 1, "rough gray"],
      [0.96, 0, 0.35, "white dielectric"],
      [0.035, 0, 0.5, "dark dielectric"],
      [0.18, 0, 0.12, "smooth gray"],
      [0.6, 1, 0.28, "metal"],
      [0.18, 0, 0.45, "medium gray"],
    ];
    samples.forEach(([base, metallic, roughness, name], i) => {
      materials.push({
        name,
        doubleSided: false,
        extras: { giSolid: true },
        pbrMetallicRoughness: {
          baseColorFactor: [base, base, base, 1],
          metallicFactor: metallic,
          roughnessFactor: roughness,
        },
      });
      sphere(pavilion, [-5 + i * 2, 0.5, 0.85], 0.7, 5 + i);
    });
    for (const group of pavilion.groups.values())
      for (let i = 0; i < group.positions.length; i += 3) {
        const n = group.normals.slice(i, i + 3),
          axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs))),
          axes = [0, 1, 2].filter((a) => a !== axis);
        group.uv[(i / 3) * 2] = group.positions[i + axes[0]] / 2;
        group.uv[(i / 3) * 2 + 1] = group.positions[i + axes[1]] / 2;
      }
  }
  await save(
    preset === "presentation"
      ? "earth-pavilion-presentation"
      : "earth-pavilion",
    pavilion,
    materials,
    {
      anchor: { longitude: 114.1, latitude: 22.3, height: 1.5, heading: 0 },
      bounds: [-12, -9, -1.5, 12, 9, 5.5],
      ...(preset === "presentation"
        ? {
            preset,
            materialContract:
              "baseColor/emissive sRGB texture -> linear; factors/MR linear; transport uses triangle macro normals; no baked AO/GI",
          }
        : {}),
      spacing: 2,
      rays: 128,
      bounces: 3,
      cameras: {
        overview: { eye: [30, -37, 27], target: [0, 0, 1] },
        context: { eye: [32, -42, 8], target: [0, 0, 2] },
        top: { eye: [0, -1, 47], target: [0, 0, 0] },
        corridor: { eye: [-6, -7, 2], target: [-9, 3, 1.5] },
        inside: { eye: [-1, 6.8, 1.7], target: [-1, 1, 2.5] },
        ...(preset === "presentation"
          ? { materials: { eye: [4, -16, 4], target: [-1, 0.5, 0.85] } }
          : {}),
        bounce: { eye: [-4, -5, 2.5], target: [-9, -3.8, 0.8] },
      },
      receivers: [{ position: [-9, -4, 0.17], normal: [0, 0, 1] }],
      coverage:
        "Local pavilion and foundation only; Globe and terrain do not participate in GI.",
    },
    preset === "presentation",
  );
}
console.log("Generated deterministic Earth GI Lab pavilion");

// Self-authored low-contrast material detail, no lighting or AO baked into pixels.
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
  new URL("pavilion-detail.png", directory),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
