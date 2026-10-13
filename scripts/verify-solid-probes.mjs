import assert from "node:assert/strict";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { DDGI } from "../lumen/ddgi.js";
const geometry = await loadGeometry(
  "http://localhost:8090/fixtures/earth-pavilion.gltf",
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
);
const solver = new DDGI(new BVH(geometry), {
  spacing: 2,
  rays: 128,
  traversalBudget: 4096,
});
await solver.initialize(
  () => {},
  () => false,
);
let activeInside = 0,
  totalInside = 0;
for (let id = 0; id < solver.grid.total; id++) {
  const [x, y, z, state] = solver.positions.slice(id * 4, id * 4 + 4);
  if (x > -12 && x < 12 && y > -9 && y < 9 && z > -1.5 && z < 0) {
    totalInside++;
    if (state >= 0.5) activeInside++;
  }
}
console.log(
  JSON.stringify({ totalInside, activeInside, probes: solver.grid.total }),
);
assert.equal(
  activeInside,
  0,
  "actual pavilion foundation interior must not remain an active black-light probe",
);
console.log(
  "PASS actual glTF -> BVH -> relocation/classification rejects solid interiors",
);
