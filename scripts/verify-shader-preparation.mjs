import assert from "node:assert/strict";
import ShaderProgram from "../cesium-1.146/packages/engine/Source/Renderer/ShaderProgram.js";
import ShaderCache from "../cesium-1.146/packages/engine/Source/Renderer/ShaderCache.js";
import Context from "../cesium-1.146/packages/engine/Source/Renderer/Context.js";
import variant from "../cesium-1.146/packages/engine/Source/Scene/LumenShaderVariant.js";
function fixture({ extension = true, complete = false, linked = true } = {}) {
  const calls = [];
  let lost = false;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    LINK_STATUS: 3,
    ACTIVE_ATTRIBUTES: 4,
    ACTIVE_UNIFORMS: 5,
    COMPILE_STATUS: 6,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {
      calls.push("compile");
    },
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {
      calls.push("link");
    },
    getExtension: () => (extension ? { COMPLETION_STATUS_KHR: 0x91b1 } : null),
    isContextLost: () => lost,
    getProgramParameter(p, key) {
      calls.push(key);
      if (key === 0x91b1) return complete;
      assert(complete || !extension, "reflection before completion");
      if (key === 3) return linked;
      return 0;
    },
    getShaderParameter() {
      return false;
    },
    getShaderInfoLog() {
      return "injected compiler error";
    },
    getProgramInfoLog() {
      return "injected linker error";
    },
    deleteShader() {
      calls.push("deleteShader");
    },
    deleteProgram() {
      calls.push("deleteProgram");
    },
    useProgram() {
      calls.push("use");
    },
  };
  const context = { _gl: gl, _shaderPreparationSubmissions: 0 };
  const shader = new ShaderProgram({
    gl,
    context,
    vertexShaderText: "void main(){}",
    fragmentShaderText: "void main(){}",
    asynchronousCompilation: true,
  });
  return {
    gl,
    context,
    shader,
    calls,
    complete: () => {
      complete = true;
      context._shaderPreparationFrame = 1;
    },
    lose: () => {
      lost = true;
    },
  };
}
const pending = fixture();
assert.equal(
  typeof pending.shader.prepare,
  "function",
  "The actual ShaderProgram needs an opt-in prepare entry point",
);
assert.equal(pending.shader.prepare(), false);
assert.equal(pending.shader.preparationState, "pending");
assert(!pending.calls.includes(3) && !pending.calls.includes("use"));
assert.throws(() => pending.shader.allUniforms, /prepar/i);
assert.throws(() => pending.shader.vertexAttributes, /prepar/i);
assert.throws(() => pending.shader._bind(), /prepar/i);
assert.equal(
  Context.prototype.draw.call(
    pending.context,
    { _shaderProgram: pending.shader },
    {},
  ),
  false,
);
assert.equal(pending.shader.prepare(), false);
pending.complete();
assert.equal(pending.shader.prepare(), true);
assert.deepEqual(pending.shader.allUniforms, {});
assert.equal(pending.calls.filter((c) => c === "link").length, 1);
assert.equal(pending.shader.prepare(), true);
const lost = fixture();
lost.shader.prepare();
lost.lose();
assert.equal(lost.shader.prepare(), false);
assert.equal(lost.shader.preparationState, "cancelled");
assert(!lost.calls.includes(3) && !lost.calls.includes("use"));
assert.equal(lost.calls.filter((c) => c === "deleteProgram").length, 1);
const disposed = fixture();
disposed.shader.prepare();
disposed.shader.finalDestroy();
assert.equal(disposed.calls.filter((c) => c === "deleteProgram").length, 1);
const fallback = fixture({ extension: false });
assert.equal(fallback.shader.prepare(), true);
assert.equal(fallback.shader.preparationFallback, "synchronous-no-extension");
const failure = fixture({ complete: true, linked: false });
failure.shader.prepare();
failure.complete();
assert.throws(() => failure.shader.prepare(), /failed to compile/);
assert.equal(failure.shader.preparationState, "failed");
const shared = fixture(),
  cache = new ShaderCache(shared.context);
const options = {
  vertexShaderSource: "void main(){gl_Position=vec4(0.0);}",
  fragmentShaderSource: "void main(){out_FragColor=vec4(1.0);}",
  asynchronousCompilation: true,
};
const a = cache.getShaderProgram(options),
  b = cache.getShaderProgram(options);
assert.equal(a, b);
a.prepare();
a.destroy();
cache.destroyReleasedShaderPrograms();
assert.equal(
  shared.calls.filter((c) => c === "deleteProgram").length,
  0,
  "One cancelled model cannot delete a shared pending program",
);
b.destroy();
cache.destroyReleasedShaderPrograms();
assert.equal(shared.calls.filter((c) => c === "deleteProgram").length, 1);
const retained = fixture(),
  retainedCache = new ShaderCache(retained.context);
const release = retainedCache.beginPreparationLease(),
  s = retainedCache.getShaderProgram(options);
s.prepare();
assert.equal(
  retainedCache._preparationLease.size,
  0,
  "Request-only pending resources cannot be pinned",
);
retained.complete();
assert.equal(s.prepare(), true);
s.destroy();
retainedCache.destroyReleasedShaderPrograms();
assert(!s.isDestroyed());
const reused = retainedCache.getShaderProgram(options);
assert.equal(reused, s);
reused.destroy();
release();
retainedCache.destroyReleasedShaderPrograms();
assert(s.isDestroyed());
assert.equal(retained.calls.filter((c) => c === "deleteProgram").length, 1);
const model = {},
  fg = { models: new Set([model]), mode: "fg" },
  lumen = { enabled: true, debugMode: 0, finalGather: fg };
assert.equal(variant(model), "cesium");
assert.equal(variant(model, { lumen }), "fg");
lumen.debugMode = 4;
assert.equal(variant(model, { lumen }), "fg-diagnostic");
lumen.debugMode = 0;
fg.mode = "ddgi";
assert.equal(variant(model, { lumen }), "ddgi");
lumen.resourceBudget = {};
assert.equal(variant({}, { lumen }), "cesium");
model._lumenPendingDataset = true;
assert.equal(variant(model, { lumen }), "cesium");
console.log(
  JSON.stringify({
    status: "passed",
    scope:
      "real ShaderProgram lifecycle; pending cannot reflect/bind, lost/failed/destroyed clean up, no-extension is explicit",
  }),
);
