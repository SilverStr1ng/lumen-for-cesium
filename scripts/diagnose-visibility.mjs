import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const browser = await launchBrowser(),
  report = {
    startedAt: new Date().toISOString(),
    version: sourceVersion(["lumen/bvh.js"]),
    mode: "diagnostic readbacks; not performance",
    hdrTolerance: { absolute: 2e-4, relative: 1e-3 },
    errors: [],
  };
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.goto(
    "http://localhost:8090/demo/index.html?backend=gpu&publication=progressive",
  );
  await page.waitForFunction(
    () =>
      window.lumenDemo?.scene.lumen.world?.status === "ready" ||
      window.lumenDemo?.errors.length,
    null,
    { timeout: 600000 },
  );
  report.result = await page.evaluate(async () => {
    const d = lumenDemo,
      initial = d.scene.lumen.world,
      base = { ...initial.options },
      sunDirection = [0.1, -1, 0.65];
    const first =
      initial.options.bvhStrategy === "median" &&
      initial.options.visibilityMode === "reference"
        ? initial
        : d.scene.lumen.loadWorld({
            ...base,
            bvhStrategy: "median",
            visibilityMode: "reference",
          });
    await first.completed;
    const C = Cesium,
      scene = d.scene,
      fixedGain = initial.gain;
    first.gain = fixedGain;
    scene.camera.cancelFlight();
    scene.screenSpaceCameraController.enableInputs = false;
    d.widget.clock.shouldAnimate = false;
    const fixedTime = C.JulianDate.clone(d.widget.clock.currentTime);
    const renderState = () => ({
      cameraView: Array.from(scene.camera.viewMatrix),
      cameraProjection: Array.from(scene.camera.frustum.projectionMatrix),
      modelMatrix: Array.from(d.model.modelMatrix),
      exposure: scene.postProcessStages.exposure,
      highDynamicRange: scene.highDynamicRange,
      resolution: [scene.drawingBufferWidth, scene.drawingBufferHeight],
      worldGain: scene.lumen.world.gain,
      publishedBounce: scene.lumen.world.publishedBounce,
      requestedBounces: scene.lumen.world.options.bounces,
      lumenEnabled: scene.lumen.enabled,
      lumenDebugMode: scene.lumen.debugMode,
      lumenCoverage: scene.lumen.coverage,
      shadows: scene.shadowMap.enabled,
      shadowSize: scene.shadowMap.size,
      sunDirection: [
        scene.light.direction.x,
        scene.light.direction.y,
        scene.light.direction.z,
      ],
      sunColor: [
        scene.light.color.red,
        scene.light.color.green,
        scene.light.color.blue,
      ],
      sunIntensity: scene.light.intensity,
      time: C.JulianDate.toIso8601(fixedTime),
      modelReady: d.model.ready,
    });
    const displaySun = (sunDirection) => {
      const direction = C.Cartesian3.normalize(
        C.Cartesian3.fromArray(sunDirection),
        new C.Cartesian3(),
      );
      C.Cartesian3.negate(direction, direction);
      C.Matrix3.multiplyByVector(
        C.Matrix4.getMatrix3(d.frame, new C.Matrix3()),
        direction,
        direction,
      );
      scene.light = new C.DirectionalLight({
        direction,
        color: new C.Color(...base.sunRadiance),
        intensity: 1,
      });
      scene.requestRender();
    };
    const readHdr = (world) => {
      d.widget.clock.currentTime = C.JulianDate.clone(fixedTime);
      d.widget.resize();
      d.widget.render();
      d.widget.render();
      d.widget.render();
      return {
        values: world._read(
          scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
          scene.drawingBufferWidth,
          scene.drawingBufferHeight,
        ),
        renderState: renderState(),
      };
    };
    const compareHdr = (reference, candidate) => {
      let maxDifference = 0,
        failedPixels = 0,
        failedComponents = 0,
        nonFiniteComponents = 0,
        referenceNonFiniteComponents = 0,
        candidateNonFiniteComponents = 0,
        nonzeroPixels = 0,
        maximumReferenceValue = 0;
      for (let i = 0; i < reference.values.length; i += 4) {
        let failed = false,
          nonzero = false;
        for (let channel = 0; channel < 3; channel++) {
          const a = reference.values[i + channel],
            b = candidate.values[i + channel];
          if (!Number.isFinite(a)) referenceNonFiniteComponents++;
          if (!Number.isFinite(b)) candidateNonFiniteComponents++;
          if (!Number.isFinite(a) || !Number.isFinite(b)) {
            nonFiniteComponents++;
            failed = true;
            continue;
          }
          maximumReferenceValue = Math.max(maximumReferenceValue, a);
          nonzero ||= a > 0;
          const delta = Math.abs(a - b);
          maxDifference = Math.max(maxDifference, delta);
          if (delta > 2e-4 + 1e-3 * Math.abs(a)) {
            failedComponents++;
            failed = true;
          }
        }
        if (failed) failedPixels++;
        if (nonzero) nonzeroPixels++;
      }
      return {
        source:
          "actual forward scene HDR color framebuffer before postprocessing",
        channels: "RGB",
        pixels: reference.values.length / 4,
        maxDifference,
        failedPixels,
        failedComponents,
        nonFiniteComponents,
        referenceNonFiniteComponents,
        candidateNonFiniteComponents,
        nonzeroPixels,
        maximumReferenceValue,
        renderStateEqual:
          JSON.stringify(reference.renderState) ===
          JSON.stringify(candidate.renderState),
        referenceRenderState: reference.renderState,
        candidateRenderState: candidate.renderState,
      };
    };
    const { loadGeometry } = await import("/lumen/gltf.js");
    const geometry = await loadGeometry(base.url, base.axisMatrix);
    const read = (w) => {
      const g = w.packet.grid;
      return {
        grid: g,
        hits: w._read(w._hitFB, g.rays, g.total),
        positions: w.snapshot().positions,
        E: w.snapshot().irradiance,
        visibility: w._read(
          w._visibilityFB,
          g.rays,
          g.total,
          0,
          Cesium.PixelDatatype.UNSIGNED_BYTE,
        ),
        order: w._order.slice(),
      };
    };
    const directions = [
        [1, 0, 0.65],
        [-1, 0.1, 0.65],
        [0.1, -1, 0.65],
      ],
      references = [];
    for (const direction of directions) {
      displaySun(direction);
      await first.solve({ sunDirection: direction });
      references.push({ ...read(first), hdr: readHdr(first) });
    }
    const a = references.at(-1);
    await first.solve({
      sunDirection: [1, 0, 0.65],
      visibilityMode: "optimized",
    });
    await first.solve({ sunDirection, visibilityMode: "optimized" });
    for (let i = 0; i < 120 && first._queries.length; i++)
      await new Promise(requestAnimationFrame);
    const c = read(first);
    let cMaxE = 0,
      cFailures = 0,
      cVisibilityDifferences = 0;
    for (let i = 0; i < a.E.length; i++) {
      const delta = Math.abs(a.E[i] - c.E[i]);
      cMaxE = Math.max(cMaxE, delta);
      if (delta > 2e-4 + 1e-3 * Math.abs(a.E[i])) cFailures++;
    }
    for (let i = 0; i < a.visibility.length; i++)
      if (a.visibility[i] !== c.visibility[i]) cVisibilityDifferences++;
    const medianOptimized = {
      maxE: cMaxE,
      failures: cFailures,
      visibilityDifferences: cVisibilityDifferences,
      metrics: structuredClone(first.metrics.updates.at(-1)),
    };
    const second = d.scene.lumen.loadWorld({
      ...base,
      bvhStrategy: "sah",
      bvhBins: 12,
      visibilityMode: "optimized",
    });
    await second.completed;
    second.gain = fixedGain;
    const directionalComparisons = [];
    let b;
    for (let index = 0; index < directions.length; index++) {
      displaySun(directions[index]);
      await second.solve({ sunDirection: directions[index] });
      b = { ...read(second), hdr: readHdr(second) };
      const reference = references[index];
      let maxE = 0,
        failures = 0,
        visibilityDifferences = 0;
      for (let i = 0; i < reference.E.length; i++) {
        const delta = Math.abs(reference.E[i] - b.E[i]);
        maxE = Math.max(maxE, delta);
        if (delta > 2e-4 + 1e-3 * Math.abs(reference.E[i])) failures++;
      }
      for (let i = 0; i < reference.visibility.length; i++)
        if (reference.visibility[i] !== b.visibility[i])
          visibilityDifferences++;
      directionalComparisons.push({
        sunDirection: directions[index],
        maxE,
        failures,
        visibilityDifferences,
        hdr: compareHdr(reference.hdr, b.hdr),
      });
    }
    const hitInfo = (state, i) => {
      const h = Array.from(state.hits.slice(i, i + 4)),
        triangle = state.order[Math.abs(h[0]) - 2];
      return {
        h,
        triangle,
        material: geometry.materialIds[triangle],
        vertices: Array.from(
          geometry.positions.slice(triangle * 9, triangle * 9 + 9),
        ),
        uv: Array.from(geometry.uvs.slice(triangle * 6, triangle * 6 + 6)),
      };
    };
    const differences = [],
      visibilityDifferences = [];
    let differentHits = 0,
      deltaDistance = 0;
    for (let i = 0; i < a.hits.length; i += 4) {
      const ta = a.order[Math.abs(a.hits[i]) - 2],
        tb = b.order[Math.abs(b.hits[i]) - 2];
      if (ta !== tb || Math.sign(a.hits[i]) !== Math.sign(b.hits[i])) {
        differentHits++;
        if (differences.length < 100)
          differences.push({ slot: i / 4, a: hitInfo(a, i), b: hitInfo(b, i) });
      }
      deltaDistance = Math.max(
        deltaDistance,
        Math.abs(a.hits[i + 3] - b.hits[i + 3]),
      );
    }
    for (let i = 0; i < a.visibility.length; i += 4)
      if (
        a.visibility.slice(i, i + 4).some((v, k) => v !== b.visibility[i + k])
      ) {
        const slot = i / 4,
          probe = Math.floor(slot / a.grid.rays),
          ray = slot % a.grid.rays,
          z = 1 - (2 * (ray + 0.5)) / a.grid.rays,
          angle = ray * 2.399963229728653,
          r = Math.sqrt(Math.max(0, 1 - z * z));
        visibilityDifferences.push({
          slot,
          origin: Array.from(a.positions.slice(probe * 4, probe * 4 + 3)),
          direction: [Math.cos(angle) * r, Math.sin(angle) * r, z],
          a: hitInfo(a, i),
          b: hitInfo(b, i),
          visibilityA: Array.from(a.visibility.slice(i, i + 4)),
          visibilityB: Array.from(b.visibility.slice(i, i + 4)),
        });
      }
    let maxE = 0,
      failures = 0;
    for (let i = 0; i < a.E.length; i++) {
      const delta = Math.abs(a.E[i] - b.E[i]);
      maxE = Math.max(maxE, delta);
      if (delta > 2e-4 + 1e-3 * Math.abs(a.E[i])) failures++;
    }
    return {
      medianOptimized,
      directionalComparisons,
      differentHits,
      deltaDistance,
      maxE,
      failures,
      differences,
      visibilityDifferences,
    };
  });
  for (const direction of report.result.directionalComparisons) {
    assert.equal(direction.maxE, 0);
    assert.equal(direction.failures, 0);
    assert.equal(direction.visibilityDifferences, 0);
    assert.equal(direction.hdr.failedPixels, 0);
    assert.equal(direction.hdr.nonFiniteComponents, 0);
    assert.equal(direction.hdr.renderStateEqual, true);
    assert.equal(direction.hdr.referenceRenderState.highDynamicRange, true);
    assert.equal(direction.hdr.referenceRenderState.modelReady, true);
    assert.ok(direction.hdr.nonzeroPixels > 0);
    assert.equal(direction.hdr.referenceRenderState.publishedBounce, direction.hdr.referenceRenderState.requestedBounces);
  }
  assert.equal(
    report.result.differentHits,
    0,
    "Original median nearest-hit identity including exact-distance ties",
  );
  assert.equal(report.result.deltaDistance, 0);
  assert.equal(report.result.maxE, 0);
  assert.equal(report.result.failures, 0);
  assert.equal(report.result.visibilityDifferences.length, 0);
  assert.equal(report.result.medianOptimized.maxE, 0);
  assert.equal(report.result.medianOptimized.visibilityDifferences, 0);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(
    JSON.stringify({
      directions: report.result.directionalComparisons.map(({ sunDirection, maxE, visibilityDifferences, hdr }) => ({ sunDirection, maxE, visibilityDifferences, hdr: { maxDifference: hdr.maxDifference, failedPixels: hdr.failedPixels, nonFiniteComponents: hdr.nonFiniteComponents, renderStateEqual: hdr.renderStateEqual } })),
      differentHits: report.result.differentHits,
      deltaDistance: report.result.deltaDistance,
      maxE: report.result.maxE,
      failures: report.result.failures,
      visibilityDifferences: report.result.visibilityDifferences,
    }),
  );
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ??
      `reports/globe-visibility-v3/visibility-sponza-hdr-${report.startedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
