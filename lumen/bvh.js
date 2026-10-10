/** Static local-metre triangle BVH. A bounded traversal returns Unknown, never Miss. */
export class BVH {
  constructor(geometry) {
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
    const build = (start, end) => {
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
        const sorted = order
          .slice(start, end)
          .sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
        for (let i = 0; i < sorted.length; i++) order[start + i] = sorted[i];
        const mid = (start + end) >> 1;
        nodes[id].left = build(start, mid);
        nodes[id].right = build(mid, end);
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
    { maxDistance = 100, budget = 100000, ignore = -1, accept } = {},
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
        this.stack[top++] = c[ci];
        this.stack[top++] = c[ci + 1];
        continue;
      }
      for (let i = c[ci + 2]; i < c[ci + 2] + c[ci + 3]; i++) {
        const t = this.order[i];
        if (t === ignore) continue;
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
        if (distance < 0.0001 || distance >= best) continue;
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
      }
    }
    return result ?? { status: "Miss", distance: maxDistance };
  }
}
