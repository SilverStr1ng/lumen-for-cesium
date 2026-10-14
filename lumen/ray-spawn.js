// Independent double-precision reference spawning. No production float epsilon.
// Bound barycentric reconstruction in binary64, then leave its uncertainty slab.
export function referenceSpawn(positions, triangle, u, v, normal, direction) {
  const weights = [1 - u - v, u, v],
    gamma = (7 * Number.EPSILON) / (1 - 7 * Number.EPSILON),
    point = [0, 1, 2].map((k) =>
      weights.reduce(
        (s, w, j) => s + w * positions[triangle * 9 + j * 3 + k],
        0,
      ),
    ),
    error = [0, 1, 2].map(
      (k) =>
        gamma *
        weights.reduce(
          (s, w, j) => s + Math.abs(w * positions[triangle * 9 + j * 3 + k]),
          0,
        ),
    );
  const sign =
      normal.reduce((s, n, k) => s + n * direction[k], 0) >= 0 ? 1 : -1,
    distance = error.reduce((s, e, k) => s + e * Math.abs(normal[k]), 0);
  return point.map((p, k) => p + normal[k] * sign * distance);
}
// Test-side binary32 reconstruction envelope; GPU implementation is separate.
// This bounds barycentric evaluation plus a conservative local triangle extent
// allowance. It is not a proof for arbitrary ill-conditioned triangles.
export function floatSpawn(positions, triangle, u, v, normal, direction) {
  const weights = [1 - u - v, u, v],
    gamma = (15 * 2 ** -24) / (1 - 15 * 2 ** -24),
    point = [0, 1, 2].map((k) =>
      Math.fround(
        weights.reduce(
          (s, w, j) =>
            Math.fround(
              s + Math.fround(w * positions[triangle * 9 + j * 3 + k]),
            ),
          0,
        ),
      ),
    ),
    extent = Math.max(
      ...[0, 1, 2].map(
        (k) =>
          Math.abs(
            positions[triangle * 9 + 3 + k] - positions[triangle * 9 + k],
          ) +
          Math.abs(
            positions[triangle * 9 + 6 + k] - positions[triangle * 9 + k],
          ),
      ),
    ),
    error = [0, 1, 2].map(
      (k) =>
        gamma *
        (weights.reduce(
          (s, w, j) => s + Math.abs(w * positions[triangle * 9 + j * 3 + k]),
          0,
        ) +
          extent),
    );
  const sign =
      normal.reduce((s, n, k) => s + n * direction[k], 0) >= 0 ? 1 : -1,
    distance = error.reduce((s, e, k) => s + e * Math.abs(normal[k]), 0),
    bits = new Uint32Array(1),
    f = new Float32Array(bits.buffer);
  return point.map((p, k) => {
    f[0] = p + normal[k] * sign * distance;
    if (normal[k] === 0) return f[0];
    const positive = normal[k] * sign > 0;
    if (f[0] === 0)
      return positive ? 1.401298464324817e-45 : -1.401298464324817e-45;
    bits[0] += f[0] > 0 === positive ? 1 : -1;
    return f[0];
  });
}
