import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  launchBrowser,
  installGlObserver,
  environment,
  sourceVersion,
} from "./browser-tools.mjs";
await mkdir("artifacts", { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 512, height: 384 } });
await page.addInitScript(installGlObserver);
const report = {
  version: sourceVersion(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  mode: "numerical diagnostics with readback and nonblocking fence polling",
  checks: [],
  errors: [],
};
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (
    m.type() === "error" ||
    /feedback loop|INVALID_OPERATION|CONTEXT_LOST/.test(m.text())
  )
    report.errors.push(m.text());
});
const check = (name, condition, details) => {
  report.checks.push({ name, passed: !!condition, details });
  assert.ok(condition, name);
  console.log("PASS", name);
};
try {
  await page.goto(
    "http://localhost:8090/demo/regression.html?fixture=untextured",
  );
  await page.waitForFunction(
    () =>
      window.lumenTest?.world?.status === "ready" || lumenTest?.errors.length,
    null,
    { timeout: 120000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
  report.environment = await environment(page, browser);
  const dependencies = await page.evaluate(async () => {
    const d = lumenTest,
      w = d.world,
      g = w.packet.grid;
    for (const [name, command] of Object.entries(w._commands))
      glObserver.labelProgram(command.shaderProgram._program, name);
    glObserver.phase("diagnostic");
    const initial = w.snapshot(),
      startWork = { ...w.metrics.work },
      initialVersions = { ...w.versions };
    const cache = w.cacheDiagnostics();
    const out = { initialVersions, cache, initialWork: startWork, steps: [] };
    for (const [name, options] of [
      ["skyOnly", { skyRadiance: [0.8, 0.6, 0.4] }],
      ["intensityOnly", { sunRadiance: [4, 3, 2] }],
      ["direction", { sunDirection: [-1, 0, 0.65] }],
      [
        "material",
        {
          materialOverrides: [
            {
              id: 1,
              baseColorFactor: [0.2, 0.2, 0.2],
              emissiveFactor: [0, 0.3, 0],
            },
          ],
        },
      ],
    ]) {
      glObserver.phase(name);
      const result = await w.solve(options);
      glObserver.phase("diagnostic");
      const snapshot = w.snapshot();
      let momentDifference = 0;
      for (let i = 0; i < initial.moments.length; i++)
        momentDifference = Math.max(
          momentDifference,
          Math.abs(initial.moments[i] - snapshot.moments[i]),
        );
      out.steps.push({
        name,
        result,
        versions: { ...w.versions },
        momentDifference,
        samples: await w.sample(d.metadata.receivers),
        cache: w.cacheDiagnostics(),
      });
    }
    const sky = [0.2, 0.3, 0.4],
      first = w.solve({ skyRadiance: sky });
    sky[0] = 100;
    await first;
    const firstSnapshot = w.snapshot();
    await w.solve({ skyRadiance: [0.2, 0.3, 0.4] });
    const secondSnapshot = w.snapshot();
    out.immutableDifference = Math.max(
      ...firstSnapshot.irradiance.map((v, i) =>
        Math.abs(v - secondSnapshot.irradiance[i]),
      ),
    );
    out.geometryWorkAfter = { ...w.metrics.work };
    out.optionsImmutable =
      Object.isFrozen(w.options) && Object.isFrozen(w.options.skyRadiance);
    const unsupported = [];
    for (const options of [
      { traversalBudget: 1 },
      { materialOverrides: [{ id: 0, alphaCutoff: 0.1 }] },
      { materialOverrides: [{ id: 0, baseColorFactor: [1, 1, 1, 0] }] },
      { materialOverrides: [{ id: 999, emissiveFactor: [1, 0, 0] }] },
    ])
      try {
        w.solve(options);
        unsupported.push(false);
      } catch {
        unsupported.push(true);
      }
    out.unsupportedRejected = unsupported;
    out.gl = glObserver.snapshot();
    return out;
  });
  check(
    "valid sun cache has no Unknown slots",
    dependencies.cache.sunUnknown === 0 &&
      dependencies.cache.probeUnknown === 0,
    dependencies.cache,
  );
  for (const step of dependencies.steps.slice(0, 2))
    check(
      `${step.name}: zero new probe intersections, sun BVH work and moments`,
      Object.values(step.result.work).every((v) => v === 0) &&
        !(dependencies.gl[0].phases[step.name]["draws:visibility"] ?? 0),
      step,
    );
  const direction = dependencies.steps[2];
  check(
    "direction refreshes sun visibility without retracing probe hits",
    direction.result.work.sunVisibilitySubmittedSlots > 0 &&
      direction.result.work.probeHitInvocations === 0 &&
      direction.result.work.momentProbeUpdates === 0 &&
      direction.versions.sunVisibility >
        dependencies.initialVersions.sunVisibility &&
      dependencies.gl[0].phases.direction["draws:visibility"] > 0,
    direction,
  );
  check(
    "distance moments remain bit-identical through energy, direction and material changes",
    dependencies.steps.every((s) => s.momentDifference === 0),
    dependencies.steps.map((s) => ({
      name: s.name,
      difference: s.momentDifference,
    })),
  );
  const material = dependencies.steps[3];
  check(
    "RGB/emission updates have independent material versions and reuse geometry and visibility",
    material.versions.material > direction.versions.material &&
      material.versions.geometry === direction.versions.geometry &&
      Object.values(material.result.work).every((v) => v === 0),
    material,
  );
  check(
    "immutable jobs resist caller mutation and unsafe hit-semantic changes are rejected",
    dependencies.immutableDifference === 0 &&
      dependencies.optionsImmutable &&
      dependencies.unsupportedRejected.every(Boolean),
    dependencies,
  );
  // Independent geometric oracle: a probe's moments depend on hits, not cached light validity.
  const geometry = await page.evaluate(async () => {
    const w = lumenTest.world,
      { fibonacci, octDecode, dot } = await import("/lumen/math.js"),
      s = w.snapshot(),
      g = s.grid,
      h = w._read(w._hitFB, g.rays, g.total),
      directions = fibonacci(g.rays);
    let maximum = 0,
      maximumNormalizedError = 0,
      alphaError = 0,
      checked = 0;
    for (let p = 0; p < g.total; p++)
      if (s.positions[p * 4 + 3] > 0.5)
        for (let y = 1; y <= 8; y++)
          for (let x = 1; x <= 8; x++) {
            const direction = octDecode(
              ((x - 0.5) / 8) * 2 - 1,
              ((y - 0.5) / 8) * 2 - 1,
            );
            let mean = 0,
              second = 0,
              weight = 0,
              known = 0;
            for (let r = 0; r < g.rays; r++) {
              const i = (p * g.rays + r) * 4;
              if (h[i] === -1) continue;
              known++;
              const v = Math.max(0, dot(direction, directions[r])) ** 16,
                distance = Math.min(h[i + 3], g.spacing * 8);
              mean += distance * v;
              second += distance * distance * v;
              weight += v;
            }
            const i =
              ((Math.floor(p / (g.counts[0] * g.counts[1])) * 10 + y) *
                g.width +
                (p % (g.counts[0] * g.counts[1])) * 10 +
                x) *
              4;
            maximum = Math.max(
              maximum,
              Math.abs(s.moments[i] - mean / Math.max(weight, 1e-20)),
              Math.abs(s.moments[i + 1] - second / Math.max(weight, 1e-20)),
            );
            for (const [actual, expected] of [
              [s.moments[i], mean / Math.max(weight, 1e-20)],
              [s.moments[i + 1], second / Math.max(weight, 1e-20)],
            ])
              maximumNormalizedError = Math.max(
                maximumNormalizedError,
                Math.abs(actual - expected) /
                  (2e-4 + 1e-4 * Math.abs(expected)),
              );
            alphaError = Math.max(
              alphaError,
              Math.abs(s.moments[i + 3] - known / g.rays),
            );
            checked++;
          }
    // Generate real Unknown sun rays in a diagnostic pass, retaining the independently computed geometry.
    const before = s.moments.slice();
    w._diagnosticBudget = 1;
    w._draw("visibility", w._visibilityFB, 0, 0, g.rays, g.total);
    w._diagnosticBudget = undefined;
    const unknown = w.cacheDiagnostics();
    await w.solve({ sunRadiance: [2, 2, 2] });
    const after = w.snapshot();
    let momentDifference = 0;
    for (let i = 0; i < before.length; i++)
      momentDifference = Math.max(
        momentDifference,
        Math.abs(before[i] - after.moments[i]),
      );
    let minimumLightValidity = 1;
    for (let p = 0; p < g.total; p++)
      if (after.positions[p * 4 + 3] > 0.5) {
        const tileX = p % (g.counts[0] * g.counts[1]),
          tileY = Math.floor(p / (g.counts[0] * g.counts[1]));
        for (let y = 1; y <= 8; y++)
          for (let x = 1; x <= 8; x++)
            minimumLightValidity = Math.min(
              minimumLightValidity,
              after.irradiance[
                ((tileY * 10 + y) * g.width + tileX * 10 + x) * 4 + 3
              ],
            );
      }
    return {
      maximum,
      maximumNormalizedError,
      alphaError,
      checked,
      unknown,
      momentDifference,
      minimumLightValidity,
    };
  });
  check(
    "distance moments match an independent CPU formula",
    geometry.checked > 0 &&
      geometry.maximumNormalizedError <= 1 &&
      geometry.alphaError === 0,
    geometry,
  );
  check(
    "Unknown sun visibility is retained as invalid lighting without changing geometry",
    geometry.unknown.sunUnknown > 0 &&
      geometry.momentDifference === 0 &&
      geometry.minimumLightValidity < 0.95,
    geometry,
  );
  const hdr = await page.evaluate(async () => {
    const d = lumenTest,
      w = d.world,
      C = Cesium;
    // Restore known visibility using a different direction, then isolate indirect HDR.
    d.scene.lumen.debugMode = 2;
    const receiver = d.metadata.receivers[0],
      world = C.Matrix4.multiplyByPoint(
        d.frame,
        C.Cartesian3.fromArray(receiver.position),
        new C.Cartesian3(),
      ),
      pixel = C.SceneTransforms.worldToWindowCoordinates(d.scene, world);
    const read = () => {
      d.widget.render();
      d.widget.render();
      const data = w._read(
          d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
          d.scene.drawingBufferWidth,
          d.scene.drawingBufferHeight,
        ),
        i =
          ((d.scene.drawingBufferHeight - 1 - Math.floor(pixel.y)) *
            d.scene.drawingBufferWidth +
            Math.floor(pixel.x)) *
          4;
      return Array.from(data.subarray(i, i + 4));
    };
    const fence = async () => {
      const gl = d.scene.context._gl,
        f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0),
        started = performance.now();
      gl.flush();
      try {
        for (;;) {
          const status = gl.clientWaitSync(f, 0, 0);
          if (status === gl.WAIT_FAILED)
            throw new Error("Diagnostic fence wait failed");
          if (
            status === gl.ALREADY_SIGNALED ||
            status === gl.CONDITION_SATISFIED
          )
            break;
          if (performance.now() - started > 10000)
            throw new Error("Diagnostic fence timeout");
          await new Promise(requestAnimationFrame);
        }
        return performance.now() - started;
      } finally {
        gl.deleteSync(f);
      }
    };
    await w.solve({
      sunDirection: [1, 0, 0.65],
      sunRadiance: [0, 0, 0],
      skyRadiance: [0.1, 0.1, 0.1],
      materialOverrides: [{ id: 1, emissiveFactor: [0, 0, 0] }],
    });
    const low = read();
    const start = performance.now(),
      result = await w.solve({ skyRadiance: [0.8, 0.8, 0.8] });
    const finalSubmission = performance.now() - start;
    const gpuCompletionAfterSubmission = await fence(),
      high = read();
    return {
      low,
      high,
      result,
      finalSubmission,
      gpuCompletionAfterSubmission,
      gl: glObserver.snapshot(),
    };
  });
  check(
    "actual foreground HDR responds to sky changes",
    hdr.high.slice(0, 3).every((v, i) => v > hdr.low[i] + 0.01),
    hdr,
  );
  check(
    "no GL feedback or errors in dependency and HDR diagnostics",
    hdr.gl.every((s) => s.feedback.length === 0 && s.errors.length === 0) &&
      report.errors.length === 0,
    hdr.gl,
  );
  report.dependencies = dependencies;
  report.geometry = geometry;
  report.hdr = hdr;
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/relighting-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
