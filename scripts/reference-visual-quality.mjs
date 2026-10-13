// Independent cosine-weighted path reference: no probe interpolation or SurfaceCache.
import { readFile, writeFile } from "node:fs/promises";
import { loadGeometry, materialAt, accepts } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { completeTraceDistance } from "../lumen/trace-domain.js";
import { normalize, cross, dot, add, mul } from "../lumen/math.js";
const directory = "reports/ddgi-visual-quality-v4",
  labels = ["before", "solid-only", "spatial", "after", "fine"];
const inputs = Object.fromEntries(
  await Promise.all(
    labels.map(async (label) => [
      label,
      JSON.parse(
        await readFile(directory + "/" + label + "/diagnostics.json", "utf8"),
      ),
    ]),
  ),
);
const g = await loadGeometry(
    "http://localhost:8090/fixtures/earth-pavilion.gltf",
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ),
  bvh = new BVH(g, { strategy: "sah" });
const light = inputs.before.settings.lighting,
  sun = normalize(light.sunDirection),
  samples = 8192;
let seed = 543190;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed + 0.5) / 4294967296;
};
function cosine(n) {
  const u = random(),
    v = random(),
    r = Math.sqrt(u),
    phi = 2 * Math.PI * v;
  const tangent = normalize(
      cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], n),
    ),
    bitangent = cross(n, tangent);
  return [0, 1, 2].map(
    (i) =>
      tangent[i] * r * Math.cos(phi) +
      bitangent[i] * r * Math.sin(phi) +
      n[i] * Math.sqrt(1 - u),
  );
}
const accept = (t, u, v) => accepts(g, t, u, v);
function incoming(origin, direction) {
  const value = [0, 0, 0],
    throughput = [1, 1, 1];
  let o = origin,
    d = direction,
    ignore = -1;
  for (let bounce = 0; bounce < light.bounces; bounce++) {
    const h = bvh.trace(o, d, {
      accept,
      ignore,
      maxDistance: completeTraceDistance(g.bounds, o),
    });
    if (h.status === "Unknown")
      throw Error("Unknown independent reference ray");
    if (h.status === "Miss") {
      for (let c = 0; c < 3; c++)
        value[c] += throughput[c] * (d[2] >= 0 ? light.skyRadiance[c] : 0);
      break;
    }
    const m = materialAt(g, h.triangle, h.u, h.v),
      t = h.triangle * 9;
    if (h.backface && !g.materials[m.material].doubleSided) break;
    const p = [0, 1, 2].map(
        (i) =>
          g.positions[t + i] * (1 - h.u - h.v) +
          g.positions[t + 3 + i] * h.u +
          g.positions[t + 6 + i] * h.v,
      ),
      n = h.backface ? mul(m.normal, -1) : m.normal;
    const c = Math.max(0, dot(n, sun)),
      shadowOrigin = add(p, mul(n, 0.015)),
      visible =
        c > 0 &&
        bvh.trace(shadowOrigin, sun, {
          accept,
          ignore: h.triangle,
          maxDistance: completeTraceDistance(g.bounds, shadowOrigin),
        }).status === "Miss";
    for (let k = 0; k < 3; k++) {
      value[k] +=
        throughput[k] *
        (m.emissive[k] +
          (m.albedo[k] * light.sunRadiance[k] * c * (visible ? 1 : 0)) /
            Math.PI);
      throughput[k] *= m.albedo[k];
    }
    o = add(p, mul(n, 0.0002));
    d = cosine(n);
    ignore = h.triangle;
  }
  return value;
}
const scans = {};
for (const [name, line] of Object.entries(inputs.before.receivers.scans)) {
  scans[name] = [];
  for (let index = 0; index < line.length; index += 4) {
    const { position, normal } = line[index],
      sum = [0, 0, 0],
      squares = [0, 0, 0];
    for (let i = 0; i < samples; i++) {
      const v = incoming(add(position, mul(normal, 0.0002)), cosine(normal));
      for (let k = 0; k < 3; k++) {
        sum[k] += v[k];
        squares[k] += v[k] * v[k];
      }
    }
    const E = sum.map((v) => (Math.PI * v) / samples),
      standardError = sum.map(
        (v, k) =>
          Math.PI *
          Math.sqrt(
            Math.max(0, squares[k] / samples - (v / samples) ** 2) / samples,
          ),
      );
    scans[name].push({
      index,
      position,
      normal,
      E,
      standardError,
      ddgi: Object.fromEntries(
        labels.map((label) => [
          label,
          inputs[label].receivers.scans[name][index].gpu,
        ]),
      ),
    });
  }
  console.log("REFERENCE", name);
}
const error = {},
  composedError = {};
for (const label of labels) {
  error[label] = {};
  composedError[label] = {};
  for (const [name, points] of Object.entries(scans)) {
    const differences = points.flatMap((p) =>
      p.E.map((v, k) => p.ddgi[label].irradiance[k] - v),
    );
    const composed = points.flatMap((p) =>
      p.E.map(
        (v, k) =>
          p.ddgi[label].irradiance[k] *
            (["after", "fine"].includes(label) ? 1 : p.ddgi[label].coverage) -
          v,
      ),
    );
    composedError[label][name] = {
      mae: composed.reduce((s, v) => s + Math.abs(v), 0) / composed.length,
      rmse: Math.sqrt(
        composed.reduce((s, v) => s + v * v, 0) / composed.length,
      ),
      maximum: Math.max(...composed.map(Math.abs)),
    };
    error[label][name] = {
      mae:
        differences.reduce((s, v) => s + Math.abs(v), 0) / differences.length,
      rmse: Math.sqrt(
        differences.reduce((s, v) => s + v * v, 0) / differences.length,
      ),
      maximum: Math.max(...differences.map(Math.abs)),
    };
  }
}
await writeFile(
  directory + "/independent-reference.json",
  JSON.stringify(
    {
      samples,
      seed: 543190,
      contract:
        "cosine-weighted Lambert E; same upper hemisphere sky/sun/colors, 3 finite surface bounces; no DDGI gather, cache, display exposure or tone mapping; Monte Carlo SE reported",
      lighting: light,
      scans,
      error,
      composedError,
      compositionContract:
        "before/solid-only/spatial applied data availability to normalized E; after/fine use resident-volume ownership, with data availability independently reported. All listed receivers are inside the resident volume. Errors are effective diffuse E, before rho/pi and display processing.",
      acceptance: Object.keys(scans).map((name) => ({
        name,
        status:
          composedError.after[name].rmse <= composedError.before[name].rmse
            ? "passed"
            : "failed",
        metric:
          "original-quality effective diffuse E RMSE no regression against independent paths",
      })),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(error));
