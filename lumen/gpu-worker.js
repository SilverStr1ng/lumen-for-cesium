import { loadGeometry, accepts, materialAt, isSolidMaterial } from "./gltf.js";
import { BVH } from "./bvh.js";

// Only static preparation runs here. Runtime intersections and lighting are GPU passes.
let bvh;
function texture(data, width = 2048) {
  const height = Math.ceil(data.length / 4 / width);
  const padded = new Float32Array(width * height * 4);
  padded.set(data);
  return { width, height, data: padded };
}
function pack(b, options) {
  const g = b.geometry,
    n = b.order.length,
    nodes = b.children.length / 4;
  const nodeData = new Float32Array(nodes * 8);
  const thread = (i, escape) => {
    const c = i * 4,
      o = i * 8;
    nodeData.set(b.bounds.subarray(i * 6, i * 6 + 3), o);
    nodeData[o + 3] = escape;
    nodeData.set(b.bounds.subarray(i * 6 + 3, i * 6 + 6), o + 4);
    nodeData[o + 7] = b.children[c + 3]
      ? b.children[c + 2] * 16 + b.children[c + 3]
      : -1;
    if (!b.children[c + 3]) {
      thread(b.children[c], b.children[c + 1]);
      thread(b.children[c + 1], escape);
    }
  };
  thread(0, nodes);
  // Preserve the original median traversal's exact-distance tie policy. The UV
  // prefix retains all four UV channels; four ranks share each appended texel.
  const hasTieRanks = b.stats.strategy === "sah";
  const rankStarted = performance.now();
  let medianRank;
  if (hasTieRanks) {
    const median = new BVH(g, { strategy: "median" });
    medianRank = new Uint32Array(n);
    for (let i = 0; i < n; i++) medianRank[median.order[i]] = i;
  }
  const vertices = new Float32Array(n * 12),
    uv = new Float32Array(n * 4 + (hasTieRanks ? Math.ceil(n / 4) * 4 : 0));
  for (let t = 0; t < n; t++) {
    const original = b.order[t];
    for (let j = 0; j < 3; j++)
      vertices.set(
        g.positions.subarray(original * 9 + j * 3, original * 9 + j * 3 + 3),
        t * 12 + j * 4,
      );
    vertices[t * 12 + 3] = g.materialIds[original];
    vertices[t * 12 + 7] = g.uvs[original * 6];
    vertices[t * 12 + 11] = g.uvs[original * 6 + 1];
    uv.set(g.uvs.subarray(original * 6 + 2, original * 6 + 6), t * 4);
    if (hasTieRanks) uv[n * 4 + t] = medianRank[original];
  }
  b.stats.tieRankOffset = hasTieRanks ? n : -1;
  b.stats.tieRankBytes = hasTieRanks ? Math.ceil(n / 4) * 16 : 0;
  b.stats.rankAndVertexPackMilliseconds = performance.now() - rankStarted;
  const used = g.images.map((im, i) => (im ? i : -1)).filter((i) => i >= 0);
  const cols = Math.min(
    8,
    used.length,
    Math.floor(options.maxTextureSize / 512),
  );
  if (used.length && cols < 1)
    throw new Error("Material atlas needs a 512px texture limit");
  // Untextured glTF still needs a complete sampler; account for its four bytes.
  const width = used.length ? cols * 512 : 1,
    height = used.length ? Math.ceil(used.length / cols) * 512 : 1;
  const atlas = new Uint8Array(width * height * 4),
    rects = [];
  if (!used.length) atlas.fill(255);
  used.forEach((id, slot) => {
    const im = g.images[id],
      x = (slot % cols) * 512,
      y = Math.floor(slot / cols) * 512;
    rects[id] = [x, y, im.width, im.height];
    for (let row = 0; row < im.height; row++)
      atlas.set(
        im.data.subarray(row * im.width * 4, (row + 1) * im.width * 4),
        ((y + row) * width + x) * 4,
      );
  });
  const materials = new Float32Array(g.materials.length * 48);
  g.materials.forEach((m, i) => {
    const o = i * 48,
      p = m.pbrMetallicRoughness ?? {};
    materials.set(p.baseColorFactor ?? [1, 1, 1, 1], o);
    materials.set(
      [
        p.metallicFactor ?? 1,
        m.alphaCutoff ?? 0.5,
        Number(!!m.doubleSided),
        Number(m.alphaMode === "MASK"),
      ],
      o + 4,
    );
    materials.set(
      [...(m.emissiveFactor ?? [0, 0, 0]), Number(isSolidMaterial(m))],
      o + 8,
    );
    [p.baseColorTexture, p.metallicRoughnessTexture, m.emissiveTexture].forEach(
      (info, j) => {
        if (!info) return;
        const t = g.textures[info.index],
          s = g.samplers[t.sampler] ?? {},
          tr = info.extensions?.KHR_texture_transform ?? {};
        materials.set(rects[t.source], o + 12 + j * 12);
        materials.set(
          [...(tr.offset ?? [0, 0]), ...(tr.scale ?? [1, 1])],
          o + 16 + j * 12,
        );
        materials.set(
          [tr.rotation ?? 0, s.wrapS ?? 10497, s.wrapT ?? 10497, 1],
          o + 20 + j * 12,
        );
      },
    );
  });
  const spacing = options.spacing,
    padding = spacing * 0.5;
  const origin = g.bounds.slice(0, 3).map((v) => v - padding);
  const counts = origin.map((v, i) =>
    Math.max(2, Math.ceil((g.bounds[i + 3] + padding - v) / spacing) + 1),
  );
  const total = counts.reduce((a, b) => a * b, 1);
  if (total > 4096)
    throw new Error("GPU probe budget exceeds 4096; increase spacing");
  return {
    nodes: texture(nodeData),
    vertices: texture(vertices),
    uv: texture(uv),
    materials: texture(materials, 12),
    atlas: { width, height, data: atlas },
    grid: {
      origin,
      counts,
      total,
      spacing,
      normalBias: spacing * 0.075,
      rays: options.rays,
      width: counts[0] * counts[1] * 10,
      height: counts[2] * 10,
    },
    bvh: { ...b.stats, triangles: n, nodes, queries: 0 },
    order: b.order.slice(),
  };
}
self.onmessage = async ({ data: m }) => {
  const send = (type, payload) =>
    self.postMessage({ type, id: m.id, ...payload });
  try {
    if (m.type === "load") {
      const preparationStart = performance.now();
      const g = await loadGeometry(m.url, m.axisMatrix, (phase) =>
        send("progress", { phase }),
      );
      send("progress", { phase: "packing GPU BVH" });
      const start = performance.now();
      bvh = new BVH(g, {
        strategy: m.options.bvhStrategy ?? "median",
        bins: m.options.bvhBins ?? 12,
      });
      bvh.stats.buildMilliseconds = performance.now() - start;
      const packet = pack(bvh, m.options);
      packet.bvh.prepareMilliseconds = performance.now() - preparationStart;
      self.postMessage({ type: "prepared", packet }, [
        packet.nodes.data.buffer,
        packet.vertices.data.buffer,
        packet.uv.data.buffer,
        packet.materials.data.buffer,
        packet.atlas.data.buffer,
        packet.order.buffer,
      ]);
    } else if (m.type === "referenceTrace") {
      send("response", {
        result: m.rays.map((r) => {
          const h = bvh.trace(r.origin, r.direction, {
            ...r,
            accept: (t, u, v) => accepts(bvh.geometry, t, u, v),
          });
          if (h.status === "Hit")
            h.material = bvh.geometry.materialIds[h.triangle];
          return h;
        }),
      });
    } else if (m.type === "surfaces") {
      const g = bvh.geometry,
        result = [];
      for (let t = 0; t < g.materialIds.length; t++)
        if (m.materials.includes(g.materialIds[t])) {
          const position = [0, 1, 2].map(
            (a) =>
              (g.positions[t * 9 + a] +
                g.positions[t * 9 + 3 + a] +
                g.positions[t * 9 + 6 + a]) /
              3,
          );
          result.push({
            position,
            vertices: Array.from(g.positions.subarray(t * 9, t * 9 + 9)),
            triangle: t,
            ...materialAt(g, t, 1 / 3, 1 / 3),
          });
        }
      send("response", { result });
    }
  } catch (e) {
    send("error", { message: e.stack ?? String(e) });
  }
};
