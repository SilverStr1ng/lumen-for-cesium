import assert from "node:assert/strict";
import { demoUrl, sourceVersion } from "./browser-tools.mjs";
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
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } }),
  errors = [],
  report = { version: sourceVersion(["scripts/verify-world.mjs"]), tests: [] };
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 1200));
});
function check(name, condition, detail) {
  report.tests.push({ name, passed: Boolean(condition), detail });
  console.log(condition ? "PASS" : "FAIL", name, JSON.stringify(detail));
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
}
await mkdir("artifacts", { recursive: true });
async function ready() {
  await page.waitForFunction(
    () =>
      (lumenDemo.scene.lumen.world?.status === "ready" &&
        lumenDemo.scene.lumen.world?.ready) ||
      lumenDemo.errors.length,
    null,
    { timeout: 120000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenDemo.errors), []);
}
try {
  const started = Date.now();
  await page.goto(demoUrl("cpu"));
  await ready();
  report.initialMilliseconds = Date.now() - started;
  report.renderer = await page.evaluate(() => {
    const gl = lumenDemo.scene.context._gl,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable";
  });
  report.initial = await page.evaluate(() => {
    const w = lumenDemo.scene.lumen.world;
    return {
      grid: w.packet.grid,
      active: w.packet.active,
      bvh: w.packet.bvh,
      cache: w.packet.cache.surfels,
      history: w.packet.history,
    };
  });
  check(
    "Sponza full static geometry and converged probes",
    report.initial.bvh.triangles === 262266 &&
      report.initial.active > 1000 &&
      report.initial.history.length === 3,
    report.initial,
  );
  check(
    "Snapshot bounces converge without uncontrolled energy growth",
    report.initial.history[1].energy > report.initial.history[0].energy &&
      report.initial.history[2].energy - report.initial.history[1].energy <
        (report.initial.history[1].energy - report.initial.history[0].energy) *
          0.1,
    report.initial.history,
  );
  await page.evaluate(() => {
    const d = lumenDemo,
      C = Cesium;
    d.widget.useDefaultRenderLoop = false;
    window.qa = {
      render() {
        d.widget.resize();
        d.widget.render();
        d.widget.render();
      },
      read(
        framebuffer,
        attachment = 0,
        w = d.scene.drawingBufferWidth,
        h = d.scene.drawingBufferHeight,
      ) {
        const gl = d.scene.context._gl,
          old = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer._framebuffer);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
        const a = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, a);
        const error = gl.getError();
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old);
        if (error) throw new Error(`readPixels ${error}`);
        return a;
      },
      hdr() {
        return this.read(
          d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
        );
      },
      points() {
        this.render();
        const g = d.scene.gBuffer,
          a = this.read(g.framebuffer, 0),
          n = this.read(g.framebuffer, 1),
          p = this.read(g.framebuffer, 2),
          matrix = d.scene.lumen.world.eyeToLocal,
          points = [];
        for (let y = 8; y < d.scene.drawingBufferHeight; y += 16)
          for (let x = 320; x < d.scene.drawingBufferWidth; x += 16) {
            const offset = (y * d.scene.drawingBufferWidth + x) * 4;
            if (a[offset + 3] < 0.5) continue;
            const position = C.Matrix4.multiplyByPoint(
                matrix,
                C.Cartesian3.fromArray(p, offset),
                new C.Cartesian3(),
              ),
              normal = C.Matrix4.multiplyByPointAsVector(
                matrix,
                C.Cartesian3.fromArray(n, offset),
                new C.Cartesian3(),
              );
            points.push({
              position: [position.x, position.y, position.z],
              normal: [normal.x, normal.y, normal.z],
              albedo: Array.from(a.subarray(offset, offset + 3)),
              offset,
              x,
              y,
            });
          }
        return points;
      },
      async solve(options) {
        const w = d.scene.lumen.world;
        await w.solve(options);
        this.render();
      },
      hash(a) {
        let h = 2166136261;
        for (const v of new Uint8Array(a.buffer))
          h = Math.imul(h ^ v, 16777619);
        return h >>> 0;
      },
    };
    d.scene.lumen.debugMode = 2;
    document.getElementById("mode").value = "indirect";
    qa.render();
    window.receivers = qa.points();
  });
  const alignment = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      points = receivers.filter((_, i) => i % 4 === 0);
    const rays = points.map((p) => ({
      origin: p.position.map((v, i) => v + p.normal[i] * 0.05),
      direction: p.normal.map((v) => -v),
      maxDistance: 0.1,
    }));
    const hits = await w.trace(rays);
    return {
      rays: hits.length,
      matched: hits.filter(
        (h) => h.status === "Hit" && Math.abs(h.distance - 0.05) < 0.008,
      ).length,
      unknown: hits.filter((h) => h.status === "Unknown").length,
    };
  });
  check(
    "BVH aligns with actual rendered GBuffer in ENU metres",
    alignment.matched / alignment.rays > 0.95 && alignment.unknown === 0,
    alignment,
  );
  const unknown = await page.evaluate(async () =>
    lumenDemo.scene.lumen.world.trace([
      { origin: [0, 0, 2], direction: [0, 0, -1], budget: 1 },
    ]),
  );
  check(
    "Traversal exhaustion stays Unknown",
    unknown[0].status === "Unknown",
    unknown,
  );
  const agreement = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      field = await w.sample(receivers),
      hdr = qa.hdr();
    let max = 0,
      average = 0,
      count = 0,
      lit = 0;
    for (let i = 0; i < receivers.length; i++) {
      const p = receivers[i],
        s = field[i];
      for (let c = 0; c < 3; c++) {
        const expected = (p.albedo[c] * s.irradiance[c] * s.coverage) / Math.PI,
          error = Math.abs(hdr[p.offset + c] - expected);
        max = Math.max(max, error);
        average += error;
        count++;
        if (expected > 0.0001) lit++;
      }
    }
    return { max, average: average / count, lit, points: receivers.length };
  });
  check(
    "WebGL2 material output equals visibility-aware DDGI E times albedo / pi",
    agreement.max < 0.001 && agreement.average < 0.00005 && agreement.lit > 100,
    agreement,
  );
  const independent = await page.evaluate(() => {
    const d = lumenDemo,
      w = d.scene.lumen.world;
    const atlas = qa.hash(w.packet.irradiance);
    d.scene.shadowMap.enabled = true;
    qa.render();
    const withShadows = qa.hash(qa.hdr());
    d.scene.shadowMap.enabled = false;
    qa.render();
    const withoutShadows = qa.hash(qa.hdr());
    d.scene.postProcessStages.exposure = 2.5;
    qa.render();
    const exposure = qa.hash(qa.hdr());
    d.scene.postProcessStages.exposure = 1;
    d.scene.shadowMap.enabled = true;
    qa.render();
    return {
      atlasUnchanged: atlas === qa.hash(w.packet.irradiance),
      withShadows,
      withoutShadows,
      exposure,
    };
  });
  check(
    "DDGI HDR is independent of display exposure and direct-shadow toggles",
    independent.atlasUnchanged &&
      independent.withShadows === independent.withoutShadows &&
      independent.withShadows === independent.exposure,
    independent,
  );
  // White sky removes a coloured illuminant from the causal material comparison.
  await page.evaluate(async () => {
    document.querySelector(".tag").textContent =
      "VALIDATION / WHITE SKY · 3 BOUNCES";
    document.querySelector("aside p").textContent =
      "白色入射光下，GI 红幕布保留颜色与去色的因果对照。显示模型材质保持原样。";
    await qa.solve({ skyRadiance: [0.4, 0.4, 0.4], bounces: 3 });
    window.coloured = await lumenDemo.scene.lumen.world.sample(receivers);
    window.colouredHDR = qa.hdr();
    window.redSurfaces = await lumenDemo.scene.lumen.world.surfaces([16, 18]);
  });
  await page.screenshot({ path: "artifacts/sponza-color-bounce.png" });
  await page.evaluate(async () => {
    document.getElementById("neutral").checked = true;
    await qa.solve({ neutralMaterials: [16, 18] });
    window.neutral = await lumenDemo.scene.lumen.world.sample(receivers);
    window.neutralHDR = qa.hdr();
  });
  await page.screenshot({ path: "artifacts/sponza-neutral-curtains.png" });
  const colour = await page.evaluate(() => {
    const candidates = [];
    for (let i = 0; i < receivers.length; i++) {
      const p = receivers[i],
        a = coloured[i],
        b = neutral[i],
        delta = a.irradiance.map((v, k) => v - b.irradiance[k]);
      const chroma = delta[0] - delta[1],
        signal = chroma / Math.max(0.00001, a.irradiance[0]);
      if (
        p.normal[2] > 0.95 &&
        Math.max(...p.albedo) / Math.max(0.00001, Math.min(...p.albedo)) < 2 &&
        a.coverage > 0.2 &&
        chroma > 0
      )
        candidates.push({
          index: i,
          ...p,
          delta,
          signal,
          chroma,
          coloured: a,
          neutral: b,
          gpuDelta: [0, 1, 2].map(
            (k) => colouredHDR[p.offset + k] - neutralHDR[p.offset + k],
          ),
        });
    }
    candidates.sort((a, b) => b.chroma - a.chroma);
    window.receiver = candidates[0];
    return {
      receiver: candidates[0],
      affected: candidates.filter((p) => p.chroma > 1e-6).length,
    };
  });
  check(
    "Existing red Sponza curtains cause red bounce on a neutral floor",
    colour.affected > 10 &&
      colour.receiver?.chroma > 1e-5 &&
      colour.receiver?.gpuDelta[0] > 0 &&
      colour.receiver?.gpuDelta[1] < 0,
    colour,
  );
  const differenceImage = await page.evaluate(() => {
    const width = lumenDemo.scene.drawingBufferWidth,
      height = lumenDemo.scene.drawingBufferHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d"),
      image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const source = ((height - 1 - y) * width + x) * 4,
          target = (y * width + x) * 4;
        // Signed red-vs-green change from the actual linear HDR render; display only.
        const delta =
          colouredHDR[source] -
          neutralHDR[source] -
          (colouredHDR[source + 1] - neutralHDR[source + 1]);
        const positive = Math.min(1, Math.max(0, delta * 5000)),
          negative = Math.min(1, Math.max(0, -delta * 5000));
        image.data.set(
          [18 + 237 * positive, 20 + 180 * negative, 25 + 210 * negative, 255],
          target,
        );
      }
    ctx.putImageData(image, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.font = "16px sans-serif";
    ctx.fillText(
      "Sponza HDR: red curtain colour - neutral curtain colour",
      20,
      28,
    );
    ctx.fillText(
      "Signed (R-G) difference x 5000 | red: red bounce | cyan: opposite sign",
      20,
      52,
    );
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await writeFile(
    "artifacts/sponza-color-bounce-difference.png",
    Buffer.from(differenceImage, "base64"),
  );
  const offscreen = await page.evaluate(async () => {
    const d = lumenDemo,
      C = Cesium,
      p = receiver.position;
    const rotation = C.Matrix4.getMatrix3(d.frame, new C.Matrix3());
    d.scene.camera.frustum.fov = C.Math.toRadians(15);
    d.scene.camera.setView({
      destination: C.Matrix4.multiplyByPoint(
        d.frame,
        new C.Cartesian3(p[0], p[1], p[2] + 1.5),
        new C.Cartesian3(),
      ),
      orientation: {
        direction: C.Matrix3.multiplyByVector(
          rotation,
          new C.Cartesian3(0, 0, -1),
          new C.Cartesian3(),
        ),
        up: C.Matrix3.multiplyByVector(
          rotation,
          new C.Cartesian3(1, 0, 0),
          new C.Cartesian3(),
        ),
      },
    });
    qa.render();
    let visible = 0;
    const projection = C.Matrix4.multiply(
      d.scene.camera.frustum.projectionMatrix,
      d.scene.camera.viewMatrix,
      new C.Matrix4(),
    );
    for (const s of redSurfaces) {
      const world = C.Matrix4.multiplyByPoint(
        d.frame,
        C.Cartesian3.fromArray(s.position),
        new C.Cartesian3(),
      );
      const v = C.Matrix4.multiplyByVector(
        projection,
        new C.Cartesian4(world.x, world.y, world.z, 1),
        new C.Cartesian4(),
      );
      if (
        v.w > 0 &&
        Math.abs(v.x / v.w) < 1 &&
        Math.abs(v.y / v.w) < 1 &&
        Math.abs(v.z / v.w) < 1
      )
        visible++;
    }
    const held = (await d.scene.lumen.world.sample([receiver]))[0];
    await qa.solve({ neutralMaterials: [] });
    const a = (await d.scene.lumen.world.sample([receiver]))[0],
      hdrA = qa.hdr();
    await qa.solve({ neutralMaterials: [16, 18] });
    const b = (await d.scene.lumen.world.sample([receiver]))[0],
      hdrB = qa.hdr();
    const x = Math.floor(d.scene.drawingBufferWidth / 2),
      y = Math.floor(d.scene.drawingBufferHeight / 2),
      o = (y * d.scene.drawingBufferWidth + x) * 4;
    return {
      visibleRedSurfels: visible,
      totalRedSurfels: redSurfaces.length,
      heldDifference: Math.max(
        ...held.irradiance.map((v, i) =>
          Math.abs(v - receiver.neutral.irradiance[i]),
        ),
      ),
      cameraInvariantDifference: Math.max(
        ...a.irradiance.map((v, i) =>
          Math.abs(v - receiver.coloured.irradiance[i]),
        ),
      ),
      delta: a.irradiance.map((v, i) => v - b.irradiance[i]),
      gpuDelta: [0, 1, 2].map((k) => hdrA[o + k] - hdrB[o + k]),
      coloured: a,
      neutral: b,
    };
  });
  check(
    "Fresh BVH/DDGI solves preserve off-screen curtain colour transport",
    offscreen.visibleRedSurfels === 0 &&
      offscreen.totalRedSurfels > 100 &&
      offscreen.heldDifference < 1e-8 &&
      offscreen.cameraInvariantDifference < 1e-8 &&
      offscreen.delta[0] > 1e-5 &&
      offscreen.gpuDelta[0] > 0 &&
      offscreen.gpuDelta[1] < 0,
    offscreen,
  );
  await page.evaluate(async () => {
    document.getElementById("neutral").checked = false;
    await qa.solve({ neutralMaterials: [] });
    qa.render();
  });
  await page.screenshot({
    path: "artifacts/sponza-offscreen-color-bounce.png",
  });
  const fallback = await page.evaluate(async () =>
    lumenDemo.scene.lumen.world.sample([
      { position: [1000, 1000, 1000], normal: [0, 0, 1] },
    ]),
  );
  check(
    "Outside loaded probe coverage returns zero coverage",
    fallback[0].coverage === 0,
    fallback,
  );
  const revisions = await page.evaluate(async () => {
    const w = lumenDemo.scene.lumen.world,
      old = w.irradianceTexture;
    const superseded = w.solve({
      sunRadiance: [8, 8, 8],
      skyRadiance: [2, 2, 2],
      bounces: 4,
    });
    const latest = w.solve({
      sunRadiance: [0, 0, 0],
      skyRadiance: [0, 0, 0],
      bounces: 1,
    });
    let rejected = false;
    try {
      await superseded;
    } catch (error) {
      rejected = String(error).includes("superseded");
    }
    await latest;
    qa.render();
    return {
      rejected,
      revision: w.revision,
      published: w.packet.revision,
      bounce: w.packet.bounce,
      energy: w.packet.history[0].energy,
      oldDestroyed: old.isDestroyed(),
      memory: w.memoryBytes,
    };
  });
  check(
    "Latest lighting revision wins; removing all light eliminates GI and replaces textures",
    revisions.rejected &&
      revisions.revision === revisions.published &&
      revisions.bounce === 1 &&
      revisions.energy === 0 &&
      revisions.oldDestroyed &&
      revisions.memory > 0,
    revisions,
  );
  const release = await page.evaluate(() => {
    const w = lumenDemo.scene.lumen.world,
      t = w.irradianceTexture;
    lumenDemo.widget.destroy();
    return {
      textureDestroyed: t.isDestroyed(),
      memory: w.memoryBytes,
      status: w.status,
    };
  });
  check(
    "Scene destruction releases worker and DDGI textures",
    release.textureDestroyed &&
      release.memory === 0 &&
      release.status === "destroyed",
    release,
  );
  check(
    "Real Sponza browser run remains error free",
    errors.length === 0,
    errors,
  );
  report.passed = true;
} finally {
  await writeFile(
    "artifacts/world-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
