// Offline diagnostics only: preserve production's receiver sequence and denominator.
import { fgSquare } from "./fg-sampling.js";
import { add, mul, dot, cross, normalize } from "./math.js";
import { materialAt } from "./gltf.js";
import { referenceIrradiance } from "./path-reference.js";
export function receiverRays(point, samples, seed, epoch) {
  const ns = point.normal,
    ng = point.geometricNormal,
    t = normalize(cross(Math.abs(ns[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], ns)),
    b = cross(ns, t);
  return Array.from({ length: samples }, (_, i) => {
    const [u, v] = fgSquare(i, samples, point.pixel, epoch, seed);
    const direction = ns.map(
      (n, k) =>
        t[k] * Math.sqrt(u) * Math.cos(2 * Math.PI * v) +
        b[k] * Math.sqrt(u) * Math.sin(2 * Math.PI * v) +
        n * Math.sqrt(1 - u),
    );
    return {
      origin: add(point.position, mul(ng, 0.0002)).map(Math.fround),
      direction: direction.map(Math.fround),
      knownZero: dot(ng, direction) <= 0,
    };
  });
}
export function oracleRemainder(
  bvh,
  diagnostic,
  lighting,
  depth,
  samples = 2048,
) {
  return diagnostic.hit.map((h, i) => {
    if (Math.abs(h[0]) <= 1 || diagnostic.position[i][3] === 0 || depth === 1)
      return { radiance: [0, 0, 0], standardError: [0, 0, 0] };
    const p = diagnostic.position[i].slice(0, 3),
      n = diagnostic.normal[i].slice(0, 3),
      m = materialAt(bvh.geometry, Math.abs(h[0]) - 2, h[1], h[2]),
      ref = referenceIrradiance(
        bvh,
        p,
        n,
        { ...lighting, bounces: depth - 1 },
        samples,
        173 + i,
        n,
      );
    return {
      radiance: ref.irradiance.map((v, k) => (v * m.albedo[k]) / Math.PI),
      standardError: ref.standardError.map(
        (v, k) => (v * m.albedo[k]) / Math.PI,
      ),
    };
  });
}
export function integrateParts(rays, diagnostic, oracle, depth) {
  const terms = {
      sky: [0, 0, 0],
      emission: [0, 0, 0],
      sun: [0, 0, 0],
      ddgi: [0, 0, 0],
      oracle: [0, 0, 0],
    },
    counts = { unknown: 0, missing: 0, knownZero: 0 };
  rays.forEach((r, i) => {
    if (r.knownZero) {
      counts.knownZero++;
      return;
    }
    if (diagnostic.hit[i][0] === -1 || diagnostic.sun[i][3] < 0)
      counts.unknown++;
    if (
      depth > 1 &&
      diagnostic.ddgi[i][3] <= 0 &&
      Math.abs(diagnostic.hit[i][0]) > 1
    )
      counts.missing++;
    for (const name of Object.keys(terms))
      for (let k = 0; k < 3; k++)
        terms[name][k] +=
          ((name === "oracle"
            ? oracle[i].radiance[k]
            : name === "ddgi" && depth === 1
              ? 0
              : diagnostic[name][i][k]) *
            Math.PI) /
          rays.length;
  });
  return {
    terms,
    counts,
    instant: [0, 1, 2].map(
      (k) => terms.sky[k] + terms.emission[k] + terms.sun[k] + terms.ddgi[k],
    ),
    oracleReplaced: [0, 1, 2].map(
      (k) => terms.sky[k] + terms.emission[k] + terms.sun[k] + terms.oracle[k],
    ),
  };
}
