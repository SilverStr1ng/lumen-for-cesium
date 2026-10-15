// A cancelled native linker can still use its program name on ANGLE's compiler
// thread. Isolate the request immediately, and delete only after KHR completion.
// Records retain handles only, never a Model, world, uniforms or publication.
export const maximumNativePreparations = 32;
export const preparationCapacityBytes = maximumNativePreparations * 4096;
const states = new WeakMap();
export function preparationState(shader) {
  const owner = shader._context ?? shader._gl;
  let state = states.get(owner);
  if (!state) {
    state = { native: new Set(), retired: new Set(), idle: new Set() };
    states.set(owner, state);
    if (shader._context) shader._context._shaderPreparationLifetime = state;
  }
  return state;
}
export function trackPreparation(shader, pending) {
  const state = preparationState(shader);
  pending.gl = shader._gl;
  pending.extension = shader._parallelCompile;
  pending.lifetime = state;
  state.native.add(pending);
  state.peakNative = Math.max(state.peakNative ?? 0, state.native.size);
}
function notifyIdle(state) {
  if (state.native.size) return;
  const callbacks = [...state.idle];
  state.idle.clear();
  for (const callback of callbacks) callback();
}
export function finishPreparation(pending) {
  const state = pending.lifetime;
  if (!state) return;
  state.native.delete(pending);
  state.retired.delete(pending);
  notifyIdle(state);
}
export function deletePreparationHandle(gl, pending, key) {
  const handle = pending[key];
  if (!handle) return;
  try {
    gl[key === "program" ? "deleteProgram" : "deleteShader"](handle);
    pending[key] = undefined;
  } catch (error) {
    if (pending.lifetime) {
      pending.lifetime.error = String(error);
      pending.quarantined = true;
      pending.lifetime.retired.add(pending);
      schedule(pending.lifetime);
    }
    throw error;
  }
}
function deleteHandles(pending) {
  const gl = pending.gl;
  let failed = false;
  for (const [method, key] of [
    ["deleteShader", "vertexShader"],
    ["deleteShader", "fragmentShader"],
    ["deleteProgram", "program"],
  ]) {
    const handle = pending[key];
    if (handle)
      try {
        gl[method](handle);
        pending[key] = undefined;
      } catch (error) {
        pending.lifetime.error = String(error);
        failed = true;
      }
  }
  if (failed) {
    pending.quarantined = true;
    pending.lifetime.retired.add(pending);
    schedule(pending.lifetime);
  } else finishPreparation(pending);
}
function schedule(state) {
  if (state.timer || !state.retired.size) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    drainState(state);
  }, 16);
  state.timer.unref?.();
}
function drainState(state) {
  for (const pending of [...state.retired]) {
    try {
      const gl = pending.gl;
      if (pending.quarantined) {
        if (gl.isContextLost?.()) finishPreparation(pending);
        continue;
      }
      if (
        !gl.isContextLost?.() &&
        pending.extension &&
        !gl.getProgramParameter(
          pending.program,
          pending.extension.COMPLETION_STATUS_KHR,
        )
      )
        continue;
      deleteHandles(pending);
    } catch (error) {
      state.error = String(error);
    }
  }
  if (!state.retired.size && state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  schedule(state);
}
export function retirePreparation(shader, pending) {
  if (!pending) return;
  if (!pending.lifetime) trackPreparation(shader, pending);
  const state = pending.lifetime;
  if (pending.quarantined) {
    state.retired.add(pending);
    schedule(state);
  } else if (
    pending.completed ||
    !pending.program ||
    !pending.extension ||
    pending.gl.isContextLost?.()
  )
    deleteHandles(pending);
  else {
    state.retired.add(pending);
    state.peakRetired = Math.max(state.peakRetired ?? 0, state.retired.size);
    schedule(state);
  }
}
export function drainRetiredPreparations(context) {
  const state = states.get(context);
  if (state) drainState(state);
}
export function whenPreparationIdle(context, callback) {
  const state = states.get(context);
  if (!state?.native.size) {
    callback();
    return () => {};
  }
  state.idle.add(callback);
  return () => state.idle.delete(callback);
}
export default { maximumNativePreparations, preparationCapacityBytes };
