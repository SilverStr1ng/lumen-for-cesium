import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fgSquare } from "../lumen/fg-sampling.js";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = {
  version: sourceVersion([
    "scripts/verify-fg-order.mjs",
    "lumen/fg-sampling.js",
  ]),
  checks: [],
  errors: [],
};
const browser = await launchBrowser(),
  p = await browser.newPage({ viewport: { width: 640, height: 400 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto("http://localhost:8090/demo/regression.html?fixture=untextured");
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  const rows = await p.evaluate(async () => {
    const w = lumenTest.world,
      C = Cesium,
      { default: shader } =
        await import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSampling.js");
    let seed = 0,
      epoch = 0,
      order = 0,
      samples = 32;
    const O = w._texture(64, 16),
      fb = w._framebuffer([O]);
    const cmd = w.scene.context.createViewportQuadCommand(
      shader +
        "\nvoid main(){vec3 d=fgDirection(vec3(0,0,1),int(gl_FragCoord.x),ivec2(int(gl_FragCoord.y),9));out_FragColor=vec4(d,1);}",
      {
        uniformMap: {
          u_fgSamples: () => samples,
          u_fgSeed: () => seed,
          u_fgEpoch: () => epoch,
          u_fgSampling: () => 2,
          u_fgRayOrder: () => order,
          u_fgPixelOffset: () => C.Cartesian2.ZERO,
          u_fgPreviousEnabled: () => false,
          u_fgRayBias: () => 0.0002,
        },
      },
    );
    const rows = [];
    try {
      w._commands.orderTest = cmd;
      for (const n of [16, 32, 64])
        for (const s of [0, 5, 19])
          for (const e of [0, 1, 31, 65537]) {
            samples = n;
            seed = s;
            epoch = e;
            const pair = [];
            for (const o of [0, 1]) {
              order = o;
              w._draw("orderTest", fb, 0, 0, 64, 16);
              pair.push(Array.from(w._read(fb, 64, 16)));
            }
            rows.push({ n, s, e, pair });
          }
    } finally {
      delete w._commands.orderTest;
      cmd.shaderProgram.destroy();
      w._freeTexture(O, fb);
    }
    return rows;
  });
  let delta = 0;
  for (const { n, s, e, pair } of rows)
    for (let y = 0; y < 16; y++) {
      const shift = fgSquare(0, n, [y, 9], e, s)[1],
        indices = [];
      for (let i = 0; i < n; i++) {
        let j = (i + n - Math.floor(shift * n)) % n,
          k = 0;
        for (let b = 0; b < Math.log2(n); b++) {
          k = (k << 1) | (j & 1);
          j >>>= 1;
        }
        indices.push(k);
        for (let c = 0; c < 3; c++)
          delta = Math.max(
            delta,
            Math.abs(
              pair[0][(y * 64 + k) * 4 + c] - pair[1][(y * 64 + i) * 4 + c],
            ),
          );
      }
      assert.equal(new Set(indices).size, n);
    }
  assert(delta < 1e-7, "changed per-pixel direction set: " + delta);
  assert.deepEqual(report.errors, []);
  report.maximumDirectionDelta = delta;
  report.checks.push({
    status: "passed",
    groups: rows.length,
    pixelsPerGroup: 16,
    samples: [16, 32, 64],
    seeds: [0, 5, 19],
    epochs: [0, 1, 31, 65537],
    scope:
      "actual compiled GPU directions; identical per-pixel sets, only order differs",
  });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    "reports/fg-runtime-budget-v7/order.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report));
