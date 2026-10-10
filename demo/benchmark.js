// Diagnostics only. Timestamp pairs let the world's TIME_ELAPSED queries remain active.
// If timestamps are unavailable, full-frame elapsed queries are limited to idle GI frames.
export async function measureFrames(scene, frames = 150) {
  const intervals = [],
    gpu = [],
    pending = [];
  const gl = scene.context._gl,
    ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const timestamps =
    ext && gl.getQuery(ext.TIMESTAMP_EXT, ext.QUERY_COUNTER_BITS_EXT) > 0;
  let previous,
    active,
    disjoint = 0;
  const before = () => {
    if (!ext) return;
    if (timestamps) {
      active = [gl.createQuery(), gl.createQuery()];
      ext.queryCounterEXT(active[0], ext.TIMESTAMP_EXT);
    } else if (
      scene.lumen.world?.status === "ready" &&
      !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)
    ) {
      active = [gl.createQuery()];
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active[0]);
    }
  };
  const after = () => {
    if (!active) return;
    if (timestamps) ext.queryCounterEXT(active[1], ext.TIMESTAMP_EXT);
    else gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(active);
    active = undefined;
  };
  const remove = (queries) => queries.forEach((q) => gl.deleteQuery(q));
  scene.preRender.addEventListener(before);
  scene.postRender.addEventListener(after);
  try {
    for (let i = 0; i < frames; i++) {
      const t = await new Promise(requestAnimationFrame);
      if (previous !== undefined && i > 20) intervals.push(t - previous);
      previous = t;
      if (ext && gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        disjoint++;
        pending.forEach(remove);
        pending.length = 0;
        gpu.length = 0;
      } else
        while (
          pending.length &&
          gl.getQueryParameter(pending[0].at(-1), gl.QUERY_RESULT_AVAILABLE)
        ) {
          const q = pending.shift(),
            end = gl.getQueryParameter(q.at(-1), gl.QUERY_RESULT);
          gpu.push(
            (timestamps
              ? end - gl.getQueryParameter(q[0], gl.QUERY_RESULT)
              : end) / 1e6,
          );
          remove(q);
        }
    }
  } finally {
    scene.preRender.removeEventListener(before);
    scene.postRender.removeEventListener(after);
    pending.forEach(remove);
  }
  const stats = (a) => {
    const b = [...a].sort((x, y) => x - y);
    return {
      mean: a.length ? a.reduce((x, y) => x + y, 0) / a.length : null,
      p50: b[Math.floor(b.length * 0.5)] ?? null,
      p95: b[Math.floor(b.length * 0.95)] ?? null,
      samples: a.length,
    };
  };
  const frame = stats(intervals);
  return {
    fps: 1000 / frame.mean,
    frameMilliseconds: frame,
    gpuMilliseconds: stats(gpu),
    gpuScope: timestamps ? "frame timestamps" : "idle frames only",
    disjoint,
    visibility: document.visibilityState,
    buffer: [scene.drawingBufferWidth, scene.drawingBufferHeight],
    gbuffer: scene.gBuffer.enabled,
  };
}
