import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } }),
  report = { version: sourceVersion(), checks: [] };
try {
  await p.goto("http://localhost:8090/demo/regression.html?fixture=untextured");
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  report.result = await p.evaluate(async () => {
    const w = lumenTest.world,
      C = Cesium;
    const P = new Float32Array(48),
      E = new Float32Array(60 * 20 * 4),
      M = new Float32Array(E.length);
    for (let id = 0; id < 12; id++) {
      const x = id % 3,
        y = Math.floor(id / 3) % 2,
        z = Math.floor(id / 6);
      P.set([x, y, z, 1], id * 4);
      for (let j = 0; j < 10; j++)
        for (let i = 0; i < 10; i++) {
          const o = ((z * 10 + j) * 60 + (x + 3 * y) * 10 + i) * 4;
          E.set([x + 2 * y + 3 * z, 2, 4, 1], o);
          M.set([10, 100, 0, 1], o);
        }
    }
    const a = w._atlases[w._published],
      old = {
        E: a.E,
        M: a.M,
        P: w.positionTexture,
        origin: w.origin,
        counts: w.counts,
        spacing: w.spacing,
        bias: w.normalBias,
      };
    try {
      a.E = w._texture(60, 20, C.PixelDatatype.FLOAT, E);
      a.M = w._texture(60, 20, C.PixelDatatype.FLOAT, M);
      w.positionTexture = w._texture(6, 2, C.PixelDatatype.FLOAT, P);
      w.origin = new C.Cartesian3(0, 0, 0);
      w.counts = new C.Cartesian3(3, 2, 2);
      w.spacing = 1;
      w.normalBias = 0;
      const points = [
          0, 0.01, 0.25, 0.5, 0.75, 0.99999, 1, 1.00001, 1.25, 1.75, 2,
        ].map((x) => ({ position: [x, 0.5, 0.5], normal: [0, 0, 1] })),
        actual = await w.sample(points, { fixedFacing: 1 }),
        legacy = await w.sample(points, { fixedFacing: 1, legacyKernel: true }),
        low = await w.sample(points, { fixedFacing: 0.0001 });
      w.normalBias = 0.075;
      const normals = [
          {
            position: [0.5, 0.5, 0.5],
            normal: [1, 0, 0],
            geometricNormal: [0, 0, 1],
          },
          {
            position: [0.5, 0.5, 0.5],
            normal: [-1, 0, 0],
            geometricNormal: [0, 0, 1],
          },
        ],
        separate = await w.sample(normals, { fixedFacing: 1 });
      // Real material gather: partial data must not dim normalized constant E.
      P[3] = 0;
      w.positionTexture.copyFrom({
        source: { width: 6, height: 2, arrayBufferView: P },
      });
      const { querySample } =
        await import("/cesium-1.146/packages/engine/Source/Scene/LumenGpuShaders.js");
      const tex = new C.Texture({
        context: w.scene.context,
        width: 1,
        height: 1,
        pixelFormat: C.PixelFormat.RGBA,
        pixelDatatype: C.PixelDatatype.FLOAT,
      });
      const fb = new C.Framebuffer({
        context: w.scene.context,
        colorTextures: [tex],
        destroyAttachments: false,
      });
      let mode = 0;
      const cmd = w.scene.context.createViewportQuadCommand(
        querySample.slice(0, querySample.indexOf("void main()")) +
          "uniform int u_mode;void main(){vec3 E=lumen_irradiance(vec3(0.5),vec3(0,0,1),vec3(0,0,1));out_FragColor=u_mode==0?vec4(E*lumen_materialCoverage,lumen_dataCoverage):vec4(lumen_environmentCoverage);}",
        {
          uniformMap: {
            ...w._uniforms(),
            u_lumenGatherControl: () => new C.Cartesian4(0, 0, 1, 1),
            u_mode: () => mode,
          },
        },
      );
      w._commands.coverageComposition = cmd;
      let composed, fallback;
      try {
        w._draw("coverageComposition", fb, 0, 0, 1, 1);
        composed = Array.from(w._read(fb, 1, 1));
        mode = 1;
        w._draw("coverageComposition", fb, 0, 0, 1, 1);
        fallback = Array.from(w._read(fb, 1, 1));
      } finally {
        delete w._commands.coverageComposition;
        cmd.shaderProgram.destroy();
        fb.destroy();
        tex.destroy();
      }
      return {
        points,
        actual,
        legacy,
        low,
        separate,
        composed,
        fallback,
        errors: lumenTest.errors,
      };
    } finally {
      a.E = old.E;
      a.M = old.M;
      w.positionTexture = old.P;
      w.origin = old.origin;
      w.counts = old.counts;
      w.spacing = old.spacing;
      w.normalBias = old.bias;
    }
  });
  for (let i = 0; i < report.result.points.length; i++) {
    const expected = report.result.points[i].position[0] + 2.5,
      actual = report.result.actual[i];
    assert.ok(Math.abs(actual.irradiance[0] - expected) < 1e-5);
    assert.ok(Math.abs(actual.irradiance[1] - 2) < 1e-6);
    assert.ok(Math.abs(actual.irradiance[2] - 4) < 1e-6);
    assert.ok(Math.abs(actual.coverage - 1) < 1e-6);
  }
  assert.ok(
    Math.abs(report.result.legacy[2].irradiance[0] - 2.75) > 0.1,
    "legacy control must detect crushed kernel",
  );
  assert.deepEqual(
    report.result.separate[0],
    report.result.separate[1],
    "detail Ns must not shift geometric query",
  );
  assert.ok(Math.abs(report.result.separate[0].irradiance[0] - 3.225) < 1e-5);
  for (const sample of report.result.low) {
    assert.deepEqual(sample.irradiance, [0, 0, 0]);
    assert.equal(sample.coverage, 1);
  }
  for (const v of report.result.composed.slice(0, 3))
    assert.ok(Math.abs(v - 1) < 1e-6);
  assert.ok(report.result.composed[3] > 0 && report.result.composed[3] < 1);
  assert.deepEqual(
    report.result.fallback,
    [1, 1, 1, 1],
    "resident missing support must still suppress unoccluded sky",
  );
  assert.deepEqual(report.result.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(
    "reports/ddgi-visual-quality-v4/spatial-gpu.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
