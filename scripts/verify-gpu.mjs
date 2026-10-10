import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../cesium-1.146/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const executablePath = [
  process.env.LUMEN_CHROME,
  chromium.executablePath(),
  "C:/Users/rakuy/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
const browser = await chromium.launch({
  executablePath,
  headless: process.env.LUMEN_HEADFUL !== "1",
});
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const report = {
    tests: [],
    configuration: {
      spacing: 2,
      rays: 128,
      bounces: 3,
      viewport: [960, 640],
      gpuBudgetMs: 3,
    },
  },
  errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 1000));
});
function check(name, ok, detail) {
  report.tests.push({ name, passed: !!ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(detail));
  assert.ok(ok, name);
}
await mkdir("artifacts", { recursive: true });
try {
  const start = Date.now();
  await page.goto("http://localhost:8090/demo/index.html?backend=gpu");
  await page.waitForFunction(
    () =>
      window.lumenDemo?.scene.lumen.world?.ready ||
      window.lumenDemo?.errors.length,
    null,
    { timeout: 180000 },
  );
  check(
    "GPU startup without render/context errors",
    (await page.evaluate(() => lumenDemo.errors)).length === 0,
    await page.evaluate(() => lumenDemo.errors),
  );
  report.startupMilliseconds = Date.now() - start;
  await page.evaluate(async () => {
    const { ProbeField } = await import("/lumen/ddgi.js");
    const { measureFrames } = await import("/demo/benchmark.js");
    window.qa = {
      read(
        fb,
        attachment = 0,
        width = lumenDemo.scene.drawingBufferWidth,
        height = lumenDemo.scene.drawingBufferHeight,
      ) {
        return lumenDemo.scene.lumen.world._read(fb, width, height, attachment);
      },
      render() {
        lumenDemo.widget.resize();
        lumenDemo.widget.render();
        lumenDemo.widget.render();
      },
      hdr() {
        return this.read(
          lumenDemo.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
        );
      },
      async solve(options) {
        const result = await lumenDemo.scene.lumen.world.solve(options);
        this.render();
        return result;
      },
      field() {
        const s = lumenDemo.scene.lumen.world.snapshot();
        return new ProbeField(s.grid, s.positions, s.irradiance, s.moments);
      },
      fps: (frames = 150) => measureFrames(lumenDemo.scene, frames),
      points() {
        const d = lumenDemo,
          C = Cesium,
          g = d.scene.gBuffer;
        g.enabled = true;
        this.render();
        const a = this.read(g.framebuffer),
          n = this.read(g.framebuffer, 1),
          p = this.read(g.framebuffer, 2),
          points = [];
        for (let y = 8; y < d.scene.drawingBufferHeight; y += 16)
          for (let x = 320; x < d.scene.drawingBufferWidth; x += 16) {
            const o = (y * d.scene.drawingBufferWidth + x) * 4;
            if (a[o + 3] < 0.5) continue;
            const pos = C.Matrix4.multiplyByPoint(
              d.scene.lumen.world.eyeToLocal,
              C.Cartesian3.fromArray(p, o),
              new C.Cartesian3(),
            );
            const normal = C.Cartesian3.normalize(
              C.Matrix4.multiplyByPointAsVector(
                d.scene.lumen.world.eyeToLocal,
                C.Cartesian3.fromArray(n, o),
                new C.Cartesian3(),
              ),
              new C.Cartesian3(),
            );
            points.push({
              position: [pos.x, pos.y, pos.z],
              normal: [normal.x, normal.y, normal.z],
              albedo: Array.from(a.subarray(o, o + 3)),
              offset: o,
              x,
              y,
            });
          }
        return points;
      },
    };
  });
  report.renderer = await page.evaluate(() => {
    const gl = lumenDemo.scene.context._gl,
      e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  const initial = await page.evaluate(() => {
    const w = lumenDemo.scene.lumen.world,
      s = w.snapshot(),
      h = w._read(w._hitFB, s.grid.rays, s.grid.total);
    let active = 0,
      unknown = 0,
      hit = 0,
      miss = 0;
    for (let i = 3; i < s.positions.length; i += 4)
      if (s.positions[i] > 0.5) active++;
    for (let i = 0; i < h.length; i += 4) {
      if (h[i] === -1) unknown++;
      else if (h[i] === 0) miss++;
      else hit++;
    }
    return {
      grid: w.packet.grid,
      bvh: w.packet.bvh,
      active,
      unknown,
      hit,
      miss,
      bytes: w.memoryBytes,
      metrics: w.metrics,
    };
  });
  report.initial = initial;
  check(
    "Full Sponza GPU BVH and relocated valid DDGI probes",
    initial.bvh.triangles === 262266 &&
      initial.active > 1000 &&
      initial.unknown === 0,
    { ...initial, metrics: undefined },
  );
  await page.screenshot({ path: "artifacts/sponza-gpu-final.png" });
  report.performance = {};
  await page.evaluate(() => {
    lumenDemo.scene.lumen.enabled = false;
  });
  report.performance.giDisabled = await page.evaluate(() => qa.fps());
  console.log(
    "PERFORMANCE GI disabled",
    JSON.stringify(report.performance.giDisabled),
  );
  await page.evaluate(() => {
    lumenDemo.scene.lumen.enabled = true;
  });
  report.performance.giStatic = await page.evaluate(() => qa.fps());
  console.log(
    "PERFORMANCE GI static",
    JSON.stringify(report.performance.giStatic),
  );
  // Continuous control changes are coalesced between complete generations, rather than restarting forever.
  report.performance.giChanging = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world;
    window.lightChanges = 0;
    const t = setInterval(() => {
      lightChanges++;
      w.solve({
        sunDirection: [
          Math.cos(lightChanges * 0.13),
          Math.sin(lightChanges * 0.13),
          0.65,
        ],
        skyRadiance: [0.15, 0.18, 0.25],
      }).catch(() => {});
    }, 200);
    const result = await qa.fps(240);
    clearInterval(t);
    await w.completed;
    return { ...result, lightChanges, updates: w.metrics.updates };
  });
  await page.evaluate(() => {
    lumenDemo.scene.shadowMap.size = 1024;
  });
  report.performance.giShadow1024 = await page.evaluate(() => qa.fps(100));
  console.log(
    "PERFORMANCE shadow 1024",
    JSON.stringify(report.performance.giShadow1024),
  );
  await page.evaluate(() => {
    lumenDemo.widget.resolutionScale = 0.5;
  });
  report.performance.giHalfResolution = await page.evaluate(() => qa.fps(100));
  console.log(
    "PERFORMANCE half resolution",
    JSON.stringify(report.performance.giHalfResolution),
  );
  await page.evaluate(() => {
    lumenDemo.widget.resolutionScale = 1;
    lumenDemo.scene.shadowMap.size = 2048;
    qa.render();
  });
  check(
    "Measured visible nonzero viewport and frames during GPU relighting",
    Object.values(report.performance).every(
      (p) =>
        p.visibility === "visible" &&
        p.buffer[0] > 0 &&
        p.buffer[1] > 0 &&
        p.frameMilliseconds.samples > 50 &&
        Number.isFinite(p.fps),
    ),
    report.performance,
  );
  await page.evaluate(() => {
    lumenDemo.scene.lumen.debugMode = 2;
    document.getElementById("mode").value = "indirect";
    window.receivers = qa.points();
  });
  const align = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      rays = receivers
        .filter((_, i) => i % 4 === 0)
        .map((p) => ({
          origin: p.position.map((v, k) => v + p.normal[k] * 0.05),
          direction: p.normal.map((v) => -v),
          maxDistance: 0.1,
        }));
    // Add independent world-space rays through the whole volume, including masked foliage.
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 400; i++) {
      const d = [random() - 0.5, random() - 0.5, random() - 0.5],
        len = Math.hypot(...d);
      rays.push({
        origin: [random() * 30 - 15, random() * 18 - 9, random() * 12],
        direction: d.map((v) => v / len),
        maxDistance: 100,
      });
    }
    const a = await w.trace(rays),
      b = await w.referenceTrace(rays);
    let matches = 0,
      maxDistanceError = 0,
      unknown = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i].status === "Unknown") unknown++;
      if (
        a[i].status === b[i].status &&
        (a[i].status !== "Hit" ||
          Math.abs(a[i].distance - b[i].distance) < 0.003)
      )
        matches++;
      if (a[i].status === "Hit" && b[i].status === "Hit")
        maxDistanceError = Math.max(
          maxDistanceError,
          Math.abs(a[i].distance - b[i].distance),
        );
    }
    const budget = w.options.traversalBudget;
    w.options.traversalBudget = 1;
    const exhausted = await w.trace([
      { origin: [0, 0, 2], direction: [0, 0, -1] },
    ]);
    w.options.traversalBudget = budget;
    return {
      rays: rays.length,
      matches,
      unknown,
      maxDistanceError,
      exhausted: exhausted[0],
    };
  });
  check(
    "GPU closest hits match CPU BVH and exhaustion remains Unknown",
    align.matches / align.rays > 0.99 &&
      align.unknown === 0 &&
      align.exhausted.status === "Unknown",
    align,
  );
  const agreement = await page.evaluate(async () => {
    qa.render();
    const w = lumenDemo.scene.lumen.world,
      gpu = await w.sample(receivers),
      cpu = qa.field(),
      hdr = qa.hdr();
    let gatherMax = 0,
      max = 0,
      average = 0,
      lit = 0;
    for (let i = 0; i < receivers.length; i++) {
      const p = receivers[i],
        s = gpu[i],
        reference = cpu.sample(p.position, p.normal);
      for (let c = 0; c < 3; c++) {
        gatherMax = Math.max(
          gatherMax,
          Math.abs(s.irradiance[c] - reference.irradiance[c]),
        );
        const expected = (p.albedo[c] * s.irradiance[c] * s.coverage) / Math.PI,
          error = Math.abs(hdr[p.offset + c] - expected);
        max = Math.max(max, error);
        average += error;
        if (expected > 0.0001) lit++;
      }
    }
    return { gatherMax, max, average: average / (receivers.length * 3), lit };
  });
  check(
    "GPU DDGI gather and material HDR agree with independent CPU sampling",
    agreement.gatherMax < 0.001 &&
      agreement.max < 0.001 &&
      agreement.average < 0.00005 &&
      agreement.lit > 100,
    agreement,
  );
  report.lightResponse = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world;
    await qa.solve({
      sunDirection: [1, 0, 0.65],
      sunRadiance: [2, 2, 2],
      skyRadiance: [0.1, 0.1, 0.1],
      bounces: 3,
    });
    const a = await w.sample(receivers);
    const previous = w.irradianceTexture,
      old = Array.from(qa.field().irradiance),
      started = performance.now(),
      promise = w.solve({ sunDirection: [-1, 0, 0.65] });
    const retained = w.ready && w.irradianceTexture === previous;
    await promise;
    qa.render();
    const b = await w.sample(receivers);
    let changed = 0,
      max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.max(
        ...a[i].irradiance.map((v, c) => Math.abs(v - b[i].irradiance[c])),
      );
      if (d > 1e-4) changed++;
      max = Math.max(max, d);
    }
    const next = qa.field().irradiance;
    return {
      retained,
      milliseconds: performance.now() - started,
      changed,
      max,
      atlasChanged: old.some((v, i) => v !== next[i]),
    };
  });
  check(
    "Sun direction changes GPU GI while retaining the last complete field",
    report.lightResponse.retained &&
      report.lightResponse.changed > 10 &&
      report.lightResponse.atlasChanged,
    report.lightResponse,
  );
  await page.evaluate(async () => {
    await qa.solve({
      sunRadiance: [0, 0, 0],
      skyRadiance: [0.4, 0.4, 0.4],
      neutralMaterials: [],
      bounces: 3,
    });
    window.coloured = await lumenDemo.scene.lumen.world.sample(receivers);
    window.colouredHDR = qa.hdr();
    window.redSurfaces = await lumenDemo.scene.lumen.world.surfaces([16, 18]);
  });
  await page.screenshot({ path: "artifacts/sponza-gpu-colored.png" });
  await page.evaluate(async () => {
    document.getElementById("neutral").checked = true;
    await qa.solve({ neutralMaterials: [16, 18] });
    window.neutral = await lumenDemo.scene.lumen.world.sample(receivers);
    window.neutralHDR = qa.hdr();
  });
  await page.screenshot({ path: "artifacts/sponza-gpu-neutral.png" });
  const colour = await page.evaluate(() => {
    const candidates = [];
    receivers.forEach((p, i) => {
      const a = coloured[i],
        b = neutral[i],
        delta = a.irradiance.map((v, c) => v - b.irradiance[c]),
        chroma = delta[0] - delta[1];
      if (
        p.normal[2] > 0.95 &&
        Math.max(...p.albedo) / Math.max(0.00001, Math.min(...p.albedo)) < 2 &&
        a.coverage > 0.2 &&
        chroma > 0
      )
        candidates.push({
          ...p,
          index: i,
          delta,
          chroma,
          coloured: a,
          neutral: b,
          gpuDelta: [0, 1, 2].map(
            (c) => colouredHDR[p.offset + c] - neutralHDR[p.offset + c],
          ),
        });
    });
    candidates.sort((a, b) => b.chroma - a.chroma);
    window.receiver = candidates[0];
    return {
      affected: candidates.filter((p) => p.chroma > 1e-6).length,
      receiver,
    };
  });
  check(
    "Actual red curtain materials cause red bounce on neutral Sponza floors",
    colour.affected > 10 &&
      colour.receiver.chroma > 1e-5 &&
      colour.receiver.gpuDelta[0] > 0 &&
      colour.receiver.gpuDelta[1] < 0,
    colour,
  );
  report.offscreen = await page.evaluate(async () => {
    const d = lumenDemo,
      C = Cesium,
      p = receiver.position,
      rot = C.Matrix4.getMatrix3(d.frame, new C.Matrix3());
    d.scene.camera.frustum.fov = C.Math.toRadians(15);
    d.scene.camera.setView({
      destination: C.Matrix4.multiplyByPoint(
        d.frame,
        new C.Cartesian3(p[0], p[1], p[2] + 1.5),
        new C.Cartesian3(),
      ),
      orientation: {
        direction: C.Matrix3.multiplyByVector(
          rot,
          new C.Cartesian3(0, 0, -1),
          new C.Cartesian3(),
        ),
        up: C.Matrix3.multiplyByVector(
          rot,
          new C.Cartesian3(1, 0, 0),
          new C.Cartesian3(),
        ),
      },
    });
    qa.render();
    const matrix = C.Matrix4.multiply(
      d.scene.camera.frustum.projectionMatrix,
      d.scene.camera.viewMatrix,
      new C.Matrix4(),
    );
    let visible = 0;
    for (const s of redSurfaces) {
      const clip = [0, 1, 2].map((i) => {
        const world = C.Matrix4.multiplyByPoint(
          d.frame,
          C.Cartesian3.fromArray(s.vertices, i * 3),
          new C.Cartesian3(),
        );
        return C.Matrix4.multiplyByVector(
          matrix,
          new C.Cartesian4(world.x, world.y, world.z, 1),
          new C.Cartesian4(),
        );
      });
      const rejected = [
        (v) => v.x + v.w,
        (v) => v.w - v.x,
        (v) => v.y + v.w,
        (v) => v.w - v.y,
        (v) => v.z + v.w,
        (v) => v.w - v.z,
      ].some((plane) => clip.every((v) => plane(v) < 0));
      if (!rejected) visible++;
    }
    const held = (await d.scene.lumen.world.sample([receiver]))[0];
    await qa.solve({ neutralMaterials: [] });
    const a = (await d.scene.lumen.world.sample([receiver]))[0],
      hdrA = qa.hdr();
    await qa.solve({ neutralMaterials: [16, 18] });
    const b = (await d.scene.lumen.world.sample([receiver]))[0],
      hdrB = qa.hdr();
    const o =
      (Math.floor(d.scene.drawingBufferHeight / 2) *
        d.scene.drawingBufferWidth +
        Math.floor(d.scene.drawingBufferWidth / 2)) *
      4;
    return {
      visibleRedTriangles: visible,
      totalRedTriangles: redSurfaces.length,
      heldDifference: Math.max(
        ...held.irradiance.map((v, c) =>
          Math.abs(v - receiver.neutral.irradiance[c]),
        ),
      ),
      cameraInvariantDifference: Math.max(
        ...a.irradiance.map((v, c) =>
          Math.abs(v - receiver.coloured.irradiance[c]),
        ),
      ),
      delta: a.irradiance.map((v, c) => v - b.irradiance[c]),
      gpuDelta: [0, 1, 2].map((c) => hdrA[o + c] - hdrB[o + c]),
    };
  });
  check(
    "Fresh GPU relights preserve red bounce with all source curtains outside the view",
    report.offscreen.visibleRedTriangles === 0 &&
      report.offscreen.totalRedTriangles > 100 &&
      report.offscreen.heldDifference < 1e-6 &&
      report.offscreen.cameraInvariantDifference < 1e-6 &&
      report.offscreen.delta[0] > 1e-5 &&
      report.offscreen.gpuDelta[0] > 0 &&
      report.offscreen.gpuDelta[1] < 0,
    report.offscreen,
  );
  await page.evaluate(async () => {
    document.getElementById("neutral").checked = false;
    await qa.solve({ neutralMaterials: [] });
  });
  await page.screenshot({ path: "artifacts/sponza-gpu-offscreen.png" });
  const latest = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      texture = w.irradianceTexture;
    const a = w.solve({
      skyRadiance: [2, 2, 2],
      sunRadiance: [8, 8, 8],
      bounces: 4,
    });
    const b = w.solve({
      skyRadiance: [0, 0, 0],
      sunRadiance: [0, 0, 0],
      bounces: 1,
    });
    let rejected = false;
    try {
      await a;
    } catch (e) {
      rejected = String(e).includes("superseded");
    }
    await b;
    const s = w.snapshot();
    let max = 0;
    for (let i = 0; i < s.irradiance.length; i += 4)
      for (let c = 0; c < 3; c++) max = Math.max(max, s.irradiance[i + c]);
    return {
      rejected,
      revision: w.revision,
      published: w.packet.revision,
      max,
      oldStillAllocated: !texture.isDestroyed(),
      memory: w.memoryBytes,
      readbacks: w.metrics.productionReadbacks,
      disjoint: w.metrics.disjoint,
    };
  });
  check(
    "Latest GPU revision wins and zero lights eliminate GI",
    latest.rejected &&
      latest.revision === latest.published &&
      latest.max === 0 &&
      latest.readbacks === 0 &&
      latest.disjoint === 0,
    latest,
  );
  report.finalMetrics = await page.evaluate(
    () => lumenDemo.scene.lumen.world.metrics,
  );
  const release = await page.evaluate(() => {
    const w = lumenDemo.scene.lumen.world,
      t = w.irradianceTexture;
    lumenDemo.widget.destroy();
    return {
      destroyed: t.isDestroyed(),
      bytes: w.memoryBytes,
      status: w.status,
    };
  });
  check(
    "Destroy releases GPU resources and worker",
    release.destroyed && release.bytes === 0 && release.status === "destroyed",
    release,
  );
  check("Real GPU run remains error free", errors.length === 0, errors);
} finally {
  await writeFile(
    "artifacts/gpu-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
