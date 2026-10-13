import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } }),
  report = {
    version: sourceVersion(),
    reference: "9406cafdd631721db2481d7dd9b53ab5b2418784",
    checks: [],
  };
p.on("console", (m) => {
  if (m.type() === "error") console.log("SHADER", m.text().slice(0, 5000));
});
try {
  await p.goto("http://localhost:8090/demo/regression.html?fixture=untextured");
  await p.waitForFunction(() => lumenTest.world?.status === "ready", null, {
    timeout: 120000,
  });
  report.rows = await p.evaluate(async () => {
    try {
      const w = lumenTest.world,
        C = Cesium,
        src = await (
          await fetch(
            "/cesium-1.146/packages/engine/Source/Shaders/Model/ImageBasedLightingStageFS.glsl",
          )
        ).text(),
        ref = await (
          await fetch("/fixtures/reference/IBL-9406caf.glsl")
        ).text();
      const adapt = (s) =>
        s
          .replaceAll("\r\n", "\n")
          .replace(
            /vec3 sampleDiffuseEnvironment\(vec3 cubeDir\)[\s\S]*?\n}\n/,
            "vec3 sampleDiffuseEnvironment(vec3 d){return vec3(0.19,0.37,0.12)+vec3(0.07,0.02,0.11)*d.z;}\n",
          )
          .replace(
            /vec3 sampleSpecularEnvironment\(vec3 cubeDir, float roughness\)[\s\S]*?\n}\n/,
            "vec3 sampleSpecularEnvironment(vec3 d,float r){return vec3(0.63,0.11,0.28)+abs(d)*0.17+r*vec3(0.04,0.09,0.02);}\n",
          );
      const entries = [];
      for (const base of [0.02, 0.18, 1])
        for (const metal of [0, 1])
          for (const rough of [0.05, 0.5, 1])
            for (const nv of [0.1, 0.5, 1])
              entries.push([base, metal, rough, nv]);
      const input = w._texture(
          entries.length,
          1,
          C.PixelDatatype.FLOAT,
          Float32Array.from(entries.flat()),
        ),
        out = w._texture(entries.length, 1),
        fb = w._framebuffer([out]);
      let enabled = false,
        enhanced = false,
        factor = new C.Cartesian2(1, 1);
      const rows = [];
      for (const d of [false, true])
        for (const s of [false, true])
          for (const defined of [false, true]) {
            const prefix =
              (d ? "#define DIFFUSE_IBL\n" : "") +
              (s ? "#define SPECULAR_IBL\n" : "") +
              (defined ? "#define LUMEN_MODEL_LIGHTING\n" : "") +
              "precision highp float;uniform bool u_lumenEnabled,u_lumenEnhancedIbl;uniform sampler2D u_input;uniform mat3 model_iblReferenceFrameMatrix;uniform vec2 model_iblFactor;float lumen_materialCoverage=0.35;float lumen_environmentCoverage=0.35;\n";
            const main =
              "void main(){vec4 v=texelFetch(u_input,ivec2(gl_FragCoord.xy),0);czm_modelMaterial m;m.diffuse=vec3(v.x*(1.0-v.y));m.specular=mix(vec3(0.04),vec3(v.x),v.y);m.roughness=v.z;m.occlusion=1.0;vec3 eye=vec3(sqrt(1.0-v.w*v.w),0,v.w);vec3 color=vec3(0);\n#if defined(DIFFUSE_IBL)||defined(SPECULAR_IBL)\ncolor=textureIBL(eye,normalize(vec3(0.15,-0.2,1)),m);\n#endif\nif(v.x<0.0)color=czm_pbrLighting(eye,vec3(0,0,1),vec3(0,0,1),m);out_FragColor=vec4(color,1);}";
            const commands = [ref, src].map((source) =>
              lumenTest.scene.context.createViewportQuadCommand(
                prefix + adapt(source) + main,
                {
                  uniformMap: {
                    u_lumenEnabled: () => enabled,
                    u_lumenEnhancedIbl: () => enhanced,
                    u_input: () => input,
                    model_iblReferenceFrameMatrix: () => C.Matrix3.IDENTITY,
                    model_iblFactor: () => factor,
                  },
                },
              ),
            );
            try {
              for (const e of [false, true])
                for (const policy of [false, true])
                  for (const f of [
                    [1, 1],
                    [0, 1],
                    [1, 0],
                    [0.3, 1.7],
                  ]) {
                    enabled = e;
                    enhanced = policy;
                    factor = C.Cartesian2.fromArray(f);
                    const values = [];
                    for (let i = 0; i < 2; i++) {
                      w._commands.iblPolicy = commands[i];
                      w._draw("iblPolicy", fb, 0, 0, entries.length, 1);
                      values.push(Array.from(w._read(fb, entries.length, 1)));
                    }
                    const error = Math.max(
                      ...values[0].map((v, i) => Math.abs(v - values[1][i])),
                    );
                    rows.push({
                      diffuse: d,
                      specular: s,
                      defined,
                      enabled: e,
                      enhanced: policy,
                      factor: f,
                      error,
                      reference: values[0],
                      actual: values[1],
                    });
                  }
            } finally {
              delete w._commands.iblPolicy;
              for (const cmd of commands) cmd.shaderProgram.destroy();
            }
          }
      return rows;
    } catch (e) {
      throw Error(e.message ?? String(e));
    }
  });
  const compatible = report.rows.filter(
    (r) => !r.defined || !r.enabled || !r.enhanced,
  );
  report.maximumLegacyError = Math.max(...compatible.map((r) => r.error));
  assert.ok(
    report.maximumLegacyError < 1e-6,
    "disabled/no define/legacy policy must restore pinned original IBL including nonuniform SH vs rough cube",
  );
  assert.ok(
    report.rows.some(
      (r) => r.defined && r.enabled && r.enhanced && r.error > 1e-3,
    ),
    "enhanced policy must remain a meaningful explicit alternative",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(
    "reports/receiver-final-gather-v5/ibl-policy.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.maximumLegacyError, report.error ?? "");
