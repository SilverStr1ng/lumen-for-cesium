import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
export async function probeNativeCancellation(page, output) {
  const result = await page.evaluate(async () => {
    const scene = pilotHost.scene,
      s = pilotSession;
    const source = Object.values(scene.context.shaderCache._shaders)
      .map((e) => e.shaderProgram)
      .find(
        (p) =>
          p._lumenModelProgram &&
          !p._lumenDepthOnly &&
          p._fragmentShaderText.includes("#define LUMEN_MODEL_LIGHTING") &&
          !p._fragmentShaderText.includes("#define LUMEN_FG_RECONSTRUCTION"),
      );
    if (!source)
      throw Error(
        "Production DDGI source required for native cancellation control",
      );
    const vertex = source._vertexShaderText,
      fragment = source._fragmentShaderText;
    const lease = s.budget.reserve(
      (vertex.length + fragment.length) * 2 * 32 + 131072,
      "explicit native cancellation control",
    );
    const frame = () => new Promise(requestAnimationFrame);
    const run = async (safe) => {
      const gl = document.createElement("canvas").getContext("webgl2"),
        ext = gl.getExtension("KHR_parallel_shader_compile");
      if (!ext) return { status: "not-run", reason: "KHR unavailable" };
      gl.getExtension("OES_texture_float_linear");
      const context = {
          _gl: gl,
          _shaderPreparationFrame: 0,
          _shaderPreparationSubmissions: 0,
        },
        live = [];
      const deadline = performance.now() + 30000;
      for (let i = 0; i < 32; i++) {
        const fs = fragment.replace(
          "#define u_lumenDebugMode 0",
          `#define u_lumenDebugMode 0\n#define CANCEL_TRIAL ${i}`,
        );
        if (safe) {
          context._shaderPreparationFrame++;
          context._shaderPreparationSubmissions = 0;
          const program = new Cesium.ShaderProgram({
            gl,
            context,
            vertexShaderText: vertex,
            fragmentShaderText: fs,
            asynchronousCompilation: true,
          });
          program.prepare();
          if (i % 2) program.finalDestroy();
          else live.push(program);
        } else {
          const v = gl.createShader(gl.VERTEX_SHADER),
            f = gl.createShader(gl.FRAGMENT_SHADER),
            p = gl.createProgram();
          gl.shaderSource(v, vertex);
          gl.shaderSource(f, fs);
          gl.compileShader(v);
          gl.compileShader(f);
          gl.attachShader(p, v);
          gl.attachShader(p, f);
          gl.linkProgram(p);
          if (i % 2) {
            gl.deleteShader(v);
            gl.deleteShader(f);
            gl.deleteProgram(p);
          } else live.push({ p, v, f });
        }
        await frame();
      }
      let linked = 0;
      while (live.length) {
        if (performance.now() > deadline)
          throw Error("Native cancellation control deadline");
        context._shaderPreparationFrame++;
        context._shaderPreparationSubmissions = 0;
        for (let i = live.length - 1; i >= 0; i--) {
          const p = live[i];
          if (safe) {
            if (!p.prepare()) continue;
            p.finalDestroy();
          } else {
            if (!gl.getProgramParameter(p.p, ext.COMPLETION_STATUS_KHR))
              continue;
            if (!gl.getProgramParameter(p.p, gl.LINK_STATUS))
              throw Error(
                "Control GLSL link failed: " + gl.getProgramInfoLog(p.p),
              );
            gl.deleteShader(p.v);
            gl.deleteShader(p.f);
            gl.deleteProgram(p.p);
          }
          linked++;
          live.splice(i, 1);
        }
        await frame();
      }
      while (context._shaderPreparationLifetime?.native.size) {
        if (performance.now() > deadline)
          throw Error("Retired native handles did not drain");
        await frame();
      }
      const result = {
        linked,
        error: gl.getError(),
        nativePeak: context._shaderPreparationLifetime?.peakNative ?? 0,
        retiredPeak: context._shaderPreparationLifetime?.peakRetired ?? 0,
        cleanupError: context._shaderPreparationLifetime?.error,
      };
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return result;
    };
    try {
      const unsafe = await run(false),
        safe = await run(true);
      return {
        vertex,
        fragment,
        unsafe,
        safe,
        programs: 32,
        cancelled: 16,
        passed:
          safe.linked === 16 &&
          safe.error === 0 &&
          !safe.cleanupError &&
          safe.nativePeak <= 32,
      };
    } finally {
      lease.release();
    }
  });
  for (const key of ["vertex", "fragment"]) {
    const source = result[key],
      hash = createHash("sha256").update(source).digest("hex");
    await writeFile(`${output}/native-cancel-${hash}.glsl`, source, {
      flag: "wx",
    });
    result[key] = { hash, bytes: Buffer.byteLength(source) };
  }
  result.negativeControlScope =
    "Raw independent WebGL2 context. Unsafe early deletion may reproduce ANGLE's native error; only safe cleanup is a required pass. No pixel readbacks or Model/world ownership in retirement records.";
  await writeFile(
    output + "/native-cancel.json",
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  return result;
}
