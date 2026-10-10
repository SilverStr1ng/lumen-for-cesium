import { loadGeometry, accepts } from "./gltf.js";
import { BVH } from "./bvh.js";
import { DDGI } from "./ddgi.js";

let solver,
  epoch = 0;
self.onmessage = async ({ data: m }) => {
  const send = (type, payload) =>
    self.postMessage({ type, revision: m.revision, id: m.id, ...payload });
  if (m.type === "sample") {
    send("response", {
      result: m.points.map((p) =>
        solver?.field?.sample(p.position, p.normal, p.visibility !== false),
      ),
    });
    return;
  }
  if (m.type === "surfaces") {
    send("response", {
      result: [...solver.cache.entries.values()]
        .filter((e) => m.materials.includes(e.material))
        .map((e) => ({
          position: e.position,
          normal: e.normal,
          albedo: e.albedo,
          outgoing: e.outgoing,
          material: e.material,
          triangle: e.triangle,
        })),
    });
    return;
  }
  if (m.type === "trace") {
    send("response", {
      result: m.rays.map((r) => {
        const hit = solver.bvh.trace(r.origin, r.direction, {
          ...r,
          accept: (t, u, v) => accepts(solver.bvh.geometry, t, u, v),
        });
        if (hit.status === "Hit") {
          hit.material = solver.bvh.geometry.materialIds[hit.triangle];
          hit.normal = Array.from(
            solver.bvh.geometry.normals.subarray(
              hit.triangle * 3,
              hit.triangle * 3 + 3,
            ),
          );
        }
        return hit;
      }),
    });
    return;
  }
  const own = ++epoch,
    cancelled = () => own !== epoch;
  try {
    if (m.type === "load") {
      send("progress", { phase: "loading" });
      const geometry = await loadGeometry(m.url, m.axisMatrix, (phase) =>
        send("progress", { phase }),
      );
      if (cancelled()) return;
      send("progress", { phase: "building BVH" });
      const bvh = new BVH(geometry);
      solver = new DDGI(bvh, m.options);
      if (!(await solver.initialize((p) => send("progress", p), cancelled)))
        return;
    }
    if (m.type === "load" || m.type === "solve") {
      if (!solver) throw new Error("Load world geometry before solving");
      await solver.solve(
        m.options,
        (p) => send("progress", p),
        cancelled,
        (packet) => {
          if (cancelled()) return;
          self.postMessage(
            { type: "generation", revision: m.revision, ...packet },
            [
              packet.positions.buffer,
              packet.irradiance.buffer,
              packet.moments.buffer,
            ],
          );
        },
      );
      if (!cancelled()) send("complete", { history: solver.history });
    } else if (m.type === "cancel") return;
  } catch (error) {
    if (!cancelled()) send("error", { message: error.stack ?? String(error) });
  }
};
