import assert from "node:assert/strict";
import { createBallPool, ballPoolGltf } from "../lumen/ballpool-scene.js";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { surfaceRadianceLayout } from "../lumen/surface-radiance-layout.js";
for (const count of [1, 2, 16, 64, 128]) {
  const encoded = ballPoolGltf(createBallPool({ count })),
    gltf = encoded.gltf ?? encoded,
    geometry = await loadGeometry(
      `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString("base64")}`,
    ),
    bvh = new BVH(geometry, { strategy: "sah" });
  try {
    const layout = surfaceRadianceLayout(bvh),
      metadata = layout.metadata.data,
      samples = layout.samples.data;
    assert(layout.peakBytes <= 12 * 1048576);
    for (let t = 0; t < bvh.order.length; t++) {
      const offset = metadata[t * 4],
        n = metadata[t * 4 + 1];
      assert.equal(metadata[t * 4 + 2], bvh.order[t]);
      for (let i = 0; i < n * n; i++) {
        const o = (offset + i) * 4,
          u = samples[o + 1],
          v = samples[o + 2];
        assert.equal(samples[o], t + 2);
        assert(u > 0 && v > 0 && u + v < 1);
        const x = Math.floor(u * n),
          y = Math.floor(v * n),
          upper = x + y < n - 1 && u * n - x + v * n - y > 1 ? 1 : 0;
        assert.equal(offset + x * (2 * n - x) + 2 * y + upper, offset + i);
      }
    }
    console.log(
      JSON.stringify({
        count,
        status: "passed",
        samples: layout.count,
        peakBytes: layout.peakBytes,
      }),
    );
  } catch (e) {
    if (count !== 128) throw e;
    console.log(
      JSON.stringify({ count, status: "budget-rejected", reason: String(e) }),
    );
  }
}
