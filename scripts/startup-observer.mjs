// Explicit acceptance instrumentation only. No production readbacks or shader queries.
export function installStartupObserver() {
  const state = window.startupProbe = {
    timeOrigin: performance.timeOrigin, shellInteractive: null,
    firstSceneFrame: null, firstAssetFrame: null, firstNewGIFrame: null,
    targetFGFrame: null, gaps: [], tasks: [], inputs: [], calls: {},
    programs: [], shaders: [], sources: [], snapshots: [], errors: [],
    sourceBytes: 0, overflow: false,
  };
  let previous = performance.now(), active = true, scene, removeFrame;
  let frame = {globe:false, asset:false, gi:false, fg:false};
  const shaderRows = new WeakMap(), programRows = new WeakMap(), contexts = new Set();
  const sources = new Map(), current = new WeakMap();
  const now = () => performance.now();
  const call = (name, row, fn, args, receiver, parameter) => {
    const start = now();
    try { return fn.apply(receiver, args); }
    finally {
      const duration = now() - start;
      const s = state.calls[name] ??= {count: 0, milliseconds: 0, max: 0};
      s.count++; s.milliseconds += duration; s.max = Math.max(s.max, duration);
      if (row) {
        const r = row.calls[name] ??= {count: 0, milliseconds: 0, max: 0};
        r.count++; r.milliseconds += duration; r.max = Math.max(r.max, duration);
        if (duration >= 50) (row.stalls ??= []).push({name, start, duration, parameter});
      }
    }
  };
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!type) continue;
    const p = type.prototype;
    const wrap = (name, wrapper) => {
      const native = p[name];
      if (typeof native === "function") p[name] = function(...a) { return wrapper.call(this, native, a); };
    };
    wrap("createShader", function(fn, a) {
      const shader = fn.apply(this, a), row = {id: state.shaders.length, type: a[0], calls: {}};
      shaderRows.set(shader, row); state.shaders.push(row); contexts.add(this); return shader;
    });
    wrap("shaderSource", function(fn, a) {
      const row = shaderRows.get(a[0]), text = a[1];
      if (row) {
        if (!sources.has(text)) {
          const bytes = text.length * 2;
          if (state.sourceBytes + bytes > 32 * 1048576) state.overflow = true;
          else { sources.set(text, state.sources.length); state.sources.push(text); state.sourceBytes += bytes; }
        }
        row.source = sources.get(text) ?? null;
      }
      return call("shaderSource", row, fn, a, this);
    });
    wrap("createProgram", function(fn, a) {
      const program = fn.apply(this, a), row = {id: state.programs.length, created: now(), shaders: [], calls: {}};
      programRows.set(program, row); state.programs.push(row); return program;
    });
    wrap("attachShader", function(fn, a) {
      programRows.get(a[0])?.shaders.push(shaderRows.get(a[1])?.id);
      return fn.apply(this, a);
    });
    for (const name of ["compileShader", "linkProgram", "getProgramParameter", "getShaderParameter", "getActiveUniform", "getActiveAttrib", "getUniformLocation", "getAttribLocation", "getProgramInfoLog", "getShaderInfoLog", "deleteProgram"])
      wrap(name, function(fn, a) {
        const row = name.includes("Shader") ? shaderRows.get(a[0]) : programRows.get(a[0]);
        if (name === "linkProgram" && row) {
          row.submitted = now();
          row.asset = row.shaders.some(id => state.sources[state.shaders[id]?.source]?.includes("czm_modelMaterial"));
          row.fg = row.shaders.some(id => /^#define LUMEN_FG_RECONSTRUCTION\b/m.test(state.sources[state.shaders[id]?.source] ?? ""));
          row.receiver = row.shaders.some(id => /^#define LUMEN_RECEIVER_PASS\b/m.test(state.sources[state.shaders[id]?.source] ?? ""));
          row.depthOnly = row.shaders.some(id => /void (?:czm_shadow_cast_main|czm_pick_main|czm_depth_main)\b/.test(state.sources[state.shaders[id]?.source] ?? ""));
          row.globe = row.shaders.some(id => /vec4 computeDayColor\s*\(/.test(state.sources[state.shaders[id]?.source] ?? ""));
          row.localGI = row.shaders.some(id => /^#define LUMEN_MODEL_LIGHTING\b/m.test(state.sources[state.shaders[id]?.source] ?? ""));
        }
        if (name === "deleteProgram" && row) row.deleted = now();
        return call(name, row, fn, a, this, a[1]);
      });
    wrap("useProgram", function(fn, a) {
      const row = programRows.get(a[0]); current.set(this, row);
      if (row && row.firstUse === undefined) row.firstUse = now();
      return call("useProgram", row, fn, a, this);
    });
    for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) wrap(name, function(fn, a) {
      const row = current.get(this), start = now();
      const result = call(name, row, fn, a, this);
      if (active) {
        if(row) row.firstDraw ??= start;
        frame.globe ||= !!row?.globe;
        if (row?.asset && !row.receiver && !row.depthOnly) {
          frame.asset = true; frame.fg ||= row.fg;
          const session = window.pilotSession, world = session?.world;
          if (row.localGI && session?.ready && world?.ready && world === scene?.lumen.world && scene.lumen.enabled && world.requestedRevision === world.publishedRevision)
            frame.gi = true;
        }
      }
      return result;
    });
    for (const name of ["bufferData", "bufferSubData", "texImage2D", "texSubImage2D", "texStorage2D"]) wrap(name, function(fn, a) { return call(name, null, fn, a, this); });
  }
  try { new PerformanceObserver(list => state.tasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration, name: e.name})))).observe({type: "longtask", buffered: true}); } catch {}
  const emitInput = event => {
    if (!event.isTrusted || (event.type === "keydown" && event.code !== "F8")) return;
    const handled = now(), cancel = document.getElementById("cancel");
    const row = {kind: event.type, handled, delay: Math.max(0, handled - event.timeStamp), shellReady: typeof cancel?.onclick === "function", phase: window.pilotSession?.phase, generation: window.pilotSession?.generation};
    state.inputs.push(row);
    if (row.shellReady) state.shellInteractive ??= handled;
    window.recordStartupInput?.(row).catch(() => {});
  };
  window.addEventListener("keydown", emitInput);
  window.addEventListener("click", emitInput);
  window.addEventListener("error", e => state.errors.push(String(e.message)));
  const tick = () => {
    if (!active) return;
    const t = now(), gap = t - previous;
    if (gap > 50) state.gaps.push({start: previous, duration: gap});
    previous = t;
    scene ??= window.pilotHost?.scene;
    if(scene && !removeFrame) removeFrame=scene.postRender.addEventListener(()=>{
      const t=now();
      if(frame.globe) state.firstSceneFrame ??= t;
      if(frame.asset) state.firstAssetFrame ??= t;
      if(frame.gi) state.firstNewGIFrame ??= t;
    const session = window.pilotSession, world = session?.world, fg = scene?.lumen.finalGather;
    if (fg && world) {
      const metrics = fg.metrics;
      if (frame.fg && fg._sampleWorld === world && metrics.effectiveMode === "fg" && metrics.history && world.ready && world.publishedBounce === 3 && metrics.round === 3 && metrics.revision === world.requestedRevision && world.requestedRevision === world.publishedRevision && metrics.stablePasses >= 32 && metrics.sampleEpoch >= 32 && fg.models.size > 0)
        state.targetFGFrame ??= t;
    }
      frame = {globe:false, asset:false, gi:false, fg:false};
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  state.finish = () => {
    active = false;
    removeFrame?.();
    state.finished = now();
    state.resources = performance.getEntriesByType("resource").map(e => ({name: e.name, start: e.startTime, duration: e.duration, encoded: e.encodedBodySize, decoded: e.decodedBodySize, initiator: e.initiatorType}));
    state.extensions = [...contexts].map(gl => ({parallel: !!gl.getExtension("KHR_parallel_shader_compile"), renderer: gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight]}));
    return {...state, finish: undefined};
  };
}
