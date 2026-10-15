import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  readContainer,
  snapshotAsset,
  dataUri,
} from "../lumen/gltf-container.js";
import {
  auditGltf,
  validateManifest,
  loadDatasetGeometry,
} from "../lumen/local-dataset.js";
const base = new URL("../fixtures/local-pilot/", import.meta.url);
const localFetch = async (input) =>
  new Response(await readFile(new URL(input)), {
    headers: {
      "content-type": String(input).endsWith(".png")
        ? "image/png"
        : "application/octet-stream",
    },
  });
const manifest = JSON.parse(await readFile(new URL("dataset.json", base)));
validateManifest(manifest);
for (const [name, digest] of Object.entries(manifest.resources))
  assert.equal(
    createHash("sha256")
      .update(await readFile(new URL(name, base)))
      .digest("hex"),
    digest,
    name,
  );
const snapshots = [];
for (const asset of manifest.assets) {
  const snapshot = await snapshotAsset(
    new URL(asset.renderUri, base),
    undefined,
    localFetch,
  );
  auditGltf(snapshot.gltf);
  snapshots.push({ ...asset, renderUri: snapshot.url });
}
const text = await snapshotAsset(
    new URL("limestone.gltf", base),
    undefined,
    localFetch,
  ),
  binary = await snapshotAsset(
    new URL("equivalent.glb", base),
    undefined,
    localFetch,
  );
assert.deepEqual(text.gltf.accessors, binary.gltf.accessors);
assert.equal(
  text.gltf.buffers[0].uri.split(",")[1],
  binary.gltf.buffers[0].uri
    .split(",")[1]
    .slice(0, text.gltf.buffers[0].uri.split(",")[1].length),
);
// Independent Y-up oracle: the blue instance must recover every terracotta
// vertex after a known +0.8m X translation, while retaining its own material.
const geometry = await loadDatasetGeometry(
  {
    ...manifest,
    assets: snapshots.filter((a) =>
      ["terracotta", "blue-instance"].includes(a.id),
    ),
  },
  base.href,
);
const n = geometry.positions.length / 2;
for (let i = 0; i < n; i++)
  assert(
    Math.abs(
      geometry.positions[n + i] -
        geometry.positions[i] -
        (i % 3 === 0 ? 0.8 : 0),
    ) < 1e-5,
  );
assert(new Set(geometry.owners).size === geometry.owners.length);
assert(new Set(geometry.materialIds).size === 2);
const original = text.gltf;
for (const key of ["url", "workerUrl", "backend", "modelMatrix"]) {
  const invalid = structuredClone(manifest);
  invalid.gi[key] = "untrusted";
  assert.throws(() => validateManifest(invalid));
}
for (const mutate of [
  (g) => { g.extensions = { CESIUM_RTC: { center: [100, 0, 0] } }; },
  (g) => { g.nodes[0].extensions = { CESIUM_RTC: { center: [100, 0, 0] } }; },
  (g) => {
    g.nodes[0].children = [0];
  },
  (g) => {
    g.nodes[0].scale = [1, 2, 1];
  },
  (g) => {
    g.nodes[0].translation = [NaN, 0, 0];
  },
  (g) => {
    g.nodes[0].rotation = [NaN, 0, 0, 1];
  },
  (g) => {
    delete g.accessors[g.meshes[0].primitives[0].attributes.POSITION].min;
  },
  (g) => {
    g.materials[0].normalTexture = { index: 0 };
  },
  (g) => {
    g.animations = [{}];
  },
]) {
  const g = structuredClone(original);
  mutate(g);
  assert.throws(() => auditGltf(g));
}
const malformed = Buffer.from(await readFile(new URL("basalt.glb", base)));
malformed.writeUInt32LE(1, 4);
await assert.rejects(() => readContainer(dataUri(malformed)));
console.log(
  JSON.stringify({
    status: "passed",
    assets: snapshots.length,
    glbGltf: "buffer/accessor equality",
    axis: "per vertex independent Y-up oracle",
    globalOwners: geometry.owners.length,
    rejections: 14,
    scope:
      "Transport/geometry only; actual image decode, displayed alignment, quality and resource gates require browser tests",
  }),
);
