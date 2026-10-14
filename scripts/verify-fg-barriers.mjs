import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const report = { version: sourceVersion(), errors: [] },
  b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.rows = await p.evaluate(async () => {
    const w = earthLab.world,
      C = Cesium,
      { declarations, functions } =
        await import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherGeometry.js");
    const source = await (
      await fetch(
        "/cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.glsl",
      )
    ).text();
    const helper = source.slice(
      source.indexOf("#ifdef LUMEN_RECEIVER_COMPOSITE"),
      source.indexOf("vec3 lumen_irradiance"),
    );
    const nodesData = new Float32Array([-1, -1, -11, 1, 1, 1, -9, 2]);
    const vertices = new Float32Array([
      0.505, 0, -11, 0, 0.505, 1, -11, 0, 0.505, 0, -9, 0, 0.505, 1, -11, 0,
      0.505, 1, -9, 0, 0.505, 0, -9, 0,
    ]);
    const nodes = w._texture(2, 1, C.PixelDatatype.FLOAT, nodesData),
      V = w._texture(6, 1, C.PixelDatatype.FLOAT, vertices);
    const positions = new Float32Array(16),
      normals = new Float32Array(16),
      raw = new Float32Array(16),
      filtered = new Float32Array(16),
      mask = new Float32Array(16);
    const P = w._texture(2, 2),
      N = w._texture(2, 2),
      E = w._texture(2, 2),
      H = w._texture(2, 2),
      M = w._texture(2, 2),
      O = w._texture(1, 1),
      fb = w._framebuffer([O]);
    const cmd = w.scene.context.createViewportQuadCommand(
      "#define LUMEN_RECEIVER_COMPOSITE\n#define LUMEN_FG_REASONS\n#define LUMEN_FG_RECONSTRUCTION\nprecision highp float;precision highp sampler2D;uniform bool u_lumenFgEnabled,u_lumenFgHistory,u_lumenFgCurved;uniform float u_lumenWorldGain,u_lumenFgSurfaceId,u_lumenFgFallbackCode;uniform mat4 u_lumenEyeToLocal;uniform vec2 u_lumenFgSceneSize,u_lumenReceiverSize,u_lumenFgSize,u_lumenFgOffset;uniform sampler2D u_lumenFgNeighborhood,u_lumenFgTexture,u_lumenFgFiltered,u_lumenReceiverPosition,u_lumenReceiverNormal;\n" +
        declarations +
        helper +
        functions +
        "\nvoid main(){vec3 used=lumen_reconstructFg(vec3(gl_FragCoord.xy,-10),vec3(0,0,1),vec3(.1,.2,.3));out_FragColor=vec4(used,lumen_fgWeight);}",
      {
        uniformMap: {
          u_lumenFgPackedNormals: () => false,
          u_lumenFgCurved: () => false,
          u_lumenFgEnabled: () => true,
          u_lumenFgHistory: () => true,
          u_lumenWorldGain: () => 1,
          u_lumenFgSurfaceId: () => 3,
          u_lumenFgFallbackCode: () => 0,
          u_lumenEyeToLocal: () => C.Matrix4.IDENTITY,
          u_lumenFgSceneSize: () => new C.Cartesian2(1, 1),
          u_lumenReceiverSize: () => new C.Cartesian2(2, 2),
          u_lumenFgSize: () => new C.Cartesian2(2, 2),
          u_lumenFgOffset: () => C.Cartesian2.ZERO,
          u_lumenFgNeighborhood: () => M,
          u_lumenFgTexture: () => E,
          u_lumenFgFiltered: () => H,
          u_lumenReceiverPosition: () => P,
          u_lumenReceiverNormal: () => N,
          u_lumenFgNodes: () => nodes,
          u_lumenFgVertices: () => V,
          u_lumenFgNodeCount: () => 1,
          u_lumenFgBarrierBudget: () => 256,
        },
      },
    );
    const rows = [];
    try {
      w._commands.barrierTest = cmd;
      for (const name of [
        "same-center-near-wall",
        "thin-wall",
        "open-segment",
        "other-owner",
        "other-plane",
        "unknown-current",
        "missing-current",
        "FP16-overflow-raw-preserved",
      ]) {
        for (let i = 0; i < 4; i++) {
          positions.set([0.5, 0.5, -10, 3], i * 4);
          normals.set([0, 0, 1, 3], i * 4);
          raw.set([99, 99, 99, 1], i * 4);
          filtered.set([99, 99, 99, 32], i * 4);
        }
        nodesData[7] = 2;
        if (["thin-wall", "open-segment"].includes(name))
          for (let i = 0; i < 4; i++) positions[i * 4] = 0.52;
        if (name === "open-segment") nodesData[7] = 0;
        if (name === "other-owner")
          for (let i = 0; i < 4; i++) positions[i * 4 + 3] = 4;
        if (name === "other-plane")
          for (let i = 0; i < 4; i++) positions[i * 4 + 2] = -9.9;
        if (name === "unknown-current")
          for (let i = 0; i < 4; i++) raw[i * 4 + 3] = -1;
        if (name === "missing-current")
          for (let i = 0; i < 4; i++) raw[i * 4 + 3] = 0;
        if (name === "FP16-overflow-raw-preserved")
          for (let i = 0; i < 4; i++) {
            raw.set([10000, 10000, 10000, 1], i * 4);
            filtered[i * 4 + 3] = 0;
          }
        for (const [t, data] of [
          [P, positions],
          [N, normals],
          [E, raw],
          [H, filtered],
          [M, mask],
        ])
          t.copyFrom({
            source: { width: 2, height: 2, arrayBufferView: data },
          });
        nodes.copyFrom({
          source: { width: 2, height: 1, arrayBufferView: nodesData },
        });
        w._draw("barrierTest", fb, 0, 0, 1, 1);
        rows.push({ name, actual: Array.from(w._read(fb, 1, 1)) });
      }
    } finally {
      delete w._commands.barrierTest;
      cmd.shaderProgram.destroy();
      for (const t of [P, N, E, H, M, nodes, V]) w._freeTexture(t);
      w._freeTexture(O, fb);
    }
    return rows;
  });
  for (const r of report.rows) {
    const value =
      r.name === "FP16-overflow-raw-preserved"
        ? [10000, 10000, 10000, 1]
        : ["same-center-near-wall", "open-segment"].includes(r.name)
          ? [99, 99, 99, 1]
          : [0.1, 0.2, 0.3, 0];
    assert(
      r.actual.every((v, i) => Math.abs(v - value[i]) < 0.00001),
      r.name,
    );
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    "reports/fg-reconstruction-showcase-v6/barriers.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report));
