import { writeFile } from "node:fs/promises";
// Two opaque double-sided quads separated by 150 metres. The upper quad must
// occlude upward rays from the lower surface even though it exceeds legacy 100m.
const p = Float32Array.from([
  -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 150, 1,
  -1, 150, 1, 1, 150, -1, -1, 150, 1, 1, 150, -1, 1, 150,
]);
const gltf = {
  asset: {
    version: "2.0",
    generator: "Lumen deterministic far-blocker fixture",
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  materials: [
    {
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.6, 0.6, 0.6, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    },
  ],
  buffers: [
    {
      byteLength: p.byteLength,
      uri:
        "data:application/octet-stream;base64," +
        Buffer.from(p.buffer).toString("base64"),
    },
  ],
  bufferViews: [{ buffer: 0, byteLength: p.byteLength, target: 34962 }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: p.length / 3,
      type: "VEC3",
      min: [-1, -1, 0],
      max: [1, 1, 150],
    },
  ],
};
await writeFile("fixtures/far-blocker.gltf", JSON.stringify(gltf, null, 2));
await writeFile(
  "fixtures/far-blocker.json",
  JSON.stringify(
    {
      camera: { eye: [5, -8, 5], target: [0, 0, 0] },
      receivers: [{ position: [0, 0, 0.01], normal: [0, 0, 1] }],
      expected: { blockerDistance: 150, legacyMaximum: 100 },
    },
    null,
    2,
  ),
);
