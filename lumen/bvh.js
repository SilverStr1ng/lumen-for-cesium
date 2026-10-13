/** Static local-metre triangle BVH. A bounded traversal returns Unknown, never Miss. */
export class BVH {
  constructor(geometry, { strategy = "median", bins = 12 } = {}) {
    if (!["median", "sah"].includes(strategy))
      throw new Error("Unknown BVH strategy");
    if (!Number.isInteger(bins) || bins < 4 || bins > 64)
      throw new Error("BVH bins must be 4..64");
    let maxDepth = 0;
    this.geometry = geometry;
    const p = geometry.positions,
      n = p.length / 9;
    const centroids = new Float32Array(n * 3),
      tb = new Float32Array(n * 6);
    for (let t = 0; t < n; t++)
      for (let a = 0; a < 3; a++) {
        const v = [p[t * 9 + a], p[t * 9 + 3 + a], p[t * 9 + 6 + a]];
        tb[t * 6 + a] = Math.min(...v);
        tb[t * 6 + 3 + a] = Math.max(...v);
        centroids[t * 3 + a] = (v[0] + v[1] + v[2]) / 3;
      }
    const order = Array.from({ length: n }, (_, i) => i),
      nodes = [];
    const area = (b) => {
      const x = Math.max(0, b[3] - b[0]),
        y = Math.max(0, b[4] - b[1]),
        z = Math.max(0, b[5] - b[2]);
      return 2 * (x * y + y * z + z * x);
    };
    const empty = () => [
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity,
    ];
    const extend = (a, b) => {
      for (let k = 0; k < 3; k++) {
        a[k] = Math.min(a[k], b[k]);
        a[k + 3] = Math.max(a[k + 3], b[k + 3]);
      }
    };
    const build = (start, end, depth = 0) => {
      maxDepth = Math.max(maxDepth, depth);
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++)
        for (let a = 0; a < 3; a++) {
          b[a] = Math.min(b[a], tb[order[i] * 6 + a]);
          b[a + 3] = Math.max(b[a + 3], tb[order[i] * 6 + a + 3]);
        }
      const id = nodes.length;
      nodes.push({ b, start, count: end - start, left: -1, right: -1 });
      if (end - start > 8) {
        let axis = 0;
        for (let a = 1; a < 3; a++)
          if (b[a + 3] - b[a] > b[axis + 3] - b[axis]) axis = a;
        let split;
        if (strategy === "sah" && depth < 48) {
          let best = Infinity;
          for (let candidate = 0; candidate < 3; candidate++) {
            let low = Infinity,
              high = -Infinity;
            for (let i = start; i < end; i++) {
              const v = centroids[order[i] * 3 + candidate];
              low = Math.min(low, v);
              high = Math.max(high, v);
            }
            if (!(high > low)) continue;
            const bucket = (t) =>
              Math.min(
                bins - 1,
                Math.floor(
                  ((centroids[t * 3 + candidate] - low) / (high - low)) * bins,
                ),
              );
            const counts = new Uint32Array(bins),
              boxes = Array.from({ length: bins }, empty);
            for (let i = start; i < end; i++) {
              const t = order[i],
                k = bucket(t);
              counts[k]++;
              extend(boxes[k], tb.subarray(t * 6, t * 6 + 6));
            }
            const rightCost = new Float64Array(bins);
            let right = empty(),
              count = 0;
            for (let k = bins - 1; k > 0; k--) {
              if (counts[k]) extend(right, boxes[k]);
              count += counts[k];
              rightCost[k] = count ? count * area(right) : 0;
            }
            let left = empty();
            count = 0;
            for (let k = 0; k < bins - 1; k++) {
              if (counts[k]) extend(left, boxes[k]);
              count += counts[k];
              if (!count || count === end - start) continue;
              const cost = count * area(left) + rightCost[k + 1];
              if (cost < best) {
                best = cost;
                split = { bucket, k };
              }
            }
          }
        }
        let mid;
        if (split) {
          const left = [],
            right = [];
          for (let i = start; i < end; i++)
            (split.bucket(order[i]) <= split.k ? left : right).push(order[i]);
          const sorted = left.concat(right);
          for (let i = 0; i < sorted.length; i++) order[start + i] = sorted[i];
          mid = start + left.length;
        } else {
          const sorted = order
            .slice(start, end)
            .sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
          for (let i = 0; i < sorted.length; i++) order[start + i] = sorted[i];
          mid = (start + end) >> 1;
        }
        nodes[id].left = build(start, mid, depth + 1);
        nodes[id].right = build(mid, end, depth + 1);
        nodes[id].count = 0;
      }
      return id;
    };
    if (!n) throw new Error("BVH requires triangles");
    build(0, n);
    this.order = Uint32Array.from(order);
    this.bounds = new Float32Array(nodes.length * 6);
    this.children = new Int32Array(nodes.length * 4);
    nodes.forEach((node, i) => {
      this.bounds.set(
        node.b.map((v, a) => v + (a < 3 ? -1e-5 : 1e-5)),
        i * 6,
      );
      this.children.set([node.left, node.right, node.start, node.count], i * 4);
    });
    this.stats = {
      persistentBytes:
        this.order.byteLength +
        this.bounds.byteLength +
        this.children.byteLength +
        128 * 4,
      strategy,
      bins,
      maxDepth,
      triangles: n,
      nodes: nodes.length,
      queries: 0,
      unknown: 0,
      alphaRejected: 0,
    };
    this.stack = new Int32Array(128);
  }
  trace(
    origin,
    direction,
    {
      maxDistance = 100,
      budget = 100000,
      ignore = -1,
      accept,
      anyHit = false,
      counters,
      tieBreak,
    } = {},
  ) {
    this.stats.queries++;
    const p = this.geometry.positions,
      b = this.bounds,
      c = this.children,
      inv = direction.map((v) => 1 / v);
    let top = 1,
      visits = 0,
      best = maxDistance,
      result;
    this.stack[0] = 0;
    while (top) {
      if (++visits > budget) {
        this.stats.unknown++;
        return { status: "Unknown", visits };
      }
      if (counters) counters.nodes = (counters.nodes ?? 0) + 1;
      const node = this.stack[--top],
        bi = node * 6;
      let near = 0,
        far = best;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(direction[a]) < 1e-12) {
          if (origin[a] < b[bi + a] || origin[a] > b[bi + a + 3]) {
            far = -1;
            break;
          }
          continue;
        }
        const t1 = (b[bi + a] - origin[a]) * inv[a],
          t2 = (b[bi + a + 3] - origin[a]) * inv[a];
        near = Math.max(near, Math.min(t1, t2));
        far = Math.min(far, Math.max(t1, t2));
      }
      if (far < near) continue;
      const ci = node * 4;
      if (!c[ci + 3]) {
        if (top + 2 > this.stack.length) {
          this.stats.unknown++;
          return { status: "Unknown", visits };
        }
        this.stack[top++] = c[ci];
        this.stack[top++] = c[ci + 1];
        continue;
      }
      for (let i = c[ci + 2]; i < c[ci + 2] + c[ci + 3]; i++) {
        const t = this.order[i];
        if (t === ignore) continue;
        if (counters) counters.triangles = (counters.triangles ?? 0) + 1;
        const o = t * 9;
        const ax = p[o + 3] - p[o],
          ay = p[o + 4] - p[o + 1],
          az = p[o + 5] - p[o + 2];
        const bx = p[o + 6] - p[o],
          by = p[o + 7] - p[o + 1],
          bz = p[o + 8] - p[o + 2];
        const hx = direction[1] * bz - direction[2] * by,
          hy = direction[2] * bx - direction[0] * bz,
          hz = direction[0] * by - direction[1] * bx;
        const det = ax * hx + ay * hy + az * hz;
        if (Math.abs(det) < 1e-10) continue;
        const sx = origin[0] - p[o],
          sy = origin[1] - p[o + 1],
          sz = origin[2] - p[o + 2],
          invDet = 1 / det;
        const u = (sx * hx + sy * hy + sz * hz) * invDet;
        if (u < 0 || u > 1) continue;
        const qx = sy * az - sz * ay,
          qy = sz * ax - sx * az,
          qz = sx * ay - sy * ax;
        const v =
          (direction[0] * qx + direction[1] * qy + direction[2] * qz) * invDet;
        if (v < 0 || u + v > 1) continue;
        const distance = (bx * qx + by * qy + bz * qz) * invDet;
        if (
          distance < 0.0001 ||
          distance > best ||
          (distance === best &&
            (!result ||
              !tieBreak?.({ triangle: t, backface: det < 0 }, result)))
        )
          continue;
        if (counters && accept) counters.accept = (counters.accept ?? 0) + 1;
        if (accept && !accept(t, u, v)) {
          this.stats.alphaRejected++;
          continue;
        }
        best = distance;
        result = {
          status: "Hit",
          triangle: t,
          u,
          v,
          distance,
          backface: det < 0,
        };
        if (anyHit) return result;
      }
    }
    return result ?? { status: "Miss", distance: maxDistance };
  }
}
