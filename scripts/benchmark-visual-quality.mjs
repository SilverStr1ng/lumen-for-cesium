import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  environment,
  sourceVersion,
} from "./browser-tools.mjs";
const label = process.argv[2] ?? "after",
  out = "reports/ddgi-visual-quality-v4";
await mkdir(out, { recursive: true });
const report = {
  label,
  version: sourceVersion(["demo/globe.js", "fixtures/earth-pavilion.gltf"]),
  mode: "production, no synchronous readback",
  errors: [],
};
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(installGlObserver);
await page.addInitScript(() => {
  const glp = WebGL2RenderingContext.prototype,
    T = new Map(),
    R = new Map(),
    B = new Map(),
    bufferBindings = new Map(),
    bindings = new Map();
  let unit = 0,
    rb = null;
  const wrap = (name, callback) => {
    const original = glp[name];
    glp[name] = function (...a) {
      const result = original.apply(this, a);
      callback(this, a, result);
      return result;
    };
  };
  const size = (f, t) => {
    const internal = {
      34836: 16,
      34842: 8,
      32856: 4,
      6408: 4,
      6407: 3,
      33321: 1,
      33323: 2,
      33325: 2,
      33327: 4,
      33326: 4,
      33328: 8,
      33189: 2,
      33190: 3,
      36012: 4,
      35056: 4,
      36013: 8,
    };
    if (internal[f]) return internal[f];
    return 4;
  };
  wrap("activeTexture", (g, a) => (unit = a[0] - g.TEXTURE0));
  wrap("bindTexture", (g, a) => bindings.set(unit + ":" + a[0], a[1]));
  const texture = (g, target) =>
    bindings.get(
      unit +
        ":" +
        (target >= 34069 && target <= 34074 ? g.TEXTURE_CUBE_MAP : target),
    );
  const alloc = (t, key, bytes) => {
    if (!t) return;
    const map = T.get(t) ?? new Map();
    map.set(key, bytes);
    T.set(t, map);
  };
  wrap("texImage2D", (g, a) => {
    const image = a.length < 9 ? a.at(-1) : null,
      w = image?.width ?? image?.videoWidth ?? a[3],
      h = image?.height ?? image?.videoHeight ?? a[4];
    const type = a.length < 9 ? a[4] : a[7];
    const bpp =
      a[2] === 6408 || a[2] === 6407
        ? (a[2] === 6408 ? 4 : 3) * (type === 5126 ? 4 : type === 5131 ? 2 : 1)
        : size(a[2], type);
    alloc(texture(g, a[0]), a[0] + ":" + a[1], w * h * bpp);
  });
  wrap("texStorage2D", (g, a) => {
    for (let l = 0; l < a[1]; l++)
      alloc(
        texture(g, a[0]),
        "storage:" + l,
        Math.max(1, a[3] >> l) *
          Math.max(1, a[4] >> l) *
          size(a[2]) *
          (a[0] === g.TEXTURE_CUBE_MAP ? 6 : 1),
      );
  });
  wrap("compressedTexImage2D", (g, a) =>
    alloc(texture(g, a[0]), a[0] + ":" + a[1], a[6]?.byteLength ?? a[6] ?? 0),
  );
  wrap("generateMipmap", (g, a) => {
    const t = texture(g, a[0]),
      m = T.get(t);
    if (m) {
      const base = [...m]
        .filter(([k]) => k.endsWith(":0"))
        .reduce((s, [k, v]) => s + v, 0);
      alloc(t, "generatedMips", base / 3);
    }
  });
  wrap("deleteTexture", (g, a) => T.delete(a[0]));
  wrap("bindRenderbuffer", (g, a) => (rb = a[1]));
  wrap("renderbufferStorage", (g, a) => R.set(rb, a[2] * a[3] * size(a[1])));
  wrap("renderbufferStorageMultisample", (g, a) =>
    R.set(rb, a[1] * a[3] * a[4] * size(a[2])),
  );
  wrap("deleteRenderbuffer", (g, a) => R.delete(a[0]));
  wrap("bindBuffer", (g, a) => bufferBindings.set(a[0], a[1]));
  wrap("bufferData", (g, a) => {
    const buffer = bufferBindings.get(a[0]);
    if (buffer)
      B.set(buffer, typeof a[1] === "number" ? a[1] : (a[1]?.byteLength ?? 0));
  });
  wrap("deleteBuffer", (g, a) => B.delete(a[0]));
  window.gpuAllocationEstimate = () => ({
    textureBytes: [...T.values()].reduce(
      (s, m) => s + [...m.values()].reduce((a, b) => a + b, 0),
      0,
    ),
    renderbufferBytes: [...R.values()].reduce((a, b) => a + b, 0),
    bufferBytes: [...B.values()].reduce((a, b) => a + b, 0),
    buffers: B.size,
    textures: T.size,
    renderbuffers: R.size,
    scope:
      "tracked GL texture/renderbuffer allocation estimate including Globe, HDR, shadows, IBL, MSAA and GI; excludes driver padding, browser canvas swapchain ; tracks geometry/other GL buffers when allocated through bufferData",
  });
});
page.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await page.goto(
    "http://localhost:8090/demo/globe.html" +
      (label === "presentation"
        ? "?preset=presentation"
        : label === "fine"
          ? "?quality=fine"
          : ""),
  );
  await page.waitForFunction(
    () =>
      window.earthLab?.world?.status === "ready" ||
      window.earthLab?.errors.length,
    null,
    { timeout: 180000 },
  );
  assert.deepEqual(await page.evaluate(() => earthLab.errors), []);
  report.environment = await environment(page, browser);
  report.result = await page.evaluate(async () => {
    const d = earthLab,
      w = d.world,
      { measureFrames } = await import("/demo/benchmark.js");
    const drain = async () => {
      for (let i = 0; i < 180 && w._queries.length; i++)
        await new Promise(requestAnimationFrame);
    };
    d.camera("boxFoot");
    await drain();
    for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
    glObserver.phase("performance");
    d.scene.lumen.enabled = false;
    const disabled = await measureFrames(d.scene, 100);
    d.scene.lumen.enabled = true;
    const idle = await measureFrames(d.scene, 100);
    const updateOptions = {
      sunDirection: [-0.766044443118978, 0.6427876096865393, 0.65],
    };
    const started = performance.now();
    const completed = w.solve(updateOptions);
    let first, final;
    const trackedCompletion = completed.then(() => {
      final = performance.now() - started;
    });
    w.firstPublished.then(() => (first = performance.now() - started));
    const times = [];
    let previous;
    for (let i = 0; i < 100; i++) {
      const t = await new Promise(requestAnimationFrame);
      if (previous !== undefined && i > 20) times.push(t - previous);
      previous = t;
    }
    await trackedCompletion;
    await drain();
    const sorted = [...times].sort((a, b) => a - b);
    return {
      quality: {
        spacing: w.spacing,
        rays: w.options.rays,
        bounces: w.options.bounces,
        budget: w.options.targetGpuMilliseconds,
        probes: w.packet.grid.total,
      },
      disabled,
      idle,
      updating: {
        fps: 1000 / (times.reduce((a, b) => a + b, 0) / times.length),
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        scope:
          "CPU rAF, includes settled frames; stage GPU times listed separately",
      },
      firstPublishedSubmissionMilliseconds: first,
      finalSubmissionMilliseconds: final,
      update: w.metrics.updates.at(-1),
      initialStages: w.metrics.initialStages,
      giBytes: w.memoryBytes,
      allocation: gpuAllocationEstimate(),
      ibl: {
        ready: !!d.model.environmentMapManager.radianceCubeMap,
        mipMaximum: d.model.environmentMapManager.maximumMipmapLevel,
        width: d.model.environmentMapManager.radianceCubeMap?.width,
      },
      gl: glObserver.snapshot(),
      preserveDrawingBuffer:
        d.scene.context._gl.getContextAttributes().preserveDrawingBuffer,
      gBuffer: d.scene.gBuffer.enabled,
      actualHdrMsaaSamples:
        d.scene._view.sceneFramebuffer._colorFramebuffer.numSamples,
    };
  });
  for (const s of report.result.gl) {
    for (const key of [
      "readPixels",
      "getBufferSubData",
      "finish",
      "waitSync",
      "blockingClientWaitSync",
      "queryCollisions",
    ])
      assert.equal(s.phases.performance?.[key] ?? 0, 0, key);
    assert.deepEqual(s.feedback, []);
    assert.deepEqual(s.errors, []);
  }
  assert.equal(report.result.preserveDrawingBuffer, false);
  assert.equal(report.result.gBuffer, false);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errors.push(e.stack ?? String(e));
  process.exitCode = 1;
} finally {
  await writeFile(
    out + "/performance-" + label + ".json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(
  JSON.stringify({
    status: report.status,
    errors: report.errors,
    quality: report.result?.quality,
    giBytes: report.result?.giBytes,
  }),
);
