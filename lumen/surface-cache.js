import { add, mul, dot, normalize } from "./math.js";
import { materialAt, accepts } from "./gltf.js";
import { completeTraceDistance } from "./trace-domain.js";

const barycentrics = [
  [1 / 3, 1 / 3],
  [0.12, 0.12],
  [0.76, 0.12],
  [0.12, 0.76],
];
/** Four local surfels per triangle per side, allocated only when a probe sees them.
 * Cache stores outgoing diffuse radiance, never shaded camera colour or irradiance.
 */
export class SurfaceCache {
  constructor(bvh) {
    this.bvh = bvh;
    this.geometry = bvh.geometry;
    this.entries = new Map();
    this.revision = 0;
  }
  address(hit) {
    let slot = 0,
      best = Infinity;
    for (let i = 0; i < 4; i++) {
      const b = barycentrics[i],
        d = (hit.u - b[0]) ** 2 + (hit.v - b[1]) ** 2;
      if (d < best) {
        slot = i;
        best = d;
      }
    }
    const backside =
      hit.backface &&
      this.geometry.materials[this.geometry.materialIds[hit.triangle]]
        .doubleSided;
    const key = hit.triangle * 8 + slot * 2 + (backside ? 1 : 0);
    if (!this.entries.has(key)) {
      const t = hit.triangle,
        p = this.geometry.positions,
        o = t * 9;
      let [u, v] = barycentrics[slot];
      const m = this.geometry.materials[this.geometry.materialIds[t]];
      if (
        m.alphaMode === "MASK" &&
        materialAt(this.geometry, t, u, v).alpha < (m.alphaCutoff ?? 0.5)
      ) {
        u = hit.u;
        v = hit.v;
      }
      const position = [0, 1, 2].map(
        (a) => p[o + a] * (1 - u - v) + p[o + 3 + a] * u + p[o + 6 + a] * v,
      );
      const material = materialAt(this.geometry, t, u, v);
      if (backside) material.normal = mul(material.normal, -1);
      this.entries.set(key, {
        key,
        triangle: t,
        u,
        v,
        position,
        ...material,
        direct: [0, 0, 0],
        outgoing: [0, 0, 0],
        valid: true,
      });
    }
    return key;
  }
  relight(options) {
    const sun = normalize(options.sunDirection),
      accept = (t, u, v) => accepts(this.geometry, t, u, v);
    for (const entry of this.entries.values()) {
      const material = materialAt(
        this.geometry,
        entry.triangle,
        entry.u,
        entry.v,
        options.neutralMaterials ?? [],
      );
      entry.albedo = material.albedo;
      entry.emissive = material.emissive;
      const cosine = Math.max(0, dot(entry.normal, sun));
      const shadowOrigin = add(entry.position, mul(entry.normal, 0.015));
      const shadow =
        cosine > 0
          ? this.bvh.trace(shadowOrigin, sun, {
              ignore: entry.triangle,
              accept,
              budget: options.traversalBudget,
              maxDistance: completeTraceDistance(this.geometry.bounds, shadowOrigin),
            })
          : { status: "Hit" };
      entry.valid = shadow.status !== "Unknown";
      entry.direct = options.sunRadiance.map(
        (c) => c * cosine * (shadow.status === "Miss" ? 1 : 0),
      );
    }
    this.revision++;
  }
  bounce(previous) {
    for (const entry of this.entries.values()) {
      const indirect = previous
        ? previous.sample(entry.position, entry.normal).irradiance
        : [0, 0, 0];
      entry.outgoing = entry.albedo.map(
        (a, i) =>
          (a * (entry.direct[i] + indirect[i])) / Math.PI + entry.emissive[i],
      );
    }
  }
  diagnostics() {
    const materials = {};
    for (const e of this.entries.values()) {
      const m = (materials[e.material] ??= {
        count: 0,
        albedo: [0, 0, 0],
        outgoing: [0, 0, 0],
        position: [0, 0, 0],
      });
      m.count++;
      for (let i = 0; i < 3; i++) {
        m.albedo[i] += e.albedo[i];
        m.outgoing[i] += e.outgoing[i];
        m.position[i] += e.position[i];
      }
    }
    for (const m of Object.values(materials))
      for (const key of ["albedo", "outgoing", "position"])
        m[key] = m[key].map((v) => v / m.count);
    return {
      surfels: this.entries.size,
      revision: this.revision,
      unknown: [...this.entries.values()].filter((e) => !e.valid).length,
      materials,
    };
  }
}
