import assert from "node:assert/strict";
import ShaderProgram from "../cesium-1.146/packages/engine/Source/Renderer/ShaderProgram.js";
import ShaderCache from "../cesium-1.146/packages/engine/Source/Renderer/ShaderCache.js";
import Context from "../cesium-1.146/packages/engine/Source/Renderer/Context.js";
import variant from "../cesium-1.146/packages/engine/Source/Scene/LumenShaderVariant.js";
import BrdfLutGenerator from "../cesium-1.146/packages/engine/Source/Scene/BrdfLutGenerator.js";
import DrawCommand from "../cesium-1.146/packages/engine/Source/Renderer/DrawCommand.js";
import ShaderSource from "../cesium-1.146/packages/engine/Source/Renderer/ShaderSource.js";
import {
  drainRetiredPreparations,
  whenPreparationIdle,
  maximumNativePreparations,
} from "../cesium-1.146/packages/engine/Source/Renderer/ShaderProgramCleanup.js";
function fixture({
  extension = true,
  complete = false,
  linked = true,
  reflectionFailure = false,
  submitFailure,
  deleteFailure = false,
  deleteShaderFailure = false,
} = {}) {
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
      if (submitFailure === "compile")
        throw Error("injected compile submit failure");
    },
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {
      calls.push("link");
      if (submitFailure === "link") throw Error("injected link submit failure");
    },
    getExtension: () => (extension ? { COMPLETION_STATUS_KHR: 0x91b1 } : null),
    isContextLost: () => lost,
    getProgramParameter(p, key) {
      calls.push(key);
      if (key === 0x91b1) return complete;
      assert(complete || !extension, "reflection before completion");
      if (key === 3) return linked;
      if (key === 4 && reflectionFailure) return 1;
      return 0;
    },
    getActiveAttrib() {
      throw Error("injected reflection failure");
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
      if (deleteShaderFailure) throw Error("injected shader deletion failure");
    },
    deleteProgram() {
      calls.push("deleteProgram");
      if (deleteFailure) throw Error("injected native deletion failure");
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
pending.context.draw = Context.prototype.draw;
pending.context._defaultPassState = {};
const registration = {},
  neverDrawn = {},
  actualBase = {};
Context.prototype._trackLumenBaseShader.call(registration, neverDrawn);
assert.equal(
  registration._lumenBaseGroup.programs.size,
  0,
  "An intermediate source must not request a native compile",
);
Context.prototype._trackLumenBaseShader.call(registration, actualBase, true);
assert.deepEqual([...registration._lumenBaseGroup.programs], [actualBase]);
assert.equal(
  typeof pending.shader.prepare,
  "function",
  "The actual ShaderProgram needs an opt-in prepare entry point",
);
assert.equal(pending.shader.prepare(), false);
assert.equal(
  new DrawCommand({ shaderProgram: pending.shader }).execute(pending.context),
  false,
);
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
assert.equal(
  disposed.calls.filter((c) => c === "deleteProgram").length,
  0,
  "Retirement must not delete an in-flight linker",
);
assert.equal(disposed.context._shaderPreparationLifetime.retired.size, 1);
let idle = false;
whenPreparationIdle(disposed.context, () => {
  idle = true;
});
drainRetiredPreparations(disposed.context);
assert(!idle);
disposed.complete();
drainRetiredPreparations(disposed.context);
assert(idle);
assert(
  !disposed.calls.includes(3),
  "Cleanup must not query LINK_STATUS or reflect",
);
assert.equal(disposed.calls.filter((c) => c === "deleteProgram").length, 1);
const fallback = fixture({ extension: false });
assert.equal(fallback.shader.prepare(), true);
assert.equal(fallback.shader.preparationFallback, "synchronous-no-extension");
const failure = fixture({ complete: true, linked: false });
failure.shader.prepare();
failure.complete();
assert.throws(() => failure.shader.prepare(), /failed to compile/);
assert.equal(failure.shader.preparationState, "failed");
for (const extension of [true, false]) {
  const reflection = fixture({ extension, reflectionFailure: true });
  if (extension) {
    reflection.shader.prepare();
    reflection.complete();
  }
  assert.throws(() => reflection.shader.prepare(), /reflection failure/);
  assert.equal(reflection.shader.preparationState, "failed");
  assert.equal(reflection.shader._program, undefined);
  assert.throws(() => reflection.shader._bind(), /failed/);
  assert.throws(() => reflection.shader.allUniforms, /failed/);
  assert.equal(reflection.calls.filter((c) => c === "deleteProgram").length, 1);
}
const shared = fixture(),
  cache = new ShaderCache(shared.context);
for (const submitFailure of ["compile", "link"]) {
  const f = fixture({ submitFailure });
  assert.throws(() => f.shader.prepare(), /submit failure/);
  assert.equal(f.shader.preparationState, "failed");
  f.shader.finalDestroy();
  f.complete();
  drainRetiredPreparations(f.context);
  assert.equal(
    f.calls.filter((c) => c === "deleteShader").length,
    submitFailure === "compile" ? 1 : 2,
  );
  assert.equal(
    f.calls.filter((c) => c === "deleteProgram").length,
    submitFailure === "compile" ? 0 : 1,
  );
}
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
shared.complete();
drainRetiredPreparations(shared.context);
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
const family = fixture(),
  familyCache = new ShaderCache(family.context);
familyCache.beginPreparationLease();
const root = familyCache.getShaderProgram(options);
root.prepare();
const child = familyCache.createDerivedShaderProgram(
  root,
  "test-depth",
  options,
);
family.context._shaderPreparationSubmissions = 0;
family.context._shaderPreparationFrame = 1;
child.prepare();
family.complete();
family.context._shaderPreparationFrame = 2;
assert(child.prepare());
assert.equal(
  familyCache._preparationLease.size,
  0,
  "A ready child must not pin a pending root family",
);
root.destroy();
familyCache.destroyReleasedShaderPrograms();
drainRetiredPreparations(family.context);
assert(root.isDestroyed() && child.isDestroyed());
assert.equal(family.calls.filter((c) => c === "deleteProgram").length, 2);
const late = fixture(),
  lateCache = new ShaderCache(late.context);
lateCache.beginPreparationLease();
late.context.shaderCache = lateCache;
const lateRoot = lateCache.getShaderProgram(options);
lateRoot.prepare();
late.complete();
assert(lateRoot.prepare());
assert.equal(lateCache._preparationLease.size, 1);
const lateChild = lateCache.createDerivedShaderProgram(
  lateRoot,
  "later",
  options,
);
late.context._shaderPreparationSubmissions = 0;
late.context._shaderPreparationFrame = 2;
assert.equal(lateChild.prepare(), false);
assert.equal(
  lateCache._preparationLease.size,
  0,
  "A new pending child must revoke the family's completed-program pin",
);
lateRoot.destroy();
lateCache.destroyReleasedShaderPrograms();
assert(lateChild.isDestroyed() && lateRoot.isDestroyed());
const depth = fixture(),
  depthCache = new ShaderCache(depth.context);
depth.context._trackLumenBaseShader = () => {};
const depthRoot = depthCache.getShaderProgram(options);
depthRoot._lumenModelProgram = true;
for (const keyword of ["depthOnly", "pick", "snap"]) {
  const d = depthCache.createDerivedShaderProgram(depthRoot, keyword, {
    ...options,
    fragmentShaderSource: new ShaderSource({
      defines: [
        "LUMEN_RECEIVER_COMPOSITE",
        "LUMEN_FG_RECONSTRUCTION",
        "LUMEN_DIAGNOSTICS",
      ],
      sources: ["void main(){if(false) discard;out_FragColor=vec4(1.0);}"],
    }),
  });
  assert(
    d._lumenDepthOnly && !d._lumenFgProgram,
    keyword + " cannot count as forward FG",
  );
  assert(!d.fragmentShaderSource.defines.includes("LUMEN_FG_RECONSTRUCTION"));
  const nested = depthCache.createDerivedShaderProgram(d, "logDepth", options);
  assert(nested._lumenDepthOnly && !nested._lumenFgProgram);
  assert.equal(depthCache.getDerivedShaderProgram(depthRoot, keyword), d);
  assert.equal(depthCache.getDerivedShaderProgram(d, "logDepth"), nested);
}
depthRoot.destroy();
depthCache.destroyReleasedShaderPrograms();
// The Scene-owned LUT can outlive its initiating session. Turning the session
// opt-in off must not publish an unexecuted LUT or stop its pending preparation.
const lut = new BrdfLutGenerator(),
  lutFixture = fixture();
let lutDraws = 0,
  lutDeletes = 0;
lut._colorTexture = {};
lut._drawCommand = {
  shaderProgram: lutFixture.shader,
  framebuffer: {
    destroy() {
      lutDeletes++;
    },
  },
};
lutFixture.context.draw = () => {
  lutDraws++;
  return true;
};
lutFixture.shader.destroy = () => {
  lutDeletes++;
};
lutFixture.context._lumenShaderPreparation = true;
lut.update({ context: lutFixture.context });
lutFixture.context._lumenShaderPreparation = false;
lut.update({ context: lutFixture.context });
assert(!lut._ready && lutDraws === 0 && lutDeletes === 0);
lutFixture.complete();
lut.update({ context: lutFixture.context });
assert(
  lut._ready &&
    lutDraws === 1 &&
    lutDeletes === 2 &&
    !lutFixture.context._lumenBrdfPending,
);
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
const bounded = fixture(),
  programs = [];
for (let i = 0; i < maximumNativePreparations + 1; i++) {
  bounded.context._shaderPreparationSubmissions = 0;
  bounded.context._shaderPreparationFrame = i;
  const shader = new ShaderProgram({
    gl: bounded.gl,
    context: bounded.context,
    vertexShaderText: "void main(){}",
    fragmentShaderText: "void main(){}",
    asynchronousCompilation: true,
  });
  assert.equal(shader.prepare(), false);
  programs.push(shader);
}
assert.equal(
  bounded.context._shaderPreparationLifetime.native.size,
  maximumNativePreparations,
);
assert.equal(
  programs.at(-1)._pending,
  undefined,
  "Active plus retired native handles have a fixed cap",
);
for (const shader of programs) shader.finalDestroy();
assert.equal(
  bounded.context._shaderPreparationLifetime.retired.size,
  maximumNativePreparations,
);
bounded.complete();
drainRetiredPreparations(bounded.context);
assert.equal(bounded.context._shaderPreparationLifetime.native.size, 0);
const quarantined = fixture({ deleteFailure: true });
quarantined.shader.prepare();
quarantined.shader.finalDestroy();
quarantined.complete();
let quarantineIdle = false;
whenPreparationIdle(quarantined.context, () => {
  quarantineIdle = true;
});
drainRetiredPreparations(quarantined.context);
assert.equal(quarantined.context._shaderPreparationLifetime.native.size, 1);
assert([...quarantined.context._shaderPreparationLifetime.retired][0].program);
assert(!quarantineIdle);
quarantined.lose();
drainRetiredPreparations(quarantined.context);
assert.equal(quarantined.context._shaderPreparationLifetime.native.size, 0);
assert(quarantineIdle);
for (const options of [
  { linked: false, deleteFailure: true },
  { deleteShaderFailure: true },
  { reflectionFailure: true, deleteFailure: true },
]) {
  for (const extension of [true, false]) {
    const f = fixture({ ...options, extension });
    if (extension) {
      f.shader.prepare();
      f.complete();
    }
    assert.throws(() => f.shader.prepare());
    drainRetiredPreparations(f.context);
    const lifetime = f.context._shaderPreparationLifetime;
    assert.equal(lifetime.native.size, 1);
    assert(lifetime.error && [...lifetime.retired][0].quarantined);
    let idle = false;
    whenPreparationIdle(f.context, () => {
      idle = true;
    });
    assert(!idle, "Completion cleanup failure must retain native ownership");
    f.lose();
    drainRetiredPreparations(f.context);
    assert(idle);
  }
}
// Submit a full queue, then hide all of its commands. Completed native jobs
// still progress through the frame boundary, without compiling unused roots.
const hidden = fixture(),
  hiddenPrograms = [];
for (let i = 0; i <= maximumNativePreparations; i++) {
  hidden.context._shaderPreparationSubmissions = 0;
  hidden.context._shaderPreparationFrame = i;
  const s = new ShaderProgram({
    gl: hidden.gl,
    context: hidden.context,
    vertexShaderText: "void main(){}",
    fragmentShaderText: "void main(){}",
    asynchronousCompilation: true,
  });
  s.prepare();
  hiddenPrograms.push(s);
}
hidden.complete();
hidden.context._shaderPreparationFrame = maximumNativePreparations + 1;
Context.prototype._progressShaderPreparations.call(hidden.context);
assert.equal(
  hidden.context._shaderPreparationLifetime.native.size,
  maximumNativePreparations - 1,
);
hidden.context._shaderPreparationSubmissions = 0;
assert.equal(hiddenPrograms.at(-1).prepare(), false);
assert(
  hiddenPrograms.at(-1)._pending,
  "A newly visible command must gain admission",
);
for (const s of hiddenPrograms) s.finalDestroy();
drainRetiredPreparations(hidden.context);
assert.equal(hidden.context._shaderPreparationLifetime.native.size, 0);
console.log(
  JSON.stringify({
    status: "passed",
    scope:
      "real ShaderProgram lifecycle; pending cannot reflect/bind, lost/failed/destroyed clean up, no-extension is explicit",
  }),
);
