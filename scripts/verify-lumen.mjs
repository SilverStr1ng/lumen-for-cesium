import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const report = {
  model: "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf",
  tests: [],
};
function check(name, predicate, detail) {
  assert.ok(predicate, `${name}: ${JSON.stringify(detail)}`);
  report.tests.push({ name, passed: true, detail });
  console.log("PASS", name, JSON.stringify(detail ?? ""));
}
try {
  await page.goto("http://localhost:8090/demo/index.html?backend=constant", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      (window.lumenDemo?.ready &&
        window.lumenDemo.scene.gBuffer.drawCommands > 0) ||
      window.lumenDemo?.errors.length,
    null,
    { timeout: 90000 },
  );
  assert.deepEqual(
    await page.evaluate(() => lumenDemo.errors),
    [],
    "Rendering must be error-free before data tests",
  );
  await page.evaluate(() => {
    const d = window.lumenDemo;
    d.widget.useDefaultRenderLoop = false;
    // Renderer tests intentionally read back GPU data. Production rendering never does.
    window.verify = {
      render() {
        d.widget.resize();
        d.widget.render();
        d.widget.render();
      },
      read(attachment = 0, framebuffer = d.scene.gBuffer.framebuffer) {
        const gl = d.scene.context._gl;
        const old = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer._framebuffer);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
        const w = d.scene.drawingBufferWidth,
          h = d.scene.drawingBufferHeight;
        const data = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data);
        const error = gl.getError();
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old);
        if (error) throw new Error(`GPU readPixels error ${error}`);
        return data;
      },
      hash(data) {
        const bytes = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        let hash = 2166136261;
        for (let i = 0; i < bytes.length; i++)
          hash = Math.imul(hash ^ bytes[i], 16777619);
        return hash >>> 0;
      },
      image() {
        return d.scene.context.readPixels();
      },
      count() {
        const data = this.read();
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0.5) count++;
        return count;
      },
      statistics() {
        const a = this.read(0),
          n = this.read(1),
          p = this.read(2),
          e = this.read(3);
        let valid = 0,
          maxNormalError = 0,
          maxProjectionError = 0,
          minDepth = Infinity,
          maxDepth = 0;
        const projection = d.scene.camera.frustum.projectionMatrix;
        const buffers = [a, n, p, e];
        if (!this.baseline) this.baseline = buffers;
        const difference = buffers.map((data, k) => {
          let max = 0;
          for (let i = 0; i < data.length; i++)
            max = Math.max(max, Math.abs(data[i] - this.baseline[k][i]));
          return max;
        });
        const w = d.scene.drawingBufferWidth,
          h = d.scene.drawingBufferHeight;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i + 3] < 0.5) continue;
          valid++;
          if (
            ![
              ...a.subarray(i, i + 4),
              ...n.subarray(i, i + 4),
              ...p.subarray(i, i + 4),
              ...e.subarray(i, i + 4),
            ].every(Number.isFinite)
          )
            throw new Error("Non-finite material data");
          maxNormalError = Math.max(
            maxNormalError,
            Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1),
          );
          minDepth = Math.min(minDepth, p[i + 3]);
          maxDepth = Math.max(maxDepth, p[i + 3]);
          if (valid % 47 === 0) {
            const v = Cesium.Matrix4.multiplyByVector(
              projection,
              new Cesium.Cartesian4(p[i], p[i + 1], p[i + 2], 1),
              new Cesium.Cartesian4(),
            );
            const x = ((i / 4) % w) + 0.5,
              y = Math.floor(i / 4 / w) + 0.5;
            maxProjectionError = Math.max(
              maxProjectionError,
              Math.hypot(
                ((v.x / v.w) * 0.5 + 0.5) * w - x,
                ((v.y / v.w) * 0.5 + 0.5) * h - y,
              ),
            );
          }
        }
        return {
          valid,
          maxNormalError,
          maxProjectionError,
          minDepth,
          maxDepth,
          hashes: buffers.map((data) => this.hash(data)),
          difference,
          frustums: d.scene.gBuffer.frustums,
        };
      },
    };
    window.verify.render();
  });
  report.renderer = await page.evaluate(() => {
    const gl = lumenDemo.scene.context._gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable";
  });
  const base = await page.evaluate(() => verify.statistics());
  check(
    "Sponza material MRT, finite positions and unit shading normals",
    base.valid > 1000 && base.maxNormalError < 0.001 && base.minDepth > 0,
    base,
  );
  check(
    "Eye-space position projects back to its pixel with log depth",
    base.maxProjectionError < 0.05,
    base.maxProjectionError,
  );
  const sunlight = await page.evaluate(() => {
    lumenDemo.sun(220);
    verify.render();
    return verify.statistics();
  });
  check(
    "Material inputs unchanged by solar direction",
    sunlight.difference.every((v) => v < 1e-5),
    sunlight.difference,
  );
  const exposure = await page.evaluate(() => {
    lumenDemo.scene.postProcessStages.exposure = 2.5;
    verify.render();
    return verify.statistics();
  });
  check(
    "Material inputs unchanged by exposure",
    exposure.difference.every((v) => v < 1e-5),
    exposure.difference,
  );
  const indirect = await page.evaluate(() => {
    const s = lumenDemo.scene;
    s.lumen.debugMode = 2;
    s.shadowMap.enabled = true;
    verify.render();
    const withShadow = verify.hash(verify.image());
    s.shadowMap.enabled = false;
    verify.render();
    return { withShadow, withoutShadow: verify.hash(verify.image()) };
  });
  check(
    "Solar shadow does not attenuate indirect diffuse",
    indirect.withShadow === indirect.withoutShadow,
    indirect,
  );
  const radiometry = await page.evaluate(() => {
    const s = lumenDemo.scene;
    const a = verify.read(0);
    const f = s._view.sceneFramebuffer._colorFramebuffer;
    const linear = verify.read(0, f.framebuffer);
    let maxError = 0,
      count = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 0.5) continue;
      count++;
      for (let k = 0; k < 3; k++)
        maxError = Math.max(
          maxError,
          Math.abs(linear[i + k] - (a[i + k] * 0.5) / Math.PI),
        );
    }
    return { count, maxError };
  });
  check(
    "Indirect diffuse equals reflectance times E/pi in the HDR framebuffer",
    radiometry.count > 1000 && radiometry.maxError < 0.001,
    radiometry,
  );
  const direct = await page.evaluate(() => {
    const s = lumenDemo.scene;
    s.lumen.debugMode = 1;
    s.shadowMap.enabled = true;
    verify.render();
    const withShadow = verify.image();
    s.shadowMap.enabled = false;
    verify.render();
    const withoutShadow = verify.image();
    let changed = 0,
      darker = 0;
    for (let i = 0; i < withShadow.length; i += 4) {
      const a = withShadow[i] + withShadow[i + 1] + withShadow[i + 2],
        b = withoutShadow[i] + withoutShadow[i + 1] + withoutShadow[i + 2];
      if (Math.abs(a - b) > 3) changed++;
      if (a + 3 < b) darker++;
    }
    const f = s.frameState,
      m = lumenDemo.model;
    return {
      changed,
      darker,
      enabled: f.shadowState.shadowsEnabled,
      lightMaps: f.shadowState.lightShadowMaps.length,
      receives: f.commandList.filter((c) => c.receiveShadows).length,
      modelShadows: m.shadows,
      directHash: verify.hash(withShadow),
    };
  });
  check(
    "Direct lighting responds to solar shadow",
    direct.changed > 100 && direct.darker > 100,
    direct,
  );
  const multi = await page.evaluate(() => {
    const s = lumenDemo.scene;
    s.lumen.debugMode = 0;
    s.shadowMap.enabled = true;
    s.logarithmicDepthBuffer = false;
    s.farToNearRatio = 2;
    verify.render();
    return verify.statistics();
  });
  check(
    "Multiple frustums retain pixel-correct eye positions",
    multi.frustums > 1 &&
      multi.maxProjectionError < 0.05 &&
      multi.maxNormalError < 0.001,
    multi,
  );
  const clip = await page.evaluate(() => {
    const m = lumenDemo.model;
    const before = verify.hash(verify.read(2));
    m.clippingPlanes = new Cesium.ClippingPlaneCollection({
      planes: [new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_X, 0)],
    });
    verify.render();
    const partial = verify.hash(verify.read(2));
    m.clippingPlanes.get(0).distance = -1e7;
    verify.render();
    const count = verify.count();
    m.clippingPlanes = undefined;
    verify.render();
    return { before, partial, clipped: count, restored: verify.count() };
  });
  check(
    "Clipping applies to both the model and material inputs",
    clip.before !== clip.partial && clip.clipped === 0 && clip.restored > 1000,
    clip,
  );
  const hidden = await page.evaluate(() => {
    lumenDemo.model.show = false;
    verify.render();
    const count = verify.count();
    lumenDemo.model.show = true;
    verify.render();
    return count;
  });
  check("Hidden model leaves no stale material inputs", hidden === 0, hidden);
  const disabled = await page.evaluate(() => {
    const g = lumenDemo.scene.gBuffer,
      texture = g.albedoTexture;
    g.enabled = false;
    verify.render();
    const released =
      texture.isDestroyed() && !g.framebuffer && g.memoryBytes === 0;
    g.enabled = true;
    verify.render();
    return { released, ready: g.status === "ready", count: verify.count() };
  });
  check(
    "Disable frees attachments and re-enable rebuilds them",
    disabled.released && disabled.ready && disabled.count > 1000,
    disabled,
  );
  await page.setViewportSize({ width: 1120, height: 720 });
  const resize = await page.evaluate(() => {
    verify.render();
    const s = lumenDemo.scene;
    return {
      width: s.gBuffer.albedoTexture.width,
      height: s.gBuffer.albedoTexture.height,
      bytes: s.gBuffer.memoryBytes,
    };
  });
  check(
    "Resize recreates attachments and accounts for memory",
    resize.width === 1120 &&
      resize.height === 720 &&
      resize.bytes === 1120 * 720 * 68,
    resize,
  );
  const budget = await page.evaluate(() => {
    const g = lumenDemo.scene.gBuffer;
    g.maximumMemoryBytes = 1;
    verify.render();
    const rejected =
      g.status === "memory budget exceeded" && g.memoryBytes === 0;
    g.maximumMemoryBytes = 256 * 1048576;
    verify.render();
    return rejected && g.status === "ready";
  });
  check("Memory budget rejects allocations and recovers", budget);
  await page.evaluate(() => {
    const s = lumenDemo.scene;
    s.logarithmicDepthBuffer = true;
    s.lumen.debugMode = 0;
    s.postProcessStages.exposure = 1;
    lumenDemo.sun(40);
    verify.render();
  });
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(
      new URL("../artifacts/sponza-courtyard.png", import.meta.url),
    ),
  });
  const destroyed = await page.evaluate(() => {
    const s = lumenDemo.scene,
      g = s.gBuffer,
      l = s.lumen,
      t = g.albedoTexture;
    lumenDemo.widget.destroy();
    return t.isDestroyed() && g.isDestroyed() && l.isDestroyed();
  });
  check("Scene destruction releases Lumen and GBuffer", destroyed);
  check("No browser rendering errors", errors.length === 0, errors);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../artifacts/verification.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
