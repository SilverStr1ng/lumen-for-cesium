// Independent finite-depth path integral. Does not import DDGI, probe gather,
// SurfaceCache or the GPU estimator. Static Lambert macro-normal contract.
import { materialAt, accepts } from "./gltf.js";
import { completeTraceDistance } from "./trace-domain.js";
import { normalize, cross, dot, add, mul } from "./math.js";
export function referenceIrradiance(
  bvh,
  position,
  normal,
  lighting,
  samples = 8192,
  seed = 543190,
  geometricNormal = normal,
) {
  const geometry = bvh.geometry,
    sun = normalize(lighting.sunDirection),
    counts = { rays: 0, solar: 0, unknown: 0 };
  const accept = (t, u, v) => accepts(geometry, t, u, v);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const cosine = (n) => {
    const u = random(),
      v = random(),
      r = Math.sqrt(u),
      phi = 2 * Math.PI * v,
      t = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], n)),
      b = cross(n, t);
    return n.map(
      (x, i) =>
        t[i] * r * Math.cos(phi) +
        b[i] * r * Math.sin(phi) +
        x * Math.sqrt(1 - u),
    );
  };
  const sum = [0, 0, 0],
    squares = [0, 0, 0];
  for (let sample = 0; sample < samples; sample++) {
    let origin = add(position, mul(geometricNormal, 0.0002)),
      direction = cosine(normal),
      ignore = -1;
    const value = [0, 0, 0],
      throughput = [1, 1, 1],
      receiverValid = dot(direction, geometricNormal) > 0;
    // Receiver-only Ns cosine PDF with Ng's true hemisphere. Known-zero samples
    // remain in the sample count, without renormalization or rejection sampling.
    for (let bounce = 0; bounce < lighting.bounces && receiverValid; bounce++) {
      counts.rays++;
      const h = bvh.trace(origin, direction, {
        accept,
        ignore,
        maxDistance: completeTraceDistance(geometry.bounds, origin),
      });
      if (h.status === "Unknown") {
        counts.unknown++;
        throw Error("Unknown independent reference ray");
      }
      if (h.status === "Miss") {
        if (
          lighting.environmentMode !== "upper-hemisphere" ||
          direction[2] >= 0
        )
          for (let k = 0; k < 3; k++)
            value[k] += throughput[k] * lighting.skyRadiance[k];
        break;
      }
      const m = materialAt(geometry, h.triangle, h.u, h.v),
        t = h.triangle * 9;
      if (h.backface && !geometry.materials[m.material].doubleSided) break;
      const p = [0, 1, 2].map(
          (i) =>
            geometry.positions[t + i] * (1 - h.u - h.v) +
            geometry.positions[t + 3 + i] * h.u +
            geometry.positions[t + 6 + i] * h.v,
        ),
        n = h.backface ? mul(m.normal, -1) : m.normal;
      const c = Math.max(0, dot(n, sun)),
        solarOrigin = add(p, mul(n, 0.015));
      let visible = false;
      if (c > 0 && lighting.sunRadiance.some((v) => v > 0)) {
        counts.solar++;
        const s = bvh.trace(solarOrigin, sun, {
          accept,
          ignore: h.triangle,
          maxDistance: completeTraceDistance(geometry.bounds, solarOrigin),
        });
        if (s.status === "Unknown") throw Error("Unknown reference sun ray");
        visible = s.status === "Miss";
      }
      for (let k = 0; k < 3; k++) {
        value[k] +=
          throughput[k] *
          (m.emissive[k] +
            (m.albedo[k] * lighting.sunRadiance[k] * c * (visible ? 1 : 0)) /
              Math.PI);
        throughput[k] *= m.albedo[k];
      }
      origin = add(p, mul(n, 0.0002));
      direction = cosine(n);
      ignore = h.triangle;
    }
    for (let k = 0; k < 3; k++) {
      sum[k] += value[k];
      squares[k] += value[k] * value[k];
    }
  }
  return {
    irradiance: sum.map((v) => (Math.PI * v) / samples),
    standardError: sum.map(
      (v, k) =>
        Math.PI *
        Math.sqrt(
          Math.max(0, squares[k] / samples - (v / samples) ** 2) / samples,
        ),
    ),
    valid: true,
    counts,
    samples,
    seed,
  };
}
