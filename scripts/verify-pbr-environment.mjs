import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
} from "./browser-tools.mjs";
const out = "reports/ddgi-visual-quality-v4";
await mkdir(out, { recursive: true });
const report = { version: sourceVersion(), checks: [], errors: [] };
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 960, height: 640 } });
await page.addInitScript(installGlObserver);
page.on("pageerror", (e) => report.errors.push(e.stack ?? String(e)));
try {
  await page.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&ibl=dynamic",
  );
  await page.waitForFunction(
    () =>
      earthLab.world?.status === "ready" &&
      earthLab.model.environmentMapManager._specularMapReady,
    null,
    { timeout: 180000 },
  );
  report.environment = await page.evaluate(() => ({
    description: earthLab.lightingEnvironment.snapshot(),
    mipMaximum: earthLab.model.environmentMapManager.maximumMipmapLevel,
    width: earthLab.model.environmentMapManager.radianceCubeMap.width,
    generateSH: earthLab.model.environmentMapManager.generateSphericalHarmonics,
  }));
  assert.equal(report.environment.generateSH, false);
  assert.equal(
    report.environment.mipMaximum,
    Math.log2(report.environment.width),
  );
  report.forward = await page.evaluate(() => {
    earthLab.camera("boxFoot");
    earthLab.widget.render();
    earthLab.widget.render();
    const w = earthLab.world;
    earthLab.scene.lumen.debugMode = 9;
    earthLab.widget.render();
    earthLab.widget.render();
    const fb = earthLab.scene._view.sceneFramebuffer._colorFramebuffer;
    const data = w._read(
      fb._multisampleFramebuffer?.getColorFramebuffer() ?? fb.framebuffer,
      earthLab.scene.drawingBufferWidth,
      earthLab.scene.drawingBufferHeight,
    );
    let maximum = 0;
    for (let i = 0; i < data.length; i++)
      if (i % 4 < 3) maximum = Math.max(maximum, data[i]);
    earthLab.scene.lumen.debugMode = 0;
    return {
      maximum,
      specularCommands: earthLab.scene.frameState.commandList.filter(
        (c) =>
          c.owner === earthLab.model &&
          c.shaderProgram?._fragmentShaderSource?.defines.includes(
            "SPECULAR_IBL",
          ),
      ).length,
    };
  });
  assert.ok(
    report.forward.specularCommands > 0 && report.forward.maximum > 0.001,
    "real generated IBL must enter forward model shader",
  );
  report.samples = await page.evaluate(async () => {
    const d = earthLab,
      w = d.world,
      C = Cesium,
      manager = d.model.environmentMapManager;
    const readEnvironment = () => {
      const tex = w._texture(24, 1),
        fb = w._framebuffer([tex]);
      const cmd = d.scene.context.createViewportQuadCommand(
        "precision highp float;uniform samplerCube u_env;uniform float u_lod;void main(){int i=int(gl_FragCoord.x);int face=i/4;vec3 v=vec3(0.0);v[face/2]=(face%2==0?1.0:-1.0);out_FragColor=vec4(textureLod(u_env,v,float(i%4)*u_lod/3.0).rgb,1.0);}",
        {
          uniformMap: {
            u_env: () => manager.radianceCubeMap,
            u_lod: () => manager.maximumMipmapLevel,
          },
        },
      );
      w._commands.envSample = cmd;
      try {
        w._draw("envSample", fb, 0, 0, 24, 1);
        return Array.from(w._read(fb, 24, 1));
      } finally {
        cmd.shaderProgram.destroy();
        delete w._commands.envSample;
      }
    };
    glObserver.phase("environment-diagnostic");
    const before = readEnvironment();
    glObserver.phase("environment-production-update");
    document.getElementById("sun").value = "140";
    document.getElementById("sun").dispatchEvent(new Event("change"));
    await w.completed;
    for (
      let i = 0;
      i < 180 && (!manager._specularMapReady || w._queries.length);
      i++
    )
      await new Promise(requestAnimationFrame);
    const production = glObserver.snapshot();
    glObserver.phase("environment-diagnostic");
    const after = readEnvironment();
    return {
      before,
      after,
      production,
      description: d.lightingEnvironment.snapshot(),
      mode: d.scene.atmosphere.dynamicLighting,
    };
  });
  for (const s of report.samples.production)
    for (const key of [
      "readPixels",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
    ])
      assert.equal(
        s.phases["environment-production-update"]?.[key] ?? 0,
        0,
        key,
      );
  assert.ok(
    report.samples.before.some(
      (v, i) => Math.abs(v - report.samples.after[i]) > 1e-3,
    ),
  );
  assert.ok(
    report.samples.before.some(
      (v, i) =>
        i % 4 < 3 &&
        Math.abs(v - report.samples.before[Math.floor(i / 16) * 16 + (i % 4)]) >
          1e-3,
    ),
  );
  assert.equal(report.samples.mode, 1);
  report.checks.push(
    "real cubemap mips, roughness/direction response, manual solar refresh, zero production sync readbacks",
  );
  // Compile the actual engine IBL stage against a unit-radiance furnace. No duplicated BRDF.
  report.furnace = await page.evaluate(async () => {
    const d = earthLab,
      w = d.world,
      C = Cesium;
    let source = await (
      await fetch(
        "/cesium-1.146/packages/engine/Source/Shaders/Model/ImageBasedLightingStageFS.glsl",
      )
    ).text();
    source = source.replaceAll("\r\n", "\n");
    const a = source.indexOf(
        "#ifdef DIFFUSE_IBL\nvec3 sampleDiffuseEnvironment",
      ),
      b = source.indexOf("#ifdef SPECULAR_IBL", a);
    source =
      source.slice(0, a) +
      "vec3 sampleDiffuseEnvironment(vec3 d){return vec3(u_environmentScale);}\n" +
      source.slice(b);
    const c = source.indexOf("vec3 sampleSpecularEnvironment"),
      end = source.indexOf("vec3 computeSpecularIBL", c);
    source =
      source.slice(0, c) +
      "vec3 sampleSpecularEnvironment(vec3 d,float r){return vec3(u_environmentScale);}\n" +
      source.slice(end);
    const entries = [];
    for (const base of [0.02, 0.18, 1])
      for (const metallic of [0, 1])
        for (const roughness of [0.05, 0.25, 0.5, 0.75, 1])
          for (const ndotv of [0.1, 0.5, 1])
            entries.push({ base, metallic, roughness, ndotv });
    const input = new Float32Array(entries.length * 4);
    entries.forEach((v, i) =>
      input.set([v.base, v.metallic, v.roughness, v.ndotv], i * 4),
    );
    const inputTex = w._texture(
        entries.length,
        1,
        C.PixelDatatype.FLOAT,
        input,
      ),
      outTex = w._texture(entries.length, 1),
      fb = w._framebuffer([outTex]);
    let coverage = 1,
      scale = 1,
      mode = 0;
    const shader =
      "#define DIFFUSE_IBL\n#define SPECULAR_IBL\n#define LUMEN_MODEL_LIGHTING\nprecision highp float;uniform bool u_lumenEnabled;uniform sampler2D u_materialInput;uniform float u_environmentScale;uniform float u_coverage;uniform int u_mode;uniform mat3 model_iblReferenceFrameMatrix;uniform vec2 model_iblFactor;float lumen_materialCoverage=0.0;float lumen_environmentCoverage=0.0;\n" +
      source +
      "\nvoid main(){vec4 v=texelFetch(u_materialInput,ivec2(gl_FragCoord.xy),0);czm_modelMaterial m;m.diffuse=vec3(v.x*(1.0-v.y));m.specular=mix(vec3(0.04),vec3(v.x),v.y);m.roughness=v.z;m.occlusion=1.0;vec3 n=vec3(0,0,1),eye=vec3(sqrt(1.0-v.w*v.w),0,v.w);lumen_materialCoverage=u_coverage;lumen_environmentCoverage=u_coverage;vec3 color=textureIBL(eye,n,m);vec3 local=lumen_iblDiffuseResponse*u_environmentScale*u_coverage;color+=local;if(u_mode==1)color=local;if(u_mode==2)color=lumen_environmentDiffuse;if(u_mode==3)color=lumen_environmentSpecular;if(u_mode==4)color=lumen_environmentMultiple;if(u_mode==99)color=czm_pbrLighting(eye,n,n,m);out_FragColor=vec4(color,1.0);}";
    const cmd = d.scene.context.createViewportQuadCommand(shader, {
      uniformMap: {
        u_lumenEnabled: () => true,
        u_materialInput: () => inputTex,
        u_environmentScale: () => scale,
        u_coverage: () => coverage,
        u_mode: () => mode,
        model_iblReferenceFrameMatrix: () => C.Matrix3.IDENTITY,
        model_iblFactor: () => new C.Cartesian2(1, 1),
      },
    });
    w._commands.furnace = cmd;
    const runs = [];
    try {
      for (const cov of [0, 0.5, 1])
        for (const s of [1, 2])
          for (const m of [0, 1, 2, 3, 4]) {
            coverage = cov;
            scale = s;
            mode = m;
            w._draw("furnace", fb, 0, 0, entries.length, 1);
            const values = w._read(fb, entries.length, 1);
            runs.push({ coverage, scale, mode, values: Array.from(values) });
          }
    } finally {
      cmd.shaderProgram.destroy();
      delete w._commands.furnace;
    }
    return { entries, runs };
  });
  const runs = report.furnace.runs,
    find = (coverage, scale, mode) =>
      runs.find(
        (r) => r.coverage === coverage && r.scale === scale && r.mode === mode,
      ).values;
  for (let i = 0; i < report.furnace.entries.length; i++) {
    const m = report.furnace.entries[i];
    for (const coverage of [0, 0.5, 1]) {
      const full = find(coverage, 1, 0),
        double = find(coverage, 2, 0),
        indirect = find(coverage, 1, 1),
        diffuse = find(coverage, 1, 2),
        spec = find(coverage, 1, 3),
        multi = find(coverage, 1, 4);
      for (let c = 0; c < 3; c++) {
        const o = i * 4 + c;
        assert.ok(
          full[o] >= 0 && full[o] <= 1.015,
          "white furnace energy bound",
        );
        assert.ok(Math.abs(double[o] - 2 * full[o]) < 1e-5);
        assert.ok(
          Math.abs(full[o] - indirect[o] - diffuse[o] - spec[o] - multi[o]) <
            1e-5,
        );
        assert.ok(
          Math.abs(full[o] - find(0, 1, 0)[o]) < 1e-5,
          "coverage must conserve matched environment E/pi",
        );
        if (m.metallic === 1) assert.equal(indirect[o], 0);
        assert.ok(Math.abs(multi[o] - find(0, 1, 4)[o]) < 1e-6);
      }
    }
  }
  report.checks.push(
    "90 materials/view angles: white furnace, linear source scaling, coverage conservation, zero metal diffuse, independent specular MS",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errors.push(e.stack ?? String(e));
  process.exitCode = 1;
} finally {
  await writeFile(out + "/pbr-environment.json", JSON.stringify(report));
  await browser.close();
}
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks,
    errors: report.errors,
  }),
);
