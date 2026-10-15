import { readContainer } from "./gltf-container.js";
import { loadGeometry } from "./gltf.js";
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a, b) {
  const c = Array(16).fill(0);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++)
      for (let k = 0; k < 4; k++) c[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return c;
}
export function axisCorrection(up = "Z", forward = "X") {
  const y = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
    z = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  return multiply(
    up === "Y" ? y : identity(),
    forward === "Z" ? z : identity(),
  );
}
export function validateTransform(m) {
  if (
    !Array.isArray(m) ||
    m.length !== 16 ||
    !m.every(Number.isFinite) ||
    m[3] !== 0 ||
    m[7] !== 0 ||
    m[11] !== 0 ||
    m[15] !== 1
  )
    throw Error("Static affine 4x4 transform required");
  const v = [m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)],
    length = v.map((a) => Math.hypot(...a)),
    dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  if (
    length[0] < 1e-6 ||
    length.some((x) => Math.abs(x - length[0]) > 1e-6 * length[0]) ||
    [
      [0, 1],
      [0, 2],
      [1, 2],
    ].some(([a, b]) => Math.abs(dot(v[a], v[b])) > 1e-6 * length[0] ** 2)
  )
    throw Error(
      "Negative/nonuniform/sheared transforms need offline conversion",
    );
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det <= 0) throw Error("Negative scale is not supported");
  return m;
}
export function validateManifest(m) {
  if (
    m.schemaVersion !== 1 ||
    typeof m.datasetId !== "string" ||
    !m.datasetId ||
    typeof m.version !== "string" ||
    !m.version ||
    !Array.isArray(m.assets) ||
    !m.assets.length ||
    m.assets.length > 32
  )
    throw Error("Versioned dataset schemaVersion=1 required");
  const ids = new Set();
  for (const a of m.assets) {
    if (typeof a.id !== "string" || !a.id || ids.has(a.id))
      throw Error("Unique asset ids required");
    ids.add(a.id);
    if (typeof a.renderUri !== "string") throw Error("renderUri required");
    validateTransform(a.localTransform ?? identity());
    if (
      !["Y", "Z"].includes(a.upAxis ?? "Z") ||
      !["X", "Z"].includes(a.forwardAxis ?? "X")
    )
      throw Error("Unsupported asset axis");
  }
  const anchor = m.anchor;
  if (
    !anchor ||
    ![anchor.longitude, anchor.latitude, anchor.height].every(
      Number.isFinite,
    ) ||
    Math.abs(anchor.longitude) > 180 ||
    Math.abs(anchor.latitude) > 90
  )
    throw Error("Finite geodetic anchor required");
  if (!(m.gi?.spacing > 0) || m.gi.rays !== 128 || m.gi.bounces !== 3)
    throw Error("Pilot uses spacing>0 /128 rays /3 rounds");
  return m;
}
export function auditGltf(g) {
  if (g.asset?.version !== "2.0" || g.animations?.length || g.skins?.length)
    throw Error(
      "Only explicit static unskinned glTF2; animation needs static export",
    );
  if ((g.extensionsRequired ?? []).some((e) => e !== "KHR_texture_transform"))
    throw Error(
      "Required compression/material extensions need offline conversion",
    );
  for (const a of g.accessors ?? [])
    if (a.sparse || a.bufferView === undefined)
      throw Error("Sparse/implicit accessors need offline conversion");
  for (const v of g.bufferViews ?? [])
    if (v.extensions) throw Error("Compressed bufferView unsupported");
  for (const m of g.materials ?? [])
    if (
      m.alphaMode === "BLEND" ||
      m.normalTexture ||
      m.occlusionTexture ||
      Object.keys(m.extensions ?? {}).length
    )
      throw Error(
        "Transmission/BLEND/normal/occlusion/material extensions unsupported by pilot",
      );
  for (const mesh of g.meshes ?? [])
    for (const p of mesh.primitives)
      if ((p.mode ?? 4) !== 4 || p.targets || p.extensions)
        throw Error("Static uncompressed TRIANGLES required");
  for (const mesh of g.meshes ?? [])
    for (const p of mesh.primitives) {
      const a = g.accessors?.[p.attributes?.POSITION];
      if (
        !a ||
        !a.min ||
        !a.max ||
        a.min.length !== 3 ||
        a.max.length !== 3 ||
        ![...a.min, ...a.max].every(Number.isFinite) ||
        a.min.some((v, i) => v > a.max[i])
      )
        throw Error("POSITION requires finite min/max bounds");
    }
  const active = new Set(),
    done = new Set();
  const visit = (index, depth) => {
    if (
      !Number.isInteger(index) ||
      !g.nodes?.[index] ||
      active.has(index) ||
      depth > 64
    )
      throw Error("Invalid/cyclic/deep node graph");
    if (done.has(index)) return;
    active.add(index);
    for (const child of g.nodes[index].children ?? []) visit(child, depth + 1);
    active.delete(index);
    done.add(index);
  };
  for (let i = 0; i < (g.nodes?.length ?? 0); i++) visit(i, 0);
  for (const n of g.nodes ?? []) {
    if (n.matrix) validateTransform(n.matrix);
    if (n.scale)
      validateTransform([
        n.scale[0],
        0,
        0,
        0,
        0,
        n.scale[1],
        0,
        0,
        0,
        0,
        n.scale[2],
        0,
        0,
        0,
        0,
        1,
      ]);
    if (
      n.translation &&
      (!Array.isArray(n.translation) ||
        n.translation.length !== 3 ||
        !n.translation.every(Number.isFinite))
    )
      throw Error("Finite translation required");
    if (
      n.rotation &&
      (!Array.isArray(n.rotation) ||
        n.rotation.length !== 4 ||
        !n.rotation.every(Number.isFinite) ||
        Math.abs(Math.hypot(...n.rotation) - 1) > 1e-6)
    )
      throw Error("Unit quaternion required");
  }
  return {
    status: "supported",
    primitives: (g.meshes ?? []).reduce((s, m) => s + m.primitives.length, 0),
    materials: g.materials?.length ?? 1,
  };
}
export async function loadDatasetGeometry(
  manifest,
  url,
  progress = () => {},
  signal,
) {
  validateManifest(manifest);
  const result = {
    positions: [],
    normals: [],
    uvs: [],
    materialIds: [],
    materials: [],
    images: [],
    textures: [],
    samplers: [],
    owners: [],
    assets: [],
    bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
  };
  let owner = 1;
  for (const asset of manifest.assets) {
    signal?.throwIfAborted();
    const assetUri = new URL(asset.giUri ?? asset.renderUri, url).href;
    auditGltf((await readContainer(assetUri, signal)).gltf);
    const g = await loadGeometry(
        new URL(asset.giUri ?? asset.renderUri, url).href,
        axisCorrection(asset.upAxis, asset.forwardAxis),
        progress,
        signal,
      ),
      matrix = asset.localTransform ?? identity(),
      start = result.positions.length / 9;
    if (
      result.materials.length + g.materials.length > 65535 ||
      result.positions.length + g.positions.length > 9 * 200000
    )
      throw Error("Local dataset material/triangle budget exceeded");
    const mat = result.materials.length,
      im = result.images.length,
      tex = result.textures.length,
      sampler = result.samplers.length;
    for (const m of g.materials) {
      const copy = structuredClone(m);
      for (const info of [
        copy.pbrMetallicRoughness?.baseColorTexture,
        copy.pbrMetallicRoughness?.metallicRoughnessTexture,
        copy.emissiveTexture,
      ])
        if (info) info.index += tex;
      result.materials.push(copy);
    }
    result.images.push(...g.images);
    result.samplers.push(...g.samplers);
    result.textures.push(
      ...g.textures.map((t) => ({
        ...t,
        source: t.source + im,
        ...(t.sampler === undefined ? {} : { sampler: t.sampler + sampler }),
      })),
    );
    for (let i = 0; i < g.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        const value =
          matrix[k] * g.positions[i] +
          matrix[k + 4] * g.positions[i + 1] +
          matrix[k + 8] * g.positions[i + 2] +
          matrix[k + 12];
        result.positions.push(value);
        result.bounds[k] = Math.min(result.bounds[k], value);
        result.bounds[k + 3] = Math.max(result.bounds[k + 3], value);
      }
    for (let i = 0; i < g.normals.length; i += 3) {
      const n = [0, 1, 2].map(
          (k) =>
            matrix[k] * g.normals[i] +
            matrix[k + 4] * g.normals[i + 1] +
            matrix[k + 8] * g.normals[i + 2],
        ),
        l = Math.hypot(...n);
      result.normals.push(...n.map((v) => v / l));
    }
    for (const uv of g.uvs) result.uvs.push(uv);
    for (const id of g.materialIds) result.materialIds.push(id + mat);
    for (let t = 0; t < g.materialIds.length; t++) result.owners.push(owner++);
    result.assets.push({
      id: asset.id,
      start,
      triangles: g.materialIds.length,
      version: manifest.version,
    });
    progress("asset " + asset.id);
  }
  if (result.materials.length > 65535 || result.positions.length > 9 * 200000)
    throw Error("Local dataset material/triangle budget exceeded");
  const counts = result.bounds
    .slice(0, 3)
    .map((v, i) =>
      Math.max(
        2,
        Math.ceil(
          (result.bounds[i + 3] - v + manifest.gi.spacing) /
            manifest.gi.spacing,
        ) + 1,
      ),
    );
  const total = counts.reduce((s, n) => s * n, 1);
  if (total > 4096)
    throw Error(
      "Local dataset exceeds 4096 probes; revise declared region/spacing",
    );
  result.plan = {
    counts,
    total,
    spacing: manifest.gi.spacing,
    rays: manifest.gi.rays,
    bounces: manifest.gi.bounces,
  };
  return {
    ...result,
    positions: Float32Array.from(result.positions),
    normals: Float32Array.from(result.normals),
    uvs: Float32Array.from(result.uvs),
    materialIds: Uint16Array.from(result.materialIds),
    owners: Uint32Array.from(result.owners),
  };
}
