import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
  out = "reports/ddgi-visual-quality-v4",
  report = { version: sourceVersion(), states: [], errors: [] };
p.on("pageerror", (e) => report.errors.push(String(e)));
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&preset=presentation",
  );
  await p.waitForFunction(
    () =>
      earthLab.world?.status === "ready" &&
      earthLab.model.environmentMapManager._specularMapReady,
    null,
    { timeout: 180000 },
  );
  await p.evaluate(() => earthLab.camera("materials"));
  await p
    .locator("details")
    .first()
    .evaluate((el) => (el.open = true));
  for (const aa of ["off", "fxaa", "msaa4"]) {
    await p.selectOption("#aa", aa);
    await p.dispatchEvent("#aa", "change");
    report.states.push(
      await p.evaluate((aa) => {
        earthLab.widget.render();
        earthLab.widget.render();
        return {
          aa,
          requested: earthLab.scene.msaaSamples,
          actualHdr:
            earthLab.scene._view.sceneFramebuffer._colorFramebuffer.numSamples,
          fxaa: earthLab.scene.postProcessStages.fxaa.enabled,
          revision: earthLab.world.requestedRevision,
        };
      }, aa),
    );
    await p.screenshot({
      path: out + "/presentation/materials-aa-" + aa + ".png",
    });
  }
  assert.equal(report.states[0].actualHdr, 1);
  assert.equal(report.states[1].fxaa, true);
  assert.equal(report.states[2].actualHdr, 4);
  for (const tone of ["PBR_NEUTRAL", "ACES"]) {
    await p.selectOption("#tonemapper", tone);
    await p.dispatchEvent("#tonemapper", "change");
    await p.screenshot({
      path: out + "/presentation/materials-tone-" + tone + ".png",
    });
  }
  await p.selectOption("#tonemapper", "PBR_NEUTRAL");
  await p.dispatchEvent("#tonemapper", "change");
  await p.evaluate(() => {
    earthLab.camera("boxFoot");
    earthLab.scene.lumen.debugMode = 6;
  });
  for (const shadow of ["original", "contact"]) {
    await p.selectOption("#shadow", shadow);
    await p.dispatchEvent("#shadow", "change");
    await p.screenshot({
      path: out + "/presentation/shadow-" + shadow + ".png",
    });
    report.states.push(
      await p.evaluate(() => ({
        shadow: {
          normalOffset: earthLab.scene.shadowMap.normalOffset,
          softShadows: earthLab.scene.shadowMap.softShadows,
          maximumDistance: earthLab.scene.shadowMap.maximumDistance,
        },
        bias: earthLab.scene.shadowMap._primitiveBias,
        revision: earthLab.world.requestedRevision,
      })),
    );
  }
  await p.evaluate(() => earthLab.world.setDisplayTransition(50));
  const saved = await p.evaluate(() => earthLab.saveView());
  report.concurrentSave = await p.evaluate(async () => {
    const originalFetch = window.fetch;
    let release;
    window.fetch = (url, ...args) =>
      String(url).endsWith(".gltf")
        ? new Promise((resolve) => {
            release = () => resolve(originalFetch(url, ...args));
          })
        : originalFetch(url, ...args);
    try {
      const pending = earthLab.saveView();
      earthLab.camera("overview");
      earthLab.scene.postProcessStages.exposure = 1.7;
      release();
      return await pending;
    } finally {
      window.fetch = originalFetch;
    }
  });
  assert.deepEqual(report.concurrentSave.camera, saved.camera);
  assert.equal(report.concurrentSave.exposure, saved.exposure);
  await p.evaluate(() => {
    earthLab.anchor.longitude += 0.001;
    earthLab.anchor.heading = 22;
  });
  await p.selectOption("#quality", "fine");
  await p.dispatchEvent("#quality", "change");
  await p.waitForFunction(
    () =>
      earthLab.world?.status === "ready" &&
      earthLab.world.options.spacing === 1.5,
    null,
    { timeout: 180000 },
  );
  report.fine = await p.evaluate(() => ({
    probes: earthLab.world.packet.grid.total,
    spacing: earthLab.world.spacing,
    rays: earthLab.world.options.rays,
    bounces: earthLab.world.options.bounces,
  }));
  assert.equal(report.fine.probes, 1764);
  await p.selectOption("#publication", "progressive");
  await p.locator("#sun").evaluate((el) => (el.value = "135"));
  await p.dispatchEvent("#sun", "change");
  await p.evaluate(() => earthLab.world.completed);
  await p.evaluate((saved) => earthLab.restoreView(saved), saved);
  await p.waitForFunction(() => earthLab.world.status === "ready", null, {
    timeout: 180000,
  });
  report.restored = await p.evaluate(() => earthLab.saveView());
  assert.deepEqual(report.restored.camera, saved.camera);
  assert.deepEqual(report.restored.quality, saved.quality);
  assert.equal(report.restored.msaaSamples, saved.msaaSamples);
  assert.equal(report.restored.preset, saved.preset);
  assert.deepEqual(report.restored.anchor, saved.anchor);
  assert.deepEqual(report.restored.lighting, saved.lighting);
  assert.equal(report.restored.publicationMode, saved.publicationMode);
  assert.equal(report.restored.displayTransitionMilliseconds, 50);
  report.restoredWorld = await p.evaluate(() => ({
    sunDirection: earthLab.world.options.sunDirection,
    transition: earthLab.world.displayTransitionMilliseconds,
    alive: !earthLab.world.isDestroyed(),
    completed:
      earthLab.world.settledRevision === earthLab.world.requestedRevision,
  }));
  assert.deepEqual(
    report.restoredWorld.sunDirection,
    saved.lighting.sunDirection,
  );
  assert.ok(report.restoredWorld.alive && report.restoredWorld.completed);
  assert.ok(report.states.every((s) => s.revision === 1));
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(
    out + "/display-presets.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
