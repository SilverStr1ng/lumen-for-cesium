import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out = "reports/globe-visibility-v3";
await mkdir(out, { recursive: true });
const report = {
  version: sourceVersion(["demo/globe.js", "scripts/generate-globe.mjs"]),
  mode: "local-only browser WebGL2",
  checks: [],
  errors: [],
  online: "not-run: no real token supplied",
};
report.assetSha256 = Object.fromEntries(
  await Promise.all(
    ["gltf", "bin", "json"].map(async (extension) => {
      const file = `fixtures/earth-pavilion.${extension}`;
      return [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ];
    }),
  ),
);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const external = [];
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) &&
    !["data:", "blob:"].includes(url.protocol)
  ) {
    external.push(url.origin);
    return route.abort();
  }
  return route.continue();
});
page.on("pageerror", (e) => report.errors.push(String(e)));
const check = (name, passed, details) => {
  report.checks.push({ name, passed, details });
  assert.ok(passed, name);
};
try {
  await page.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await page.waitForFunction(
    () =>
      window.earthLab?.world?.status === "ready" ||
      window.earthLab?.errors.length,
    null,
    { timeout: 180000 },
  );
  const state = await page.evaluate(() => {
    const d = earthLab,
      w = d.world;
    const direction = Cesium.Matrix4.multiplyByPointAsVector(
      Cesium.Matrix4.inverse(d.frame, new Cesium.Matrix4()),
      d.scene.light.direction,
      new Cesium.Cartesian3(),
    );
    const sun = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.fromArray(d.lighting.sunDirection),
      new Cesium.Cartesian3(),
    );
    return {
      errors: d.errors,
      status: w?.status,
      probes: w?.packet?.grid.total,
      revision: w?.requestedRevision,
      axis: Cesium.Matrix4.toArray(d.model._sceneGraph.axisCorrectionMatrix),
      sunDot: Cesium.Cartesian3.dot(direction, sun),
      globe: !!d.scene.globe,
      terrain: d.scene.terrainProvider.constructor.name,
      gBuffer: d.scene.gBuffer.enabled,
      gain: w?.gain,
      metrics: w?.metrics,
    };
  });
  check(
    "local-only ready",
    state.status === "ready" && state.errors.length === 0,
    state,
  );
  check("no external requests", external.length === 0, external);
  check(
    "real Globe, probe budget and gain",
    state.globe && state.probes <= 4096 && state.gain === 1,
    state,
  );
  check(
    "ENU solar propagation sign",
    Math.abs(state.sunDot + 1) < 1e-10,
    state.sunDot,
  );
  check("GBuffer disabled by default", state.gBuffer === false);
  for (const name of [
    "earth",
    "overview",
    "context",
    "top",
    "corridor",
    "inside",
    "bounce",
  ]) {
    await page.evaluate((name) => earthLab.camera(name), name);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${out}/globe-${name}.png` });
  }
  for (const [label, enabled, mode] of [
    ["ab-on", true, 0],
    ["ab-off", false, 0],
    ["indirect", true, 2],
  ]) {
    await page.evaluate(
      ({ enabled, mode }) => {
        earthLab.camera("bounce");
        earthLab.scene.lumen.enabled = enabled;
        earthLab.scene.lumen.debugMode = mode;
        document.getElementById("enabled").checked = enabled;
        document.getElementById("mode").value = String(mode);
        earthLab.scene.requestRender();
      },
      { enabled, mode },
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/globe-${label}.png` });
  }
  check(
    "camera and product AB do not relight",
    await page.evaluate(
      (rev) => earthLab.world.requestedRevision === rev,
      state.revision,
    ),
  );
  await page
    .locator("details")
    .first()
    .evaluate((el) => (el.open = true));
  await page.fill("#token", "invalid-diagnostic-placeholder");
  await page.fill("#asset", "999999999");
  await page.click("#online");
  await page.waitForFunction(() =>
    document.getElementById("network").textContent.includes("回退"),
  );
  await page
    .locator("details")
    .first()
    .evaluate((el) => (el.open = true));
  for (const status of [401, 403]) {
    await page.route("https://api.cesium.com/**", (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: '{"message":"diagnostic rejection"}',
      }),
    );
    await page.evaluate(async (status) => {
      document.getElementById("network").textContent = "pending";
      // Cesium caches rejected endpoint promises by asset/token; use distinct
      // IDs so each simulated HTTP response actually reaches its own request.
      document.getElementById("asset").value = String(999999000 + status);
      await earthLab.enhance();
    }, status);
    check(
      `ion HTTP ${status} falls back`,
      await page.evaluate(
        (status) =>
          document
            .getElementById("network")
            .textContent.includes(`HTTP ${status}`) &&
          earthLab.scene.terrainProvider instanceof
            Cesium.EllipsoidTerrainProvider,
        status,
      ),
    );
    await page.unroute("https://api.cesium.com/**");
  }
  await page.fill("#token", "");
  check(
    "blocked ion request falls back",
    await page.evaluate(
      () =>
        earthLab.scene.terrainProvider instanceof
        Cesium.EllipsoidTerrainProvider,
    ),
  );
  // Diagnostic-only readbacks: alignment, receiver HDR and geographic invariance.
  const numerical = await page.evaluate(async () => {
    const d = earthLab,
      C = Cesium,
      w = d.world;
    d.camera("overview");
    d.scene.lumen.enabled = true;
    d.scene.lumen.debugMode = 0;
    d.scene.gBuffer.enabled = true;
    d.widget.render();
    d.widget.render();
    const width = d.scene.drawingBufferWidth,
      height = d.scene.drawingBufferHeight,
      g = d.scene.gBuffer;
    const a = w._read(g.framebuffer, width, height),
      n = w._read(g.framebuffer, width, height, 1),
      p = w._read(g.framebuffer, width, height, 2),
      rays = [];
    for (let y = 16; y < height; y += 24)
      for (let x = 360; x < width; x += 24) {
        const o = (y * width + x) * 4;
        if (a[o + 3] < 0.5) continue;
        const pos = C.Matrix4.multiplyByPoint(
          w.eyeToLocal,
          C.Cartesian3.fromArray(p, o),
          new C.Cartesian3(),
        );
        const normal = C.Cartesian3.normalize(
          C.Matrix4.multiplyByPointAsVector(
            w.eyeToLocal,
            C.Cartesian3.fromArray(n, o),
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        );
        rays.push({
          origin: [
            pos.x + normal.x * 0.05,
            pos.y + normal.y * 0.05,
            pos.z + normal.z * 0.05,
          ],
          direction: [-normal.x, -normal.y, -normal.z],
          maxDistance: 0.1,
        });
      }
    const hits = await w.trace(rays);
    const alignment = {
      rays: hits.length,
      matched: hits.filter(
        (h) => h.status === "Hit" && Math.abs(h.distance - 0.05) < 0.008,
      ).length,
      unknown: hits.filter((h) => h.status === "Unknown").length,
    };
    d.scene.gBuffer.enabled = false;
    d.camera("bounce");
    const receiver = async () => {
      d.widget.render();
      d.widget.render();
      const local = C.Cartesian3.fromArray(d.metadata.receivers[0].position),
        world = C.Matrix4.multiplyByPoint(d.frame, local, new C.Cartesian3());
      const pixel = C.SceneTransforms.worldToWindowCoordinates(d.scene, world);
      const hdr = w._read(
        d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
        width,
        height,
      );
      const x = Math.floor(pixel.x),
        y = height - 1 - Math.floor(pixel.y),
        offset = (y * width + x) * 4;
      return {
        irradiance: await w.sample(d.metadata.receivers),
        pixel: [x, y],
        hdr: Array.from(hdr.slice(offset, offset + 4)),
      };
    };
    const colored = await receiver();
    await w.solve({ neutralMaterials: [1, 2] });
    const neutral = await receiver();
    await w.solve({ neutralMaterials: [] });
    window.globeReference = Array.from(w.snapshot().irradiance);
    return {
      alignment,
      colored,
      neutral,
      tolerance: {
        alignmentMeters: 0.008,
        fieldAbsolute: 0.0002,
        fieldRelative: 0.001,
      },
    };
  });
  report.numerical = numerical;
  check(
    "GBuffer/BVH ENU alignment",
    numerical.alignment.rays > 10 &&
      numerical.alignment.matched / numerical.alignment.rays > 0.95 &&
      numerical.alignment.unknown === 0,
    numerical.alignment,
  );
  await page.evaluate(async () => {
    earthLab.anchor.longitude = 10;
    earthLab.anchor.latitude = 45;
    await earthLab.reload();
  });
  await page.waitForFunction(() => earthLab.world.status === "ready", null, {
    timeout: 180000,
  });
  const geographic = await page.evaluate(() => {
    const field = earthLab.world.snapshot().irradiance;
    let maximum = 0,
      failures = 0;
    for (let i = 0; i < field.length; i++) {
      const e = Math.abs(field[i] - window.globeReference[i]);
      maximum = Math.max(maximum, e);
      if (e > 0.0002 + 0.001 * Math.abs(window.globeReference[i])) failures++;
    }
    return {
      maximum,
      failures,
      values: field.length,
      anchor: { ...earthLab.anchor },
    };
  });
  report.geographic = geographic;
  check(
    "equivalent local GI at another longitude/latitude",
    geographic.failures === 0,
    geographic,
  );

  report.state = state;
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  throw e;
} finally {
  await writeFile(`${out}/globe-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
