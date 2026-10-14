import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } }),
  report = {
    version: sourceVersion([
      "cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js",
    ]),
    checks: [],
    errors: [],
  };
p.on("pageerror", (e) => report.errors.push(String(e)));
p.on("console", (m) => {
  if (m.type() === "error") console.log(m.text().slice(0, 4000));
});
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=balanced",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.rows = await p.evaluate(async () => {
    try {
      const w = earthLab.world,
        C = Cesium,
        source = await (
          await fetch(
            "/cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.glsl",
          )
        ).text(),
        helper = source.slice(
          source.indexOf("#ifdef LUMEN_RECEIVER_COMPOSITE"),
          source.indexOf("vec3 lumen_irradiance"),
        );
      const positions = new Float32Array(16),
        normals = new Float32Array(16),
        raw = new Float32Array(16),
        P = w._texture(2, 2),
        N = w._texture(2, 2),
        E = w._texture(2, 2),
        O = w._texture(1, 1),
        fb = w._framebuffer([O]);
      let ns = new C.Cartesian3(0, 0, 1);
      const {declarations:normalDeclarations,functions:normalFunctions}=await import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherNormals.js");
      const cmd = earthLab.scene.context.createViewportQuadCommand(
        "#define LUMEN_RECEIVER_COMPOSITE\nprecision highp float;uniform bool u_lumenFgEnabled,u_lumenFgCurved;uniform float u_lumenWorldGain,u_lumenFgSurfaceId;uniform mat4 u_lumenEyeToLocal;uniform vec2 u_lumenFgSceneSize,u_lumenReceiverSize,u_lumenFgSize,u_lumenFgOffset;uniform sampler2D u_lumenFgNeighborhood,u_lumenFgTexture,u_lumenReceiverPosition,u_lumenReceiverNormal;uniform vec3 u_ns;\n" + normalDeclarations + normalFunctions +
          helper +
          "\nvoid main(){vec3 used=lumen_reconstructFg(vec3(gl_FragCoord.xy,-10),u_ns,vec3(.1,.2,.3));out_FragColor=vec4(used,lumen_fgWeight);}",
        {
          uniformMap: {
            u_lumenFgPackedNormals: () => false,
            u_lumenFgCurved: () => false,
            u_lumenFgEnabled: () => true,
            u_lumenWorldGain: () => 1,
            u_lumenFgSurfaceId: () => 3,
            u_lumenEyeToLocal: () => C.Matrix4.IDENTITY,
            u_lumenFgSceneSize: () => new C.Cartesian2(1, 1),
            u_lumenReceiverSize: () => new C.Cartesian2(2, 2),
            u_lumenFgSize: () => new C.Cartesian2(2, 2),
            u_lumenFgOffset: () => C.Cartesian2.ZERO,
            u_lumenFgTexture: () => E,
            u_lumenFgNeighborhood: () => E,
            u_lumenReceiverPosition: () => P,
            u_lumenReceiverNormal: () => N,
            u_ns: () => ns,
          },
        },
      );
      const rows = [];
      try {
        w._commands.testReconstruction = cmd;
        for (const name of [
          "same-plane",
          "different-owner",
          "other-depth",
          "other-normal",
          "unknown",
          "Ns-not-Ng",
        ]) {
          for (let i = 0; i < 4; i++) {
            positions.set([0.5, 0.5, -10, 3], i * 4);
            normals.set([0, 0, 1, 3], i * 4);
            raw.set([2, 2, 2, 1], i * 4);
          }
          ns = new C.Cartesian3(0, 0, 1);
          if (name === "different-owner") {
            positions[3] = 4;
            normals[3] = 4;
            raw.set([99, 99, 99, 1]);
          }
          if (name === "other-depth") {
            positions[2] = -9.9;
            raw.set([99, 99, 99, 1]);
          }
          if (name === "other-normal") {
            normals.set([1, 0, 0, 3]);
            raw.set([99, 99, 99, 1]);
          }
          if (name === "unknown") raw.set([99, 99, 99, -1]);
          if (name === "Ns-not-Ng")
            ns = C.Cartesian3.normalize(
              new C.Cartesian3(0.1, 0, 0.995),
              new C.Cartesian3(),
            );
          for (const [texture, data] of [
            [P, positions],
            [N, normals],
            [E, raw],
          ])
            texture.copyFrom({
              source: { width: 2, height: 2, arrayBufferView: data },
            });
          w._draw("testReconstruction", fb, 0, 0, 1, 1);
          rows.push({ name, actual: Array.from(w._read(fb, 1, 1)) });
        }
      } finally {
        delete w._commands.testReconstruction;
        cmd.shaderProgram.destroy();
        w._freeTexture(P);
        w._freeTexture(N);
        w._freeTexture(E);
        w._freeTexture(O, fb);
      }
      return rows;
    } catch (e) {
      throw Error(e.message ?? String(e));
    }
  });
  for (const r of report.rows) {
    const expected =
      r.name === "same-plane"
        ? [2, 2, 2, 1]
        : r.name === "Ns-not-Ng"
          ? [0.1, 0.2, 0.3, 0]
          : [1.525, 1.55, 1.575, 0.75];
    assert(r.actual.every((v, i) => Math.abs(v - expected[i]) < 0.000005));
    report.checks.push({
      name: r.name,
      status: "passed",
      expected,
      actual: r.actual,
    });
  }
  report.samePlaneBarrier = await p.evaluate(async () => {
    const w = earthLab.world,
      C = Cesium,
      { receiverNeighborhood } =
        await import("/cesium-1.146/packages/engine/Source/Scene/LumenGpuShaders.js");
    const nodeData = new Float32Array([-1, -1, -11, 1, 1, 1, -9, 1]),
      vertices = new Float32Array([
        0.505, 0, -11, 0, 0.505, 1, -11, 0, 0.505, 0, -9, 0,
      ]);
    const nodes = w._texture(2, 1, C.PixelDatatype.FLOAT, nodeData),
      V = w._texture(3, 1, C.PixelDatatype.FLOAT, vertices),
      P = w._texture(
        1,
        1,
        C.PixelDatatype.FLOAT,
        new Float32Array([0.5, 0.5, -10, 3]),
      ),
      N = w._texture(
        1,
        1,
        C.PixelDatatype.FLOAT,
        new Float32Array([0, 0, 1, 3]),
      ),
      E = w._texture(
        1,
        1,
        C.PixelDatatype.FLOAT,
        new Float32Array([99, 99, 99, 1]),
      ),
      O = w._texture(1, 1),
      fb = w._framebuffer([O]);
    const cmd = earthLab.scene.context.createViewportQuadCommand(
      receiverNeighborhood,
      {
        uniformMap: {
          u_nodes: () => nodes,
          u_vertices: () => V,
          u_nodesCount: () => 1,
          u_budget: () => 256,
          u_receiverPosition: () => P,
          u_receiverNormal: () => N,
          u_lumenFgPackedNormals: () => false,
          u_fgRaw: () => E,
          u_receiverOffset: () => C.Cartesian2.ZERO,
          u_fgLocalToEye: () => C.Matrix4.IDENTITY,
          u_fgNeighborhoodScale: () => 1,
          u_fgNeedsNeighborhood: () => true,
        },
      },
    );
    let blocked, open;
    try {
      w._commands.samePlaneGuard = cmd;
      w._draw("samePlaneGuard", fb, 0, 0, 1, 1);
      blocked = Array.from(w._read(fb, 1, 1));
      nodeData[7] = 0;
      nodes.copyFrom({
        source: { width: 2, height: 1, arrayBufferView: nodeData },
      });
      w._draw("samePlaneGuard", fb, 0, 0, 1, 1);
      open = Array.from(w._read(fb, 1, 1));
    } finally {
      delete w._commands.samePlaneGuard;
      cmd.shaderProgram.destroy();
      for (const t of [nodes, V, P, N, E]) w._freeTexture(t);
      w._freeTexture(O, fb);
    }
    return {
      blocked,
      open,
      scope:
        "same receiver ownership and Ng; nearby wall omitted by coarse sampling still rejects reconstruction through world BVH; raw E=99 retained",
    };
  });
  assert.deepEqual(report.samePlaneBarrier.blocked, [0, 0, 0, 0]);
  assert.deepEqual(report.samePlaneBarrier.open, [1, 1, 1, 1]);
  report.occlusion = await p.evaluate(async () => {
    const d = earthLab,
      C = Cesium;
    d.camera("boxFoot");
    const fg = d.scene.lumen.finalGather;
    await fg.configure({ mode: "fg", quality: "balanced", model: d.model });
    const center = C.Cartesian3.add(
      d.scene.camera.positionWC,
      C.Cartesian3.multiplyByScalar(
        d.scene.camera.directionWC,
        3,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const blocker = d.scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            dimensions: new C.Cartesian3(2, 2, 2),
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          modelMatrix: C.Matrix4.fromTranslation(center),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.BLACK),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          closed: true,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );
    d.widget.render();
    d.widget.render();
    const [rw, rh] = fg.metrics.receiverResolution,
      P = d.world._read(fg.receiver.framebuffer, rw, rh, 0),
      centerAlpha = P[(Math.floor(rh / 2) * rw + Math.floor(rw / 2)) * 4 + 3];
    d.scene.primitives.remove(blocker);
    // Entire supported building below the real ellipsoid, viewed from above ground.
    d.anchor.height = -20;
    const old = d.world;
    await d.reload();
    const start = performance.now();
    while (!d.world?.ready || d.world === old) {
      if (d.errors.length) throw Error(d.errors.join("; "));
      if (performance.now() - start > 20000) throw Error("reload timeout");
      d.scene.requestRender();
      await new Promise((r) => setTimeout(r, 16));
    }
    await d.world.completed;
    d.camera("overview");
    d.scene.camera.moveUp(50);
    d.widget.render();
    d.widget.render();
    const [ww, hh] = fg.metrics.receiverResolution,
      Q = d.world._read(fg.receiver.framebuffer, ww, hh, 0);
    let supported = 0;
    for (let i = 3; i < Q.length; i += 4) if (Q[i] > 0.5) supported++;
    return {
      blockerCenterAlpha: centerAlpha,
      buriedSupportedPixels: supported,
    };
  });
  assert.equal(report.occlusion.blockerCenterAlpha, 0);
  assert.equal(report.occlusion.buriedSupportedPixels, 0);
  report.status = "passed";
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    "reports/receiver-final-gather-v5/reconstruction.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(report.status, report.error ?? "");
