import assert from "node:assert/strict";
import { mkdir,writeFile } from "node:fs/promises";
import { fgSquare } from "../lumen/fg-sampling.js";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = { version: sourceVersion(), checks: [], rows: [], errors: [] };
for (const seed of [0, 5, 19]) {
  let u = 0,
    v = 0;
  const bins = Array(16).fill(0);
  for (let e = 0; e < 32; e++)
    for (let i = 0; i < 32; i++) {
      const s = fgSquare(i, 32, [4, 9], e, seed);
      u += s[0];
      v += s[1];
      bins[Math.floor(s[0] * 4) + Math.floor(s[1] * 4) * 4]++;
    }
  u /= 1024;
  v /= 1024;
  assert(Math.abs(u - 0.5) < 0.02 && Math.abs(v - 0.5) < 0.02);
  assert(bins.every((n) => n > 25 && n < 110));
  assert.notDeepEqual(
    fgSquare(0, 32, [4, 9], 0, seed),
    fgSquare(0, 32, [5, 9], 0, seed),
  );
  assert.notDeepEqual(
    fgSquare(0, 32, [4, 9], 0, seed),
    fgSquare(0, 32, [4, 9], 1, seed),
  );
  report.checks.push({ seed, u, v, bins, status: "passed" });
}
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto("http://localhost:8090/demo/regression.html?fixture=untextured");
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  report.gpu = await p.evaluate(async () => {
    const w = lumenTest.world,
      C = Cesium,
      { default: sampling } =
        await import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSampling.js");
    const O = w._texture(32, 1),
      fb = w._framebuffer([O]);
    let seed = 0,
      epoch = 0;
    const cmd = w.scene.context.createViewportQuadCommand(
      sampling +
        "\nvoid main(){vec3 d=fgDirection(vec3(0,0,1),int(gl_FragCoord.x),ivec2(4,9));out_FragColor=vec4(dot(d.xy,d.xy),fract(atan(d.y,d.x)/czm_twoPi),d.z,1);}",
      {
        uniformMap: {
          u_fgSamples: () => 32,
          u_fgSeed: () => seed,
          u_fgRayOrder: () => 0,
          u_fgSampling: () => 2,
          u_fgEpoch: () => epoch,
          u_fgPixelOffset: () => C.Cartesian2.ZERO,
          u_fgPreviousEnabled: () => false,
          u_fgRayBias: () => 0.0002,
        },
      },
    );
    const rows = [];
    try {
      w._commands.samplerTest = cmd;
      for (const s of [0, 5, 19])
        for (const e of [0, 1, 31, 65537, 2147483647, -1]) {
          seed = s;
          epoch = e;
          w._draw("samplerTest", fb, 0, 0, 32, 1);
          rows.push({
            seed: s,
            epoch: e >>> 0,
            data: Array.from(w._read(fb, 32, 1)),
          });
        }
    } finally {
      delete w._commands.samplerTest;
      cmd.shaderProgram.destroy();
      w._freeTexture(O, fb);
    }
    const analytic = [];
    const analyticOut = w._texture(32, 1),
      analyticFb = w._framebuffer([analyticOut]),
      analyticCmd = w.scene.context.createViewportQuadCommand(
        sampling +
          "\nvoid main(){vec3 d=fgDirection(vec3(0,0,1),int(gl_FragCoord.x),ivec2(4,9));bool rectangle=abs(d.x)<=d.z&&abs(d.y)<=0.5*d.z;out_FragColor=vec4(czm_pi,czm_pi*step(0.0,d.x),rectangle?czm_pi:0.0,1.0);}",
        {
          uniformMap: {
            u_fgSamples: () => 32,
            u_fgSeed: () => seed,
            u_fgRayOrder: () => 0,
            u_fgSampling: () => 2,
            u_fgEpoch: () => epoch,
            u_fgPixelOffset: () => C.Cartesian2.ZERO,
            u_fgPreviousEnabled: () => false,
            u_fgRayBias: () => 0.0002,
          },
        },
      );
    try {
      w._commands.analyticSamplerTest = analyticCmd;
      for (const s of [0, 5, 19]) {
        seed = s;
        const mean = [0, 0, 0];
        for (let e = 0; e < 32; e++) {
          epoch = e;
          w._draw("analyticSamplerTest", analyticFb, 0, 0, 32, 1);
          const data = w._read(analyticFb, 32, 1);
          for (let i = 0; i < 32; i++)
            for (let c = 0; c < 3; c++) mean[c] += data[i * 4 + c] / 1024;
        }
        analytic.push({ seed: s, mean });
      }
    } finally {
      delete w._commands.analyticSamplerTest;
      analyticCmd.shaderProgram.destroy();
      w._freeTexture(analyticOut, analyticFb);
    }
    w.setFinalGatherCapture(true);
    const transport = [];
    for (const k of [1, 2, 3]) {
      await w.solve({ bounces: k, publicationMode: "snapshot" });
      const points = lumenTest.metadata.receivers.slice(0, 3),
        reference = await w.sampleFinalGather(points, { samples: 1024 });
      for (const s of [0, 5, 19]) {
        const estimates = [];
        for (let e = 0; e < 32; e++)
          estimates.push(
            await w.sampleFinalGather(points, {
              samples: 32,
              seed: s,
              epoch: e,
              sampling: "reconstructed",
            }),
          );
        transport.push({ k, seed: s, points, reference, estimates });
      }
    }
    return { directions: rows, transport, analytic };
  });
  // Analytic cosine-measure integrands exercise the compiled shared GPU sampler.
  // Real world BVH/solar/finite-bounce transport is checked separately below.
  const rectangleE =
    2 *
    ((1 / Math.sqrt(2)) * Math.atan(0.5 / Math.sqrt(2)) +
      (0.5 / Math.sqrt(1.25)) * Math.atan(1 / Math.sqrt(1.25)));
  report.analytic = {
    scope:
      "constant sky, black half-space and unit-radiance centered rectangle quadrature; actual compiled GPU sampler, not an additional world-tracing fixture",
    expected: [Math.PI, Math.PI / 2, rectangleE],
    rows: report.gpu.analytic,
    tolerance: [
      1e-6,
      ...[0.5, rectangleE / Math.PI].map(
        (p) => 3 * Math.PI * Math.sqrt((p * (1 - p)) / 1024),
      ),
    ],
    toleranceContract:
      "three independent Bernoulli standard errors at 1024 directions; derived from analytic probability, never candidate errors",
  };
  for (const row of report.gpu.analytic)
    for (let c = 0; c < 3; c++)
      assert(
        Math.abs(row.mean[c] - report.analytic.expected[c]) <
          report.analytic.tolerance[c],
      );
  let maximumError = 0;
  for (const r of report.gpu.directions)
    for (let i = 0; i < 32; i++) {
      const s = fgSquare(i, 32, [4, 9], r.epoch, r.seed),
        dv = Math.abs(s[1] - r.data[i * 4 + 1]);
      maximumError = Math.max(
        maximumError,
        Math.abs(s[0] - r.data[i * 4]),
        Math.min(dv, 1 - dv),
      );
    }
  assert(maximumError < 0.00001);
  report.maximumCpuGpuError = maximumError;
  for (const r of report.gpu.transport) {
    assert(r.estimates.flat().every((x) => x.valid && !x.unknown));
    const mean = r.reference.map((_, i) =>
      [0, 1, 2].map((c) =>
        r.estimates.reduce((sum, e) => sum + e[i].irradiance[c] / 32, 0),
      ),
    );
    const rmse = (values) =>
      Math.sqrt(
        r.reference
          .flatMap((v, i) =>
            v.irradiance.map((x, c) => (values[i][c] - x) ** 2),
          )
          .reduce((a, b) => a + b, 0) /
          (r.reference.length * 3),
      );
    report.rows.push({
      k: r.k,
      seed: r.seed,
      rmseFirst: rmse(r.estimates[0].map((x) => x.irradiance)),
      rmse32: rmse(mean),
      mean,
    });
    assert(rmse(mean) < 0.06);
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  const out=process.env.LUMEN_REPORT_DIRECTORY??"reports/fg-reconstruction-showcase-v6";
  await mkdir(out,{recursive:true});await writeFile(
    out+"/sampling.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    maximumCpuGpuError: report.maximumCpuGpuError,
    rows: report.rows,
  }),
);
