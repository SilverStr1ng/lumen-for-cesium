import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { identity, multiply, axisCorrection } from "../lumen/local-dataset.js";
const root = "fixtures/local-pilot";
await mkdir(root, { recursive: true });
const source = JSON.parse(
    await readFile("fixtures/earth-gi-gallery.gltf", "utf8"),
  ),
  sourceBin = await readFile("fixtures/earth-gi-gallery.bin");
function accessor(g, bytes, index) {
  const a = g.accessors[index],
    v = g.bufferViews[a.bufferView],
    size = { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type],
    types = {
      5126: ["getFloat32", 4],
      5123: ["getUint16", 2],
      5125: ["getUint32", 4],
    },
    [method, width] = types[a.componentType],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = [];
  for (let i = 0; i < a.count; i++)
    for (let j = 0; j < size; j++)
      out.push(
        view[method](
          (v.byteOffset ?? 0) +
            (a.byteOffset ?? 0) +
            i * (v.byteStride ?? size * width) +
            j * width,
          true,
        ),
      );
  return { out, size };
}
function extract(primitive) {
  const attributes = Object.fromEntries(
      Object.entries(primitive.attributes).map(([name, i]) => [
        name,
        accessor(source, sourceBin, i),
      ]),
    ),
    count = attributes.POSITION.out.length / 9,
    parent = Array.from({ length: count }, (_, i) => i),
    find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i]))),
    edges = new Map();
  for (let t = 0; t < count; t++) {
    const keys = [0, 1, 2].map((j) =>
        attributes.POSITION.out
          .slice(t * 9 + j * 3, t * 9 + j * 3 + 3)
          .map((v) => v.toFixed(6))
          .join(","),
      ),
      normal = attributes.NORMAL.out
        .slice(t * 9, t * 9 + 3)
        .map((v) => v.toFixed(5))
        .join(",");
    for (let j = 0; j < 3; j++) {
      const key = normal + "|" + [keys[j], keys[(j + 1) % 3]].sort().join("|");
      if (edges.has(key)) parent[find(t)] = find(edges.get(key));
      else edges.set(key, t);
    }
  }
  const groups = new Map();
  for (let t = 0; t < count; t++) {
    const group = groups.get(find(t)) ?? [];
    group.push(t);
    groups.set(find(t), group);
  }
  const g = {
      asset: {
        version: "2.0",
        generator: "R11 Gallery connected coplanar parts",
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [] }],
      materials: [structuredClone(source.materials[primitive.material])],
      images: structuredClone(source.images),
      textures: structuredClone(source.textures),
      samplers: structuredClone(source.samplers),
      accessors: [],
      bufferViews: [],
      buffers: [],
    },
    chunks = [];
  let offset = 0;
  for (const triangles of groups.values()) {
    const attrs = {};
    for (const [name, { out, size }] of Object.entries(attributes)) {
      const data = Float32Array.from(
          triangles.flatMap((t) => out.slice(t * 3 * size, (t + 1) * 3 * size)),
        ),
        bytes = Buffer.from(data.buffer);
      attrs[name] = g.accessors.length;
      const a = {
        bufferView: g.bufferViews.length,
        componentType: 5126,
        count: data.length / size,
        type: size === 3 ? "VEC3" : "VEC2",
      };
      if (name === "POSITION") {
        a.min = [0, 1, 2].map((k) =>
          Math.min(...Array.from(data).filter((_, i) => i % 3 === k)),
        );
        a.max = [0, 1, 2].map((k) =>
          Math.max(...Array.from(data).filter((_, i) => i % 3 === k)),
        );
      }
      g.accessors.push(a);
      g.bufferViews.push({
        buffer: 0,
        byteOffset: offset,
        byteLength: bytes.length,
      });
      chunks.push(bytes);
      offset += bytes.length;
    }
    g.meshes[0].primitives.push({ attributes: attrs, material: 0 });
  }
  g.buffers = [{ byteLength: offset }];
  return { g, bin: Buffer.concat(chunks) };
}
const bytesOf = async (uri) =>
  uri.startsWith("data:")
    ? Buffer.from(uri.split(",")[1], "base64")
    : readFile("fixtures/" + uri);
async function glb(document) {
  const g = structuredClone(document.g),
    chunks = [document.bin];
  let offset = document.bin.length;
  for (const im of g.images ?? [])
    if (im.uri) {
      const bytes = await bytesOf(im.uri),
        pad = (4 - (bytes.length % 4)) % 4;
      im.bufferView = g.bufferViews.length;
      im.mimeType = "image/png";
      delete im.uri;
      g.bufferViews.push({
        buffer: 0,
        byteOffset: offset,
        byteLength: bytes.length,
      });
      chunks.push(bytes, Buffer.alloc(pad));
      offset += bytes.length + pad;
    }
  g.buffers = [{ byteLength: offset }];
  const json = Buffer.from(JSON.stringify(g)),
    jsonPad = (4 - (json.length % 4)) % 4,
    bin = Buffer.concat(chunks),
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + jsonPad + bin.length, 8);
  header.writeUInt32LE(json.length + jsonPad, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([
    header,
    json,
    Buffer.alloc(jsonPad, 32),
    binHeader,
    bin,
  ]);
}
const assets = [],
  documents = [];
for (let i = 0; i < 6; i++) {
  const doc = extract(source.meshes[0].primitives[i]),
    id = ["basalt", "limestone", "plaster", "terracotta", "oak", "emitter"][i];
  if ([0, 3, 5].includes(i)) {
    delete doc.g.materials[0].pbrMetallicRoughness.baseColorTexture;
    doc.g.images = [];
    doc.g.textures = [];
    doc.g.samplers = [];
  }
  const ext = i % 2 ? "gltf" : "glb",
    uri = id + "." + ext;
  if (ext === "gltf") {
    doc.g.buffers[0].uri = id + ".bin";
    doc.g.images.forEach((im) => (im.uri = "../" + im.uri));
    await writeFile(root + "/" + id + ".bin", doc.bin);
    await writeFile(root + "/" + uri, JSON.stringify(doc.g, null, 2));
    doc.g.images.forEach((im) => (im.uri = im.uri.slice(3)));
  } else await writeFile(root + "/" + uri, await glb(doc));
  assets.push({
    id,
    renderUri: "./" + uri,
    localTransform: identity(),
    upAxis: "Z",
    forwardAxis: "X",
  });
  documents.push(doc);
}
const repeat = structuredClone(documents[3]);
repeat.bin = Buffer.from(documents[3].bin);
repeat.g.materials[0].pbrMetallicRoughness.baseColorFactor = [
  0.1, 0.28, 0.75, 1,
];
// Same geometry as terracotta, a distinct node/instance/color and Y-up representation.
for (const [name, k] of [
  ["POSITION", 0],
  ["NORMAL", 0],
])
  for (const p of repeat.g.meshes[0].primitives) {
    const a = repeat.g.accessors[p.attributes[name]],
      v = repeat.g.bufferViews[a.bufferView];
    for (let i = 0; i < a.count; i++) {
      const o = v.byteOffset + i * 12,
        y = repeat.bin.readFloatLE(o + 4),
        z = repeat.bin.readFloatLE(o + 8);
      repeat.bin.writeFloatLE(z, o + 4);
      repeat.bin.writeFloatLE(-y, o + 8);
    }
    if (name === "POSITION") {
      const values = accessor(repeat.g, repeat.bin, p.attributes[name]).out;
      a.min = [0, 1, 2].map((k) =>
        Math.min(...values.filter((_, i) => i % 3 === k)),
      );
      a.max = [0, 1, 2].map((k) =>
        Math.max(...values.filter((_, i) => i % 3 === k)),
      );
    }
  }
await writeFile(root + "/blue-instance.glb", await glb(repeat));
const translated = identity();
translated[12] = 0.8;
assets.push({
  id: "blue-instance",
  renderUri: "./blue-instance.glb",
  localTransform: translated,
  upAxis: "Y",
  forwardAxis: "X",
});
documents.push(repeat);
const alpha = JSON.parse(await readFile("fixtures/alpha-mask.gltf", "utf8")),
  alphaBin = await bytesOf(alpha.buffers[0].uri),
  alphaDoc = { g: alpha, bin: alphaBin };
await writeFile(root + "/alpha-mask.glb", await glb(alphaDoc));
const maskTransform = identity();
maskTransform[12] = 2;
maskTransform[13] = 5;
assets.push({
  id: "alpha-mask",
  renderUri: "./alpha-mask.glb",
  localTransform: maskTransform,
  upAxis: "Z",
  forwardAxis: "X",
});
documents.push(alphaDoc);
function combine(documents, assets) {
  const g = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      images: [],
      textures: [],
      samplers: [],
      accessors: [],
      bufferViews: [],
      buffers: [],
    },
    chunks = [];
  let offset = 0;
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i],
      n = g.nodes.length + 1,
      mesh = g.meshes.length,
      mat = g.materials.length,
      im = g.images.length,
      tex = g.textures.length,
      sam = g.samplers.length,
      acc = g.accessors.length,
      bv = g.bufferViews.length;
    g.scenes[0].nodes.push(g.nodes.length);
    g.nodes.push({
      matrix: multiply(
        assets[i].localTransform,
        axisCorrection(assets[i].upAxis, assets[i].forwardAxis),
      ),
      children: doc.g.scenes[doc.g.scene ?? 0].nodes.map((j) => j + n),
    });
    g.nodes.push(
      ...doc.g.nodes.map((node) => ({
        ...node,
        ...(node.mesh === undefined ? {} : { mesh: node.mesh + mesh }),
        ...(node.children ? { children: node.children.map((j) => j + n) } : {}),
      })),
    );
    g.meshes.push(
      ...doc.g.meshes.map((m) => ({
        primitives: m.primitives.map((p) => ({
          ...p,
          attributes: Object.fromEntries(
            Object.entries(p.attributes).map(([k, v]) => [k, v + acc]),
          ),
          ...(p.indices === undefined ? {} : { indices: p.indices + acc }),
          material: (p.material ?? 0) + mat,
        })),
      })),
    );
    g.accessors.push(
      ...doc.g.accessors.map((a) => ({ ...a, bufferView: a.bufferView + bv })),
    );
    g.bufferViews.push(
      ...doc.g.bufferViews.map((v) => ({
        ...v,
        buffer: 0,
        byteOffset: (v.byteOffset ?? 0) + offset,
      })),
    );
    g.materials.push(
      ...doc.g.materials.map((m) => {
        const copy = structuredClone(m);
        for (const t of [
          copy.pbrMetallicRoughness?.baseColorTexture,
          copy.pbrMetallicRoughness?.metallicRoughnessTexture,
          copy.emissiveTexture,
        ])
          if (t) t.index += tex;
        return copy;
      }),
    );
    g.images.push(...structuredClone(doc.g.images ?? []));
    g.samplers.push(...structuredClone(doc.g.samplers ?? []));
    g.textures.push(
      ...(doc.g.textures ?? []).map((t) => ({
        ...t,
        source: t.source + im,
        ...(t.sampler === undefined ? {} : { sampler: t.sampler + sam }),
      })),
    );
    chunks.push(doc.bin);
    offset += doc.bin.length;
  }
  g.buffers = [{ byteLength: offset }];
  return { g, bin: Buffer.concat(chunks) };
}
await writeFile(root + "/parent.glb", await glb(combine(documents, assets)));
for (let i = 0; i < assets.length; i++)
  await writeFile(
    root + "/tile-" + i + ".glb",
    await glb(combine([documents[i]], [assets[i]])),
  );
const names = [
  "parent.glb",
  ...assets.map((a) => a.renderUri.slice(2)),
  ...Array.from({ length: 8 }, (_, i) => "tile-" + i + ".glb"),
  "limestone.bin",
  "terracotta.bin",
  "emitter.bin",
];
const resources = {};
for (const name of names)
  resources[name] = createHash("sha256")
    .update(await readFile(root + "/" + name))
    .digest("hex");
resources["../gallery-mineral.png"] = createHash("sha256")
  .update(await readFile("fixtures/gallery-mineral.png"))
  .digest("hex");
const version = createHash("sha256")
  .update(JSON.stringify(resources))
  .digest("hex");
const box = [0, 0, 3, 18, 0, 0, 0, 14, 0, 0, 0, 7];
const tileset = {
  asset: { version: "1.1", gltfUpAxis: "Z" },
  geometricError: 100,
  extras: {
    datasetId: "gallery-pilot",
    datasetVersion: version,
    lodPolicy:
      "two-level REPLACE, exact geometry batching LOD; no simplification quality claim",
  },
  root: {
    boundingVolume: { box },
    geometricError: 30,
    refine: "REPLACE",
    content: { uri: "parent.glb" },
    children: assets.map((a, i) => ({
      boundingVolume: { box },
      geometricError: 0,
      content: { uri: "tile-" + i + ".glb" },
    })),
  },
};
await writeFile(root + "/tileset.json", JSON.stringify(tileset, null, 2));
resources["tileset.json"] = createHash("sha256")
  .update(await readFile(root + "/tileset.json"))
  .digest("hex");
const manifest = {
  schemaVersion: 1,
  datasetId: "gallery-pilot",
  version,
  anchor: { longitude: 114.1, latitude: 22.3, height: 2 },
  assets,
  gi: { spacing: 2, rays: 128, bounces: 3 },
  tilesUri: "./tileset.json",
  resources,
  proxyPolicy:
    "All eight source parts resident once; display LOD never enters GI BVH",
};
await writeFile(root + "/dataset.json", JSON.stringify(manifest, null, 2));
await writeFile(root + "/equivalent.glb", await glb(documents[1]));
console.log(
  JSON.stringify({
    assets: assets.length,
    version,
    primitives: documents.map((d) =>
      d.g.meshes.reduce((s, m) => s + m.primitives.length, 0),
    ),
  }),
);
