import {
  add,
  sub,
  mul,
  dot,
  normalize,
  clamp,
  octEncode,
  octDecode,
  fibonacci,
} from "./math.js";
import { accepts } from "./gltf.js";
import { SurfaceCache } from "./surface-cache.js";
import { completeTraceDistance } from "./trace-domain.js";

export const TILE = 8;
export const BORDERED = TILE + 2;
const yieldTask = () => new Promise((r) => setTimeout(r, 0));
function atlasIndex(grid, probe, x, y) {
  return (
    ((Math.floor(probe / (grid.counts[0] * grid.counts[1])) * BORDERED + y) *
      grid.width +
      (probe % (grid.counts[0] * grid.counts[1])) * BORDERED +
      x) *
    4
  );
}
function copyBorder(data, grid) {
  for (let p = 0; p < grid.total; p++) {
    const copy = (x, y, a, b) =>
      data.set(
        data.subarray(atlasIndex(grid, p, a, b), atlasIndex(grid, p, a, b) + 4),
        atlasIndex(grid, p, x, y),
      );
    for (let i = 1; i <= TILE; i++) {
      copy(0, i, 1, TILE + 1 - i);
      copy(TILE + 1, i, TILE, TILE + 1 - i);
      copy(i, 0, TILE + 1 - i, 1);
      copy(i, TILE + 1, TILE + 1 - i, TILE);
    }
    copy(0, 0, TILE, TILE);
    copy(TILE + 1, 0, 1, TILE);
    copy(0, TILE + 1, TILE, 1);
    copy(TILE + 1, TILE + 1, 1, 1);
  }
}
function atlasSample(data, grid, probe, n) {
  const uv = octEncode(n),
    x = uv[0] * TILE + 0.5,
    y = uv[1] * TILE + 0.5,
    ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy,
    out = [0, 0, 0, 0];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const o = atlasIndex(grid, probe, ix + i, iy + j),
        w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      for (let k = 0; k < 4; k++) out[k] += data[o + k] * w;
    }
  return out;
}
export class ProbeField {
  constructor(grid, positions, irradiance, moments) {
    Object.assign(this, { grid, positions, irradiance, moments });
  }
  sample(position, normal, visibility = true) {
    const g = this.grid,
      n = normalize(normal),
      q = position.map((v, i) => (v - g.origin[i]) / g.spacing);
    if (q.some((v, i) => v < 0 || v > g.counts[i] - 1))
      return { irradiance: [0, 0, 0], coverage: 0 };
    const base = q.map((v, i) => clamp(Math.floor(v), 0, g.counts[i] - 2)),
      fraction = q.map((v, i) => v - base[i]);
    const biased = add(position, mul(n, g.normalBias)),
      sum = [0, 0, 0];
    let weights = 0,
      available = 0;
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const index =
            base[0] +
            x +
            g.counts[0] * (base[1] + y + g.counts[1] * (base[2] + z));
          const trilinear =
            (x ? fraction[0] : 1 - fraction[0]) *
            (y ? fraction[1] : 1 - fraction[1]) *
            (z ? fraction[2] : 1 - fraction[2]);
          if (this.positions[index * 4 + 3] < 0.5) continue;
          const probe = Array.from(
              this.positions.subarray(index * 4, index * 4 + 3),
            ),
            delta = sub(biased, probe),
            distance = Math.hypot(...delta),
            d = normalize(delta);
          const e = atlasSample(this.irradiance, g, index, n),
            m = atlasSample(this.moments, g, index, d);
          if (e[3] < 0.95 || m[3] < 0.95) continue;
          available += trilinear;
          const towardProbe = normalize(sub(probe, position)),
            wrap = (dot(towardProbe, n) + 1) * 0.5;
          let w = trilinear * Math.max(0.05, wrap * wrap);
          if (visibility && distance > m[0]) {
            const variance = Math.max(0.0001, m[1] - m[0] * m[0]),
              v = variance / (variance + (distance - m[0]) ** 2);
            w *= Math.max(0.000001, v ** 3);
          }
          if (w < 0.2) w *= (w * w) / 0.04;
          weights += w;
          for (let k = 0; k < 3; k++) sum[k] += e[k] * w;
        }
    return {
      irradiance: weights > 1e-10 ? sum.map((v) => v / weights) : [0, 0, 0],
      coverage: weights > 1e-10 ? clamp(available, 0, 1) : 0,
    };
  }
}
/** Visibility-aware directional irradiance + distance moments, with snapshot bounces. */
export class DDGI {
  constructor(bvh, options) {
    this.bvh = bvh;
    this.cache = new SurfaceCache(bvh);
    this.options = options;
    const spacing = options.spacing ?? 2,
      b = bvh.geometry.bounds,
      padding = spacing * 0.5;
    const origin = [b[0] - padding, b[1] - padding, b[2] - padding];
    const counts = origin.map((v, i) =>
      Math.max(2, Math.ceil((b[i + 3] + padding - v) / spacing) + 1),
    );
    const total = counts[0] * counts[1] * counts[2];
    if (total > 4096)
      throw new Error(
        `Probe budget exceeded: ${total} > 4096; increase spacing`,
      );
    const rays = options.rays ?? 128;
    if (!Number.isInteger(rays) || rays < 32 || rays > 512)
      throw new Error("rays must be an integer in [32,512]");
    this.grid = {
      origin,
      counts,
      spacing,
      total,
      width: BORDERED * counts[0] * counts[1],
      height: BORDERED * counts[2],
      normalBias: spacing * 0.075,
      rays,
    };
    if (
      Math.max(this.grid.width, this.grid.height) >
      (options.maxTextureSize ?? 16384)
    )
      throw new Error("Probe atlas exceeds device maximum texture size");
    this.positions = new Float32Array(total * 4);
    this.directions = fibonacci(rays);
    this.hits = new Array(total * rays);
    this.samples = [];
    this.weights = Array.from({ length: TILE * TILE }, (_, i) => {
      const d = octDecode(
        (((i % TILE) + 0.5) / TILE) * 2 - 1,
        ((Math.floor(i / TILE) + 0.5) / TILE) * 2 - 1,
      );
      return this.directions.map((r) => ({
        cosine: (Math.max(0, dot(d, r)) * 4 * Math.PI) / rays,
        moment: Math.max(0, dot(d, r)) ** 16,
      }));
    });
  }
  async initialize(progress, cancelled) {
    const g = this.grid,
      accept = (t, u, v) => accepts(this.bvh.geometry, t, u, v);
    let active = 0;
    for (let p = 0; p < g.total; p++) {
      if (cancelled()) return false;
      const coordinates = [
        p % g.counts[0],
        Math.floor(p / g.counts[0]) % g.counts[1],
        Math.floor(p / (g.counts[0] * g.counts[1])),
      ];
      const position = coordinates.map((v, i) => g.origin[i] + v * g.spacing);
      // Relocate probes out of very near solid back faces, in local metres.
      for (let attempt = 0; attempt < 3; attempt++) {
        let nearest;
        for (const d of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          const h = this.bvh.trace(position, d, {
            accept,
            maxDistance: g.spacing * 0.3,
            budget: this.options.traversalBudget,
          });
          if (
            h.status === "Hit" &&
            h.backface &&
            !this.bvh.geometry.materials[
              this.bvh.geometry.materialIds[h.triangle]
            ].doubleSided &&
            (!nearest || h.distance < nearest.distance)
          )
            nearest = h;
        }
        if (!nearest) break;
        const n = Array.from(
          this.bvh.geometry.normals.subarray(
            nearest.triangle * 3,
            nearest.triangle * 3 + 3,
          ),
        );
        const shift = mul(n, nearest.distance + 0.08);
        for (let i = 0; i < 3; i++) position[i] += shift[i];
      }
      let backfaces = 0,
        known = 0,
        hits = 0;
      for (let r = 0; r < g.rays; r++) {
        const hit = this.bvh.trace(position, this.directions[r], {
          accept,
          maxDistance: completeTraceDistance(this.bvh.geometry.bounds, position),
          budget: this.options.traversalBudget,
        });
        if (hit.status !== "Unknown") known++;
        if (hit.status === "Hit") {
          hits++;
          const doubleSided =
            this.bvh.geometry.materials[
              this.bvh.geometry.materialIds[hit.triangle]
            ].doubleSided;
          if (hit.backface && !doubleSided) {
            backfaces++;
            hit.black = true;
          } else hit.key = this.cache.address(hit);
        }
        this.hits[p * g.rays + r] = hit;
      }
      const valid = known === g.rays && backfaces / g.rays < 0.25;
      this.positions.set([...position, valid ? 1 : 0], p * 4);
      if (valid) active++;
      if (p % 16 === 0) {
        progress({ phase: "tracing", completed: p, total: g.total });
        await yieldTask();
      }
    }
    this.active = active;
    return true;
  }
  async solve(options, progress, cancelled, onGeneration) {
    if (!["sphere", "upper-hemisphere"].includes(options.environmentMode ?? "sphere"))
      throw new Error("environmentMode must be sphere or upper-hemisphere");
    for (const key of ["sunDirection", "sunRadiance", "skyRadiance"])
      if (
        !Array.isArray(options[key]) ||
        options[key].length !== 3 ||
        !options[key].every(
          (v) => Number.isFinite(v) && (key === "sunDirection" || v >= 0),
        )
      )
        throw new Error(
          `${key} requires three finite components (radiance must be nonnegative)`,
        );
    if (Math.hypot(...options.sunDirection) < 1e-8)
      throw new Error("sunDirection must not be zero");
    this.cache.relight(options);
    let previous;
    const history = [];
    for (let bounce = 1; bounce <= options.bounces; bounce++) {
      if (cancelled()) return;
      this.cache.bounce(previous);
      const g = this.grid,
        data = new Float32Array(g.width * g.height * 4),
        moments = new Float32Array(data.length);
      let energy = 0;
      for (let p = 0; p < g.total; p++) {
        if (cancelled()) return;
        if (this.positions[p * 4 + 3] < 0.5) continue;
        const radiance = this.directions.map((d, r) => {
          const h = this.hits[p * g.rays + r];
          if (h.status === "Miss") return options.environmentMode === "upper-hemisphere" && d[2] < 0
            ? [0, 0, 0] : options.skyRadiance;
          if (h.status === "Unknown") return undefined;
          if (h.black) return [0, 0, 0];
          const e = this.cache.entries.get(h.key);
          return e.valid ? e.outgoing : undefined;
        });
        const known = radiance.filter(Boolean).length / g.rays;
        for (let i = 0; i < TILE * TILE; i++) {
          const rgb = [0, 0, 0];
          let mean = 0,
            second = 0,
            weight = 0;
          for (let r = 0; r < g.rays; r++) {
            if (!radiance[r]) continue;
            const w = this.weights[i][r];
            for (let k = 0; k < 3; k++) rgb[k] += radiance[r][k] * w.cosine;
            const distance = Math.min(
              this.hits[p * g.rays + r].distance,
              g.spacing * 8,
            );
            mean += distance * w.moment;
            second += distance * distance * w.moment;
            weight += w.moment;
          }
          const o = atlasIndex(g, p, (i % TILE) + 1, Math.floor(i / TILE) + 1);
          data.set([...rgb, known], o);
          moments.set(
            [mean / (weight || 1), second / (weight || 1), 0, known],
            o,
          );
          energy += rgb[0] + rgb[1] + rgb[2];
        }
        if (p % 32 === 0) {
          progress({
            phase: "integrating",
            bounce,
            completed: p,
            total: g.total,
          });
          await yieldTask();
        }
      }
      copyBorder(data, g);
      copyBorder(moments, g);
      previous = new ProbeField(g, this.positions, data, moments);
      this.field = previous;
      history.push({ bounce, energy });
      // Previous generation remains immutable until all surfels/probes finish this generation.
      onGeneration({
        grid: g,
        positions: this.positions.slice(),
        irradiance: data.slice(),
        moments: moments.slice(),
        bounce,
        history: [...history],
        active: this.active,
        cache: this.cache.diagnostics(),
        bvh: { ...this.bvh.stats },
      });
    }
    this.history = history;
  }
}
