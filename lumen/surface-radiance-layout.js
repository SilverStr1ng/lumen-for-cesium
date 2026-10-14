// Surface-addressed static microtriangles, independent of camera/ROI/probe rays.
// GPU BVH triangle order maps back to the original triangle; no cross-face reuse.
export function surfaceRadianceLayout(
  bvh,
  { spacing = 0.08, maxSamples = 262144 } = {},
) {
  if (
    !Number.isFinite(spacing) ||
    spacing < 0.01 ||
    spacing > 0.5 ||
    !Number.isInteger(maxSamples) ||
    maxSamples < 1 ||
    maxSamples > 262144
  )
    throw Error("Invalid bounded surface layout");
  const g = bvh.geometry,
    metadata = new Float32Array(bvh.order.length * 4),
    plans = [];
  let count = 0,
    unsupported = 0;
  for (let packed = 0; packed < bvh.order.length; packed++) {
    const original = bvh.order[packed],
      m = g.materials[g.materialIds[original]];
    if (m.doubleSided || m.alphaMode === "MASK") {
      metadata.set([0, 0, original, 0], packed * 4);
      unsupported++;
      continue;
    }
    const vertices = [0, 1, 2].map((j) =>
        Array.from(
          g.positions.subarray(original * 9 + j * 3, original * 9 + j * 3 + 3),
        ),
      ),
      edge1 = vertices[1].map((v, k) => v - vertices[0][k]),
      edge2 = vertices[2].map((v, k) => v - vertices[0][k]),
      twiceArea = Math.hypot(
        edge1[1] * edge2[2] - edge1[2] * edge2[1],
        edge1[2] * edge2[0] - edge1[0] * edge2[2],
        edge1[0] * edge2[1] - edge1[1] * edge2[0],
      ),
      n = Math.max(2, Math.ceil(Math.sqrt(twiceArea) / spacing));
    if (n > 256 || count + n * n > maxSamples)
      throw Error(
        `Surface sample budget exceeded at original triangle ${original}: ${count + n * n}/${maxSamples}`,
      );
    metadata.set([count, n, original, 1], packed * 4);
    plans.push({ packed, n, offset: count });
    count += n * n;
  }
  const width = Math.min(1024, Math.max(1, count)),
    height = Math.ceil(count / width),
    samples = new Float32Array(width * height * 4);
  for (const { packed, n, offset } of plans)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        const index = offset + i * (2 * n - i) + 2 * j;
        samples.set(
          [packed + 2, (i + 1 / 3) / n, (j + 1 / 3) / n, 1],
          index * 4,
        );
        if (i + j < n - 1)
          samples.set(
            [packed + 2, (i + 2 / 3) / n, (j + 2 / 3) / n, 1],
            (index + 1) * 4,
          );
      }
  const metaWidth = Math.min(1024, Math.max(1, bvh.order.length)),
    metaHeight = Math.ceil(bvh.order.length / metaWidth),
    packedMetadata = new Float32Array(metaWidth * metaHeight * 4);
  packedMetadata.set(metadata);
  const cpuBytes = samples.byteLength + packedMetadata.byteLength;
  const workerPeakBytes = cpuBytes + metadata.byteLength;
  return {
    samples: { width, height, data: samples },
    metadata: { width: metaWidth, height: metaHeight, data: packedMetadata },
    count,
    unsupported,
    spacing,
    cpuBytes,
    workerPeakBytes,
    gpuBytes:
      samples.byteLength + packedMetadata.byteLength + 2 * width * height * 8,
    peakBytes:
      workerPeakBytes +
      samples.byteLength +
      packedMetadata.byteLength +
      2 * width * height * 8,
    addressing:
      "packed triangle -> original triangle; barycentric microtriangle; no cross-face interpolation",
  };
}
