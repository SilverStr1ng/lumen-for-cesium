import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ?? "reports/fg-runtime-budget-v7/latest";
await mkdir(out, { recursive: true });
const report = {
  version: sourceVersion(["scripts/verify-fg-ownership.mjs"]),
  rows: [],
  errors: [],
};
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on("pageerror", (error) => report.errors.push(String(error)));
try {
  await page.goto("http://localhost:8090/demo/globe.html");
  await page.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.rows = await page.evaluate(async () => {
    const C = Cesium,
      w = earthLab.world,
      { default: generated } =
        await import("/cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.js");
    const {functions:normalFunctions} = await import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherNormals.js");
    earthLab.widget.useDefaultRenderLoop = false;
    const textures = [],
      make = (width, height, pixel) => {
        const data = new Float32Array(width * height * 4);
        for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
        const texture = w._texture(width, height, C.PixelDatatype.FLOAT, data);
        textures.push(texture);
        return texture;
      };
    const P = make(2, 2, [0.5, 0.5, -10, 3]),
      N = make(2, 2, [0, 0, 1, 3]),
      E = make(2, 2, [2, 2, 2, 1]),
      probes = make(4, 2, [0.5, 0.5, -10, 1]),
      irradiance = make(40, 20, [0.2, 0.2, 0.2, 1]),
      moments = make(40, 20, [1000000, 1000000, 0, 1]),
      target = make(1, 1, [0, 0, 0, 0]),
      fb = w._framebuffer([target]);
    let origin = new C.Cartesian3(-2, -2, -12),
      lazy = false,
      enabled = true,
      debug = 0,
      view = 0,
      ns = new C.Cartesian3(0, 0, 1);
    const prefix = `#define LUMEN_WORLD_SUPPORTED
#define LUMEN_RECEIVER_COMPOSITE
#define LUMEN_FG_RECONSTRUCTION
precision highp float;precision highp sampler2D;
uniform sampler2D u_lumenProbePositions,u_lumenProbeIrradiance,u_lumenProbeDistances;
uniform sampler2D u_lumenFgTexture,u_lumenFgFiltered,u_lumenFgNeighborhood,u_lumenReceiverPosition,u_lumenReceiverNormal;
uniform bool u_lumenFgEnabled,u_lumenFgHistory,u_lumenWorldEnabled,u_lumenFgLazyFallback,u_lumenLegacyKernel,u_lumenLinearAtlas;
uniform bool u_lumenFgPackedNormals,u_lumenFgCurved;
uniform vec3 u_lumenProbeOrigin,u_lumenProbeCounts,u_lumenIrradiance,u_ns;
uniform float u_lumenProbeSpacing,u_lumenNormalBias,u_lumenWorldGain,u_lumenCoverage,u_lumenFgSurfaceId;
uniform mat4 u_lumenEyeToLocal;
uniform vec2 u_lumenFgSceneSize,u_lumenReceiverSize,u_lumenFgSize,u_lumenFgOffset;
uniform vec4 u_lumenGatherControl;uniform int u_lumenDebugMode,u_view;
float testDdgiCalls=0.0;
bool lumen_fgSegment(vec3 p,vec3 q,vec3 ng){return false;}
`;
    // Instrument the compiled production function, rather than substituting a
    // mock FG result. This diagnostic readback is never used by production.
    const source = generated.replace(
      "lumen_volumeCoverage = 0.0;\n    vec3 p",
      "testDdgiCalls+=1.0;\n    lumen_volumeCoverage = 0.0;\n    vec3 p",
    );
    if (source === generated)
      throw Error("DDGI instrumentation anchor missing");
    const cmd = earthLab.scene.context.createViewportQuadCommand(
      prefix +
        normalFunctions + source +
        `
void main(){vec3 light=lumen_irradiance(vec3(gl_FragCoord.xy,-10),u_ns,vec3(0,0,1));
 if(u_view==0)out_FragColor=vec4(light,lumen_fgWeight);
 else if(u_view==1)out_FragColor=vec4(testDdgiCalls,lumen_volumeCoverage,lumen_materialCoverage,lumen_environmentCoverage);
 else out_FragColor=vec4(lumen_dataCoverage,lumen_fgFallbackReason,0,0);}`,
      {
        uniformMap: {
          u_lumenFgPackedNormals: () => false,
          u_lumenFgCurved: () => false,
          u_lumenProbePositions: () => probes,
          u_lumenProbeIrradiance: () => irradiance,
          u_lumenProbeDistances: () => moments,
          u_lumenFgTexture: () => E,
          u_lumenFgFiltered: () => E,
          u_lumenFgNeighborhood: () => E,
          u_lumenReceiverPosition: () => P,
          u_lumenReceiverNormal: () => N,
          u_lumenFgEnabled: () => enabled,
          u_lumenFgHistory: () => true,
          u_lumenWorldEnabled: () => true,
          u_lumenFgLazyFallback: () => lazy,
          u_lumenLegacyKernel: () => false,
          u_lumenLinearAtlas: () => false,
          u_lumenProbeOrigin: () => origin,
          u_lumenProbeCounts: () => new C.Cartesian3(2, 2, 2),
          u_lumenIrradiance: () => C.Cartesian3.ZERO,
          u_lumenProbeSpacing: () => 5,
          u_lumenNormalBias: () => 0,
          u_lumenWorldGain: () => 1,
          u_lumenCoverage: () => 1,
          u_lumenFgSurfaceId: () => 3,
          u_lumenEyeToLocal: () => C.Matrix4.IDENTITY,
          u_lumenFgSceneSize: () => new C.Cartesian2(1, 1),
          u_lumenReceiverSize: () => new C.Cartesian2(2, 2),
          u_lumenFgSize: () => new C.Cartesian2(2, 2),
          u_lumenFgOffset: () => C.Cartesian2.ZERO,
          u_lumenGatherControl: () => new C.Cartesian4(1, 1, -1, 1),
          u_lumenDebugMode: () => debug,
          u_view: () => view,
          u_ns: () => ns,
        },
      },
    );
    w._commands.ownershipCheck = cmd;
    const rows = [];
    try {
      for (const name of [
        "inside",
        "outside",
        "unsupported",
        "Ns-not-Ng",
        "debug",
      ])
        for (const lazyFallback of [false, true]) {
          origin = new C.Cartesian3(name === "outside" ? 100000 : -2, -2, -12);
          lazy = lazyFallback;
          enabled = name !== "unsupported";
          debug = name === "debug" ? 1 : 0;
          ns =
            name === "Ns-not-Ng"
              ? new C.Cartesian3(0.2, 0, Math.sqrt(0.96))
              : new C.Cartesian3(0, 0, 1);
          const values = [];
          for (view = 0; view < 3; view++) {
            w._draw("ownershipCheck", fb, 0, 0, 1, 1);
            values.push(Array.from(w._read(fb, 1, 1)));
          }
          rows.push({
            name,
            lazyFallback,
            irradianceAndWeight: values[0],
            callsAndCoverage: values[1],
            dataAndReason: values[2],
          });
        }
    } finally {
      delete w._commands.ownershipCheck;
      cmd.shaderProgram.destroy();
      for (const texture of textures)
        w._freeTexture(texture, texture === target ? fb : undefined);
    }
    return rows;
  });
  const close = (actual, expected) =>
    assert(
      actual.every((v, i) => Math.abs(v - expected[i]) < 0.000005),
      JSON.stringify({ actual, expected }),
    );
  for (const row of report.rows) {
    const outside = row.name === "outside",
      fg = ["inside", "debug"].includes(row.name);
    close(row.irradianceAndWeight, [
      ...Array(3).fill(outside ? 0 : fg ? 2 : 0.2),
      fg ? 1 : 0,
    ]);
    close(row.callsAndCoverage, [
      row.lazyFallback && row.name === "inside" ? 0 : 1,
      ...Array(3).fill(outside ? 0 : 1),
    ]);
    assert(Math.abs(row.dataAndReason[0] - (outside ? 0 : 1)) < 0.000005);
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(out + "/ownership.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    error: report.error,
  }),
);
