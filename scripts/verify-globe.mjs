import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const out = "reports/globe-visibility-v3";
const runStamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
await mkdir(out, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  version: sourceVersion([
    "demo/globe.js",
    "scripts/generate-globe.mjs",
    "scripts/verify-globe.mjs",
  ]),
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
const runDirectory = `${out}/runs/${runStamp}`;
await mkdir(runDirectory, { recursive: true });
async function captureScreenshot(options) {
  await page.screenshot(options);
  await copyFile(
    options.path,
    `${runDirectory}/${path.basename(options.path)}`,
  );
}
const external = [];
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (
    url.origin !== "http://localhost:8090" &&
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
  // Narrow-FOV diagnostic, not the default Earth overview. Keep the real
  // model/transform, exposure and lighting unchanged; magnify only projection.
  await page.evaluate(() => {
    const d = earthLab,
      C = Cesium,
      camera = d.scene.camera;
    window.globeOcclusionRestore = {
      destination: C.Cartesian3.clone(camera.positionWC),
      orientation: {
        direction: C.Cartesian3.clone(camera.directionWC),
        up: C.Cartesian3.clone(camera.upWC),
      },
      show: d.model.show,
      globeShow: d.scene.globe.show,
      frustum: camera.frustum.clone(),
      backgroundColor: C.Color.clone(d.scene.backgroundColor),
      skyBoxShow: d.scene.skyBox?.show,
      skyAtmosphereShow: d.scene.skyAtmosphere?.show,
      modelMatrix: C.Matrix4.toArray(d.model.modelMatrix),
      revision: d.world.requestedRevision,
    };
    const longitude = ((d.anchor.longitude + 540) % 360) - 180;
    const oppositeLongitude = longitude > 0 ? longitude - 180 : longitude + 180;
    const destination = C.Cartesian3.fromDegrees(
      oppositeLongitude,
      -d.anchor.latitude,
      22000000,
    );
    const frame = C.Transforms.eastNorthUpToFixedFrame(destination);
    camera.cancelFlight();
    camera.setView({
      destination,
      orientation: {
        direction: C.Cartesian3.normalize(
          C.Cartesian3.subtract(
            d.model.boundingSphere.center,
            destination,
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        ),
        up: C.Matrix4.multiplyByPointAsVector(
          frame,
          C.Cartesian3.UNIT_Y,
          new C.Cartesian3(),
        ),
      },
    });
    // setView converts direction/up to HPR and deliberately chooses heading
    // from up near nadir (Camera.getHeading EPSILON3). At this diagnostic FOV
    // that approximation moves the model hundreds of thousands of pixels.
    // Set an exact orthonormal world basis through public Camera vectors.
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    C.Cartesian3.clone(destination, camera.position);
    C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        d.model.boundingSphere.center,
        destination,
        new C.Cartesian3(),
      ),
      camera.direction,
    );
    C.Cartesian3.normalize(
      C.Cartesian3.cross(
        camera.direction,
        C.Matrix4.multiplyByPointAsVector(
          frame,
          C.Cartesian3.UNIT_Y,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      ),
      camera.right,
    );
    C.Cartesian3.cross(camera.right, camera.direction, camera.up);
    const distance = C.Cartesian3.distance(
      destination,
      d.model.boundingSphere.center,
    );
    const aspect = d.scene.drawingBufferWidth / d.scene.drawingBufferHeight;
    const desiredRadiusPixels = 64;
    const fovy =
      2 *
      Math.atan(
        (d.model.boundingSphere.radius * d.scene.drawingBufferHeight) /
          (2 * distance * desiredRadiusPixels),
      );
    camera.frustum = new C.PerspectiveFrustum({
      fov: aspect > 1 ? 2 * Math.atan(Math.tan(fovy / 2) * aspect) : fovy,
      aspectRatio: aspect,
      near: 100000,
      far: distance + 1000000,
    });
    d.scene.globe.show = true;
    // A fixed display-only backdrop makes the unlit foundation silhouette
    // observable without changing materials, the GI environment, or sunlight.
    d.scene.backgroundColor = new C.Color(0.5, 0.5, 0.5, 1);
    if (d.scene.skyBox) d.scene.skyBox.show = false;
    if (d.scene.skyAtmosphere) d.scene.skyAtmosphere.show = false;
    d.model.show = true;
    window.globeStableTileFrames = 0;
    d.scene.requestRender();
  });
  try {
    await page.waitForFunction(
      () => {
        window.globeStableTileFrames = earthLab.scene.globe.tilesLoaded
          ? window.globeStableTileFrames + 1
          : 0;
        return window.globeStableTileFrames >= 10;
      },
      null,
      { timeout: 60000, polling: "raf" },
    );
    report.occlusion = await page.evaluate(() => {
      const d = earthLab,
        w = d.world,
        C = Cesium,
        width = d.scene.drawingBufferWidth,
        height = d.scene.drawingBufferHeight;
      const capture = () => {
        d.widget.render();
        d.widget.render();
        return w._read(
          d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
          width,
          height,
        );
      };
      d.model.show = true;
      const visible = capture();
      d.model.show = false;
      const hidden = capture();
      let maximum = 0,
        failures = 0;
      for (let i = 0; i < visible.length; i++) {
        const delta = Math.abs(visible[i] - hidden[i]);
        maximum = Math.max(maximum, delta);
        if (!Number.isFinite(delta) || delta > 1e-6) failures++;
      }
      // Positive control: with Globe absent the same projection must resolve
      // the actual model. An insensitive black/subpixel result cannot pass.
      d.scene.globe.show = false;
      d.model.show = true;
      const unobstructedModel = capture();
      d.model.show = false;
      const unobstructedBackground = capture();
      let sensitivityMaximum = 0,
        sensitivityPixels = 0,
        sensitivityNonFinite = 0;
      for (let i = 0; i < unobstructedModel.length; i += 4) {
        let changed = false;
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(
            unobstructedModel[i + channel] -
              unobstructedBackground[i + channel],
          );
          if (!Number.isFinite(delta)) sensitivityNonFinite++;
          sensitivityMaximum = Math.max(sensitivityMaximum, delta);
          if (delta > 1e-4) changed = true;
        }
        if (changed) sensitivityPixels++;
      }
      const origin = d.scene.camera.positionWC,
        target = d.model.boundingSphere.center;
      const direction = C.Cartesian3.normalize(
        C.Cartesian3.subtract(target, origin, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const interval = C.IntersectionTests.rayEllipsoid(
        new C.Ray(origin, direction),
        C.Ellipsoid.WGS84,
      );
      const distance = C.Cartesian3.distance(origin, target);
      d.scene.globe.show = true;
      d.model.show = true;
      d.widget.render();
      d.widget.render();
      return {
        maximum,
        failures,
        values: visible.length,
        absoluteTolerance: 1e-6,
        sensitivity: {
          maximum: sensitivityMaximum,
          changedPixels: sensitivityPixels,
          nonFinite: sensitivityNonFinite,
          absoluteTolerance: 1e-4,
          minimumChangedPixels: 20,
        },
        fovRadians: d.scene.camera.frustum.fov,
        diagnosticBackground: {
          color: [0.5, 0.5, 0.5, 1],
          skyBox: false,
          skyAtmosphere: false,
          affectsGiEnvironment: false,
        },
        tilesLoaded: d.scene.globe.tilesLoaded,
        stableTileFrames: window.globeStableTileFrames,
        depthTestAgainstTerrain: d.scene.globe.depthTestAgainstTerrain,
        globeEntryDistance: interval?.start,
        modelDistance: distance,
        projectedCenter: C.SceneTransforms.worldToWindowCoordinates(
          d.scene,
          target,
        ),
        projectedRadiusPixels:
          ((d.model.boundingSphere.radius / distance) * height) /
          (2 * Math.tan(d.scene.camera.frustum.fovy / 2)),
        revisionUnchanged:
          w.requestedRevision === window.globeOcclusionRestore.revision,
        modelMatrixUnchanged: C.Matrix4.toArray(d.model.modelMatrix).every(
          (v, i) => v === window.globeOcclusionRestore.modelMatrix[i],
        ),
        note: "Narrow-FOV antipode diagnostic, not the default Earth display. Real model geometry/transform unchanged. Globe-on model show/hide must match; Globe-off positive control must resolve at least 20 changed pixels.",
      };
    });
    await captureScreenshot({
      path: `${out}/globe-antipode-narrow-globe-on-model-on.png`,
    });
    await page.evaluate(() => {
      earthLab.model.show = false;
      earthLab.widget.render();
      earthLab.widget.render();
    });
    await captureScreenshot({
      path: `${out}/globe-antipode-narrow-globe-on-model-off.png`,
    });
    await page.evaluate(() => {
      earthLab.scene.globe.show = false;
      earthLab.model.show = true;
      earthLab.widget.render();
      earthLab.widget.render();
    });
    await captureScreenshot({
      path: `${out}/globe-antipode-narrow-globe-off-model-on.png`,
    });
    await page.evaluate(() => {
      earthLab.model.show = false;
      earthLab.widget.render();
      earthLab.widget.render();
    });
    await captureScreenshot({
      path: `${out}/globe-antipode-narrow-globe-off-model-off.png`,
    });
    check(
      "narrow-FOV antipode Globe occlusion with visible positive control",
      report.occlusion.failures === 0 &&
        report.occlusion.projectedRadiusPixels >= 20 &&
        report.occlusion.sensitivity.changedPixels >= 20 &&
        report.occlusion.sensitivity.nonFinite === 0 &&
        report.occlusion.modelMatrixUnchanged &&
        report.occlusion.depthTestAgainstTerrain &&
        report.occlusion.globeEntryDistance > 0 &&
        report.occlusion.globeEntryDistance < report.occlusion.modelDistance &&
        report.occlusion.revisionUnchanged,
      report.occlusion,
    );
  } finally {
    await page.evaluate(() => {
      const restore = window.globeOcclusionRestore;
      earthLab.model.show = restore.show;
      earthLab.scene.globe.show = restore.globeShow;
      earthLab.scene.camera.frustum = restore.frustum;
      earthLab.scene.backgroundColor = restore.backgroundColor;
      if (earthLab.scene.skyBox)
        earthLab.scene.skyBox.show = restore.skyBoxShow;
      if (earthLab.scene.skyAtmosphere)
        earthLab.scene.skyAtmosphere.show = restore.skyAtmosphereShow;
      earthLab.scene.camera.setView({
        destination: restore.destination,
        orientation: restore.orientation,
      });
      earthLab.scene.requestRender();
    });
  }
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
    // Local EllipsoidTerrainProvider meshes continue refining after camera
    // jumps. A fixed one-second delay can capture a coarse chordal surface.
    await page.evaluate(() => {
      window.bookmarkStableTileFrames = 0;
    });
    await page.waitForFunction(
      () => {
        window.bookmarkStableTileFrames = earthLab.scene.globe.tilesLoaded
          ? window.bookmarkStableTileFrames + 1
          : 0;
        return window.bookmarkStableTileFrames >= 10;
      },
      null,
      { timeout: 60000, polling: "raf" },
    );
    if (name === "context") {
      report.placement = await page.evaluate(() => {
        const d = earthLab,
          C = Cesium,
          g = d.scene.globe,
          b = d.metadata.bounds;
        return {
          tilesLoaded: g.tilesLoaded,
          stableTileFrames: window.bookmarkStableTileFrames,
          anchor: { ...d.anchor },
          samples: [
            [0, 0],
            [b[0], b[1]],
            [b[0], b[4]],
            [b[3], b[1]],
            [b[3], b[4]],
          ].map(([x, y]) => {
            const world = C.Matrix4.multiplyByPoint(
                d.frame,
                new C.Cartesian3(x, y, b[2]),
                new C.Cartesian3(),
              ),
              cartographic = C.Cartographic.fromCartesian(world),
              renderedHeight = g.getHeight(cartographic);
            return {
              local: [x, y, b[2]],
              baseHeight: cartographic.height,
              renderedHeight,
              gap: cartographic.height - renderedHeight,
              tileLevels: g._surface._tilesToRender
                .filter((t) => C.Rectangle.contains(t.rectangle, cartographic))
                .map((t) => t.level),
            };
          }),
          absoluteToleranceMeters: 0.01,
          note: "Rendered mesh contact only. Small chordal/quantization gaps do not validate the appearance of shadow contact.",
        };
      });
      check(
        "stable local Globe mesh lies within 1cm of foundation base",
        report.placement.samples.every(
          (p) =>
            Number.isFinite(p.gap) &&
            Math.abs(p.gap) < report.placement.absoluteToleranceMeters,
        ),
        report.placement,
      );
    }
    await captureScreenshot({ path: `${out}/globe-${name}.png` });
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
    await captureScreenshot({ path: `${out}/globe-${label}.png` });
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
  // Every run gets immutable raw results, including failures; the conventional
  // latest filename is only a convenience pointer for report consumers.
  await writeFile(
    `${out}/globe-results-${runStamp}-${report.status ?? "incomplete"}.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(`${out}/globe-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
