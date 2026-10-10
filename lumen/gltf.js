import { linear, normalize, cross, sub, clamp } from "./math.js";

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const c = Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        c[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return c;
}
function transform(m, p, w = 1) {
  return [0, 1, 2].map(
    (r) => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12] * w,
  );
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1],
    s = n.scale ?? [1, 1, 1],
    t = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * s[0],
    (2 * x * y + 2 * w * z) * s[0],
    (2 * x * z - 2 * w * y) * s[0],
    0,
    (2 * x * y - 2 * w * z) * s[1],
    (1 - 2 * x * x - 2 * z * z) * s[1],
    (2 * y * z + 2 * w * x) * s[1],
    0,
    (2 * x * z + 2 * w * y) * s[2],
    (2 * y * z - 2 * w * x) * s[2],
    (1 - 2 * x * x - 2 * y * y) * s[2],
    0,
    ...t,
    1,
  ];
}
async function fetched(url, type) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return r[type]();
}
/** glTF static triangle loader. Axis correction is supplied by the display model. */
export async function loadGeometry(url, axisMatrix, progress = () => {}) {
  const gltf = await fetched(url, "json");
  if (gltf.animations?.length || gltf.skins?.length)
    throw new Error("World GI currently accepts static, unskinned glTF only");
  const unsupported = (gltf.extensionsRequired ?? []).filter(
    (x) => x !== "KHR_texture_transform",
  );
  if (unsupported.length)
    throw new Error(`Unsupported required glTF extensions: ${unsupported}`);
  const buffers = await Promise.all(
    gltf.buffers.map((b) => fetched(new URL(b.uri, url), "arrayBuffer")),
  );
  const accessor = (i) => {
    const a = gltf.accessors[i],
      v = gltf.bufferViews[a.bufferView];
    if (a.sparse || !v)
      throw new Error(
        "Sparse or absent bufferView is not supported by the static proxy",
      );
    const component = {
      5120: ["getInt8", 1, 127],
      5121: ["getUint8", 1, 255],
      5122: ["getInt16", 2, 32767],
      5123: ["getUint16", 2, 65535],
      5125: ["getUint32", 4, 4294967295],
      5126: ["getFloat32", 4, 1],
    }[a.componentType];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    if (!component || !size) throw new Error("Unsupported accessor");
    const d = new DataView(buffers[v.buffer]),
      out = new Float64Array(a.count * size),
      stride = v.byteStride ?? size * component[1],
      offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    for (let j = 0; j < a.count; j++)
      for (let k = 0; k < size; k++) {
        let value = d[component[0]](
          offset + j * stride + k * component[1],
          true,
        );
        if (a.normalized) value = Math.max(-1, value / component[2]);
        out[j * size + k] = value;
      }
    return out;
  };
  const materials = gltf.materials ?? [{}],
    usedImages = new Set();
  for (const m of materials)
    for (const t of [
      m.pbrMetallicRoughness?.baseColorTexture,
      m.pbrMetallicRoughness?.metallicRoughnessTexture,
      m.emissiveTexture,
    ])
      if (t) {
        if (
          (t.texCoord ?? 0) !== 0 ||
          (t.extensions?.KHR_texture_transform?.texCoord ?? 0) !== 0
        )
          throw new Error("Only TEXCOORD_0 is supported by this proxy");
        usedImages.add(gltf.textures[t.index].source);
      }
  const images = [];
  await Promise.all(
    [...usedImages].map(async (i) => {
      const image = gltf.images[i];
      const blob = image.uri
        ? await fetched(new URL(image.uri, url), "blob")
        : new Blob(
            [
              buffers[gltf.bufferViews[image.bufferView].buffer].slice(
                gltf.bufferViews[image.bufferView].byteOffset ?? 0,
                (gltf.bufferViews[image.bufferView].byteOffset ?? 0) +
                  gltf.bufferViews[image.bufferView].byteLength,
              ),
            ],
            { type: image.mimeType },
          );
      const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      const ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height)),
        w = Math.max(1, Math.round(bitmap.width * ratio)),
        h = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(w, h),
        ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      images[i] = {
        width: w,
        height: h,
        data: ctx.getImageData(0, 0, w, h).data,
      };
    }),
  );
  progress("textures decoded");
  const pos = [],
    uv = [],
    ids = [],
    normals = [],
    bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const visit = (i, parent) => {
    const n = gltf.nodes[i];
    if (n.skin !== undefined) throw new Error("Skinned node unsupported");
    const local = multiply(parent, nodeMatrix(n));
    if (n.mesh !== undefined)
      for (const primitive of gltf.meshes[n.mesh].primitives) {
        if (
          (primitive.mode ?? 4) !== 4 ||
          primitive.targets ||
          primitive.extensions?.KHR_draco_mesh_compression
        )
          throw new Error("Only uncompressed static TRIANGLES are supported");
        const m = primitive.material ?? 0;
        if (materials[m].alphaMode === "BLEND")
          throw new Error(
            "Translucent world geometry requires a transmission backend",
          );
        const p = accessor(primitive.attributes.POSITION),
          tex =
            primitive.attributes.TEXCOORD_0 === undefined
              ? undefined
              : accessor(primitive.attributes.TEXCOORD_0),
          idx =
            primitive.indices === undefined
              ? Array.from({ length: p.length / 3 }, (_, i) => i)
              : accessor(primitive.indices);
        for (let j = 0; j < idx.length; j += 3) {
          const vertices = [0, 1, 2].map((k) =>
            transform(local, p.subarray(idx[j + k] * 3, idx[j + k] * 3 + 3)),
          );
          const normal = normalize(
            cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0])),
          );
          if (Math.hypot(...normal) < 0.5) continue;
          for (let k = 0; k < 3; k++) {
            pos.push(...vertices[k]);
            uv.push(
              ...(tex
                ? tex.subarray(idx[j + k] * 2, idx[j + k] * 2 + 2)
                : [0, 0]),
            );
            for (let a = 0; a < 3; a++) {
              bounds[a] = Math.min(bounds[a], vertices[k][a]);
              bounds[a + 3] = Math.max(bounds[a + 3], vertices[k][a]);
            }
          }
          normals.push(...normal);
          ids.push(m);
        }
      }
    for (const child of n.children ?? []) visit(child, local);
  };
  for (const node of gltf.scenes[gltf.scene ?? 0].nodes)
    visit(node, axisMatrix ?? identity());
  return {
    positions: Float32Array.from(pos),
    uvs: Float32Array.from(uv),
    normals: Float32Array.from(normals),
    materialIds: Uint16Array.from(ids),
    materials,
    images,
    textures: gltf.textures ?? [],
    samplers: gltf.samplers ?? [],
    bounds,
  };
}
function wrap(v, mode) {
  if (mode === 33071) return clamp(v, 0, 1 - 1e-8);
  if (mode === 33648) {
    v = ((v % 2) + 2) % 2;
    return v > 1 ? 2 - v : v;
  }
  return v - Math.floor(v);
}
export function textureSample(g, info, u, v) {
  if (!info) return [1, 1, 1, 1];
  const t = g.textures[info.index],
    image = g.images[t.source],
    s = g.samplers[t.sampler] ?? {},
    tr = info.extensions?.KHR_texture_transform;
  if (tr) {
    const x = u * (tr.scale?.[0] ?? 1),
      y = v * (tr.scale?.[1] ?? 1),
      a = tr.rotation ?? 0;
    u = x * Math.cos(a) - y * Math.sin(a) + (tr.offset?.[0] ?? 0);
    v = x * Math.sin(a) + y * Math.cos(a) + (tr.offset?.[1] ?? 0);
  }
  // glTF UV (0,0) addresses the top-left decoded image; display textures use flipY=false.
  const x = wrap(u, s.wrapS) * image.width - 0.5,
    y = wrap(v, s.wrapT) * image.height - 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy,
    out = [0, 0, 0, 0];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const px = Math.floor(
          wrap((ix + i + 0.5) / image.width, s.wrapS) * image.width,
        ),
        py = Math.floor(
          wrap((iy + j + 0.5) / image.height, s.wrapT) * image.height,
        );
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy),
        offset = (py * image.width + px) * 4;
      for (let k = 0; k < 4; k++)
        out[k] += (image.data[offset + k] * weight) / 255;
    }
  return out;
}
export function materialAt(g, t, u, v, neutralMaterials = []) {
  const m = g.materials[g.materialIds[t]],
    pbr = m.pbrMetallicRoughness ?? {},
    uv = g.uvs,
    o = t * 6;
  const x = uv[o] * (1 - u - v) + uv[o + 2] * u + uv[o + 4] * v,
    y = uv[o + 1] * (1 - u - v) + uv[o + 3] * u + uv[o + 5] * v;
  const base = textureSample(g, pbr.baseColorTexture, x, y),
    factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const metallic =
    (pbr.metallicFactor ?? 1) *
    textureSample(g, pbr.metallicRoughnessTexture, x, y)[2];
  let albedo = base
    .slice(0, 3)
    .map((c, i) => linear(c) * factor[i] * (1 - metallic));
  if (neutralMaterials.includes(g.materialIds[t])) {
    const average = (albedo[0] + albedo[1] + albedo[2]) / 3;
    albedo = [average, average, average];
  }
  const emissive = textureSample(g, m.emissiveTexture, x, y)
    .slice(0, 3)
    .map((c, i) => linear(c) * (m.emissiveFactor?.[i] ?? 0));
  return {
    albedo,
    emissive,
    alpha: base[3] * factor[3],
    normal: Array.from(g.normals.subarray(t * 3, t * 3 + 3)),
    material: g.materialIds[t],
  };
}
export function accepts(g, t, u, v) {
  const m = g.materials[g.materialIds[t]];
  if (m.alphaMode !== "MASK") return true;
  return materialAt(g, t, u, v).alpha >= (m.alphaCutoff ?? 0.5);
}
