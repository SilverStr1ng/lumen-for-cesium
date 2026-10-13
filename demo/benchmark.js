// Asynchronous diagnostic timers. rAF wakes polling and requests rendering;
// only actual postRender events contribute frame and sampling counts.
export async function measureFrames(
  scene,
  frames = 150,
  { warmup = 20, requireFG = false } = {},
) {
  const intervals = [],
    gpu = [],
    pending = [];
  const gl = scene.context._gl,
    ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const timestamps = !!(
    ext && gl.getQuery(ext.TIMESTAMP_EXT, ext.QUERY_COUNTER_BITS_EXT) > 0
  );
  let previous,
    active,
    disjoint = 0,
    rendered = 0,
    fgFrames = 0,
    raf = 0,
    excluded = 0,
    missing = 0;
  const remove = (q) => q.queries.forEach((x) => gl.deleteQuery(x));
  const poll = () => {
    if (!ext || Cesium.LumenGpuTimer.poll(scene.context, ext)) return;
    while (
      pending.length &&
      gl.getQueryParameter(pending[0].queries.at(-1), gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = pending.shift(),
        end = gl.getQueryParameter(q.queries.at(-1), gl.QUERY_RESULT);
      if (q.include)
        gpu.push(
          (timestamps
            ? end - gl.getQueryParameter(q.queries[0], gl.QUERY_RESULT)
            : end) / 1e6,
        );
      remove(q);
    }
  };
  const before = () => {
    if (rendered >= frames) return;
    active = { queries: [], fgBefore: scene.lumen.finalGather.metrics.frames };
    if (!ext) return;
    if (timestamps) {
      active.queries = [gl.createQuery(), gl.createQuery()];
      ext.queryCounterEXT(active.queries[0], ext.TIMESTAMP_EXT);
    } else if (!gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
      active.queries = [gl.createQuery()];
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active.queries[0]);
    }
  };
  const after = () => {
    if (!active) return;
    rendered++;
    const executed = scene.lumen.finalGather.metrics.frames - active.fgBefore;
    fgFrames += executed;
    const t = performance.now(),
      eligible = !requireFG || executed === 1;
    if (previous !== undefined && rendered > warmup && eligible)
      intervals.push(t - previous);
    previous = t;
    active.include = rendered > warmup && eligible;
    if (!eligible) excluded++;
    if (active.queries.length) {
      if (timestamps) ext.queryCounterEXT(active.queries[1], ext.TIMESTAMP_EXT);
      else gl.endQuery(ext.TIME_ELAPSED_EXT);
      if (active.invalid) remove(active);
      else pending.push(active);
    } else missing++;
    active = undefined;
  };
  const unregister = Cesium.LumenGpuTimer.register(scene.context, () => {
    disjoint++;
    pending.forEach(remove);
    pending.length = 0;
    gpu.length = 0;
    if (active) active.invalid = true;
  });
  scene.preRender.addEventListener(before);
  scene.postRender.addEventListener(after);
  const started = performance.now();
  try {
    while (rendered < frames) {
      await new Promise(requestAnimationFrame);
      raf++;
      poll();
      scene.requestRender();
      if (performance.now() - started > 30000)
        throw Error("actual render timer window timeout");
    }
    scene.preRender.removeEventListener(before);
    scene.postRender.removeEventListener(after);
    for (let i = 0; pending.length && i < 120; i++) {
      await new Promise(requestAnimationFrame);
      poll();
    }
  } finally {
    unregister();
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
    fps: frame.mean ? 1000 / frame.mean : null,
    frameMilliseconds: frame,
    gpuMilliseconds: stats(gpu),
    gpuScope: timestamps
      ? "complete rendered frame timestamps"
      : "complete rendered frame elapsed query; separate from FG component window",
    disjoint,
    renderedFrames: rendered,
    actualFGFrames: fgFrames,
    rafPolls: raf,
    excludedFallbackFrames: excluded,
    missingQueries: missing,
    incompleteQueries: pending.length,
    warmup,
    visibility: document.visibilityState,
    buffer: [scene.drawingBufferWidth, scene.drawingBufferHeight],
    gbuffer: scene.gBuffer.enabled,
  };
}
