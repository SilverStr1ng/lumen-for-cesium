import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  environment,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
import { ballPoolGltf } from "../lumen/ballpool-scene.js";
import { loadGeometry } from "../lumen/gltf.js";
import { BVH } from "../lumen/bvh.js";
import { referenceIrradiance } from "../lumen/path-reference.js";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/ballpool-curved-receivers-v8/lifecycle-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion([
      "scripts/verify-ballpool.mjs",
      "node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs",
      "package-lock.json",
    ]),
    checks: [],
    errors: [],
    renderErrors: [],
  };
page.on("pageerror", (e) => report.errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") report.renderErrors.push(m.text());
});
await page.addInitScript(installGlObserver, { resourceStacks: true });
await page.addInitScript(() => {
  const NativeWorker = Worker,
    live = new Set(),
    local = new Set();
  let peak = 0,
    localPeak = 0,
    created = 0;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      live.add(this);
      if (String(args[0]).includes("/lumen/gpu-worker.js")) local.add(this);
      created++;
      peak = Math.max(peak, live.size);
      localPeak = Math.max(localPeak, local.size);
    }
    terminate() {
      live.delete(this);
      local.delete(this);
      super.terminate();
    }
  };
  window.workerAudit = () => ({
    live: live.size,
    localWorldWorkers: local.size,
    localPeak,
    peak,
    created,
  });
});
const check = (name, value, detail) => {
  report.checks.push({ name, status: value ? "passed" : "failed", detail });
  assert(value, name + ": " + JSON.stringify(detail));
};
const ready = () =>
  page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
async function coldBootstrap(action) {
  const cold = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    }),
    errors = [],
    renderErrors = [];
  cold.on("pageerror", (e) => errors.push(String(e)));
  cold.on("console", (m) => {
    if (m.type() === "error") renderErrors.push(m.text());
  });
  await cold.addInitScript(installGlObserver);
  let release, requested;
  const held = new Promise((resolve) => (release = resolve)),
    requestStarted = new Promise((resolve) => (requested = resolve));
  await cold.route("**/tilemapresource.xml", async (route) => {
    requested();
    await held;
    await route.continue();
  });
  try {
    await cold.goto(
      "http://localhost:8090/demo/ballpool.html?count=64&diagnostic=1",
      { waitUntil: "domcontentloaded" },
    );
    await requestStarted;
    await cold.waitForFunction(() => !!window.ballPool);
    let state;
    if (action === "dispose") {
      await cold.evaluate(() => ballPool.dispose());
      release();
      await cold.evaluate(() => ballPool.initialized);
      state = await cold.evaluate(async () => {
        let resetError;
        try {
          await ballPool.reset(16);
        } catch (e) {
          resetError = e.message;
        }
        return {
          state: ballPool.snapshot(),
          physicsAbsent: !ballPool.physics,
          sceneDestroyed: ballPool.scene.isDestroyed(),
          resetError,
          gl: glObserver.snapshot(),
        };
      });
      check(
        "cold disposal cancels delayed imagery and physics initialization",
        state.physicsAbsent &&
          state.sceneDestroyed &&
          state.state.phase === "disposed" &&
          state.state.worldBuilds === 0 &&
          state.resetError === "Ball Pool disposed" &&
          state.gl.every((s) => Object.values(s.live).every((n) => n === 0)),
        state,
      );
    } else {
      await cold.evaluate(async () => {
        await ballPool.reset(16);
        window.coldPhysics = ballPool.physics;
        window.coldBuilds = ballPool.snapshot().worldBuilds;
      });
      await cold.waitForFunction(
        () => ballPool.snapshot().phase === "static-ready",
        null,
        { timeout: 180000 },
      );
      release();
      await cold.evaluate(() => ballPool.initialized);
      state = await cold.evaluate(() => ({
        state: ballPool.snapshot(),
        samePhysics: ballPool.physics === window.coldPhysics,
        previousBuilds: window.coldBuilds,
      }));
      check(
        "cold reset owns physics and world after delayed initial request",
        state.samePhysics &&
          state.previousBuilds === 1 &&
          state.state.worldBuilds === 1 &&
          state.state.descriptor.balls.length === 16 &&
          state.state.generation === state.state.worldGeneration &&
          state.state.generation === state.state.modelGeneration &&
          state.state.resources.physicsWasmReservedBytes > 0 &&
          state.state.resources.peakAdditionalBytes <= 64 * 1048576,
        state,
      );
      await cold.evaluate(() => ballPool.dispose());
      state.disposedGl = await cold.evaluate(() => glObserver.snapshot());
      check(
        "cold reset scene releases its GL resources",
        state.disposedGl.every((s) =>
          Object.values(s.live).every((n) => n === 0),
        ),
        state.disposedGl,
      );
    }
    check(
      `cold ${action} has no late rendering error`,
      !errors.length && !renderErrors.length,
      { errors, renderErrors },
    );
    return state;
  } finally {
    release();
    await cold.close();
  }
}
try {
  report.coldDisposal = await coldBootstrap("dispose");
  report.coldReset = await coldBootstrap("reset");
  await page.goto(
    "http://localhost:8090/demo/ballpool.html?diagnostic=1&count=64",
  );
  await page.waitForFunction(() => !!window.ballPool);
  report.startup = await page.evaluate(() => {
    const s = ballPool.snapshot();
    if (!ballPool.physics) ballPool.toss();
    return {
      physicsReady: !!ballPool.physics,
      tossEnabled: !document.getElementById("toss").disabled,
      phase: s.phase,
    };
  });
  await ready();
  report.environment = await environment(page, browser);
  report.initial = await page.evaluate(async () => {
    glObserver.phase("diagnostic");
    const { captureCurved } = await import("/demo/curved-diagnostics.js");
    return { state: ballPool.snapshot(), coverage: captureCurved(ballPool) };
  });
  check("one Cesium canvas", (await page.locator("canvas").count()) === 1);
  check(
    "default 64 balls own GI",
    report.initial.state.descriptor.balls.length === 64 &&
      report.initial.coverage.meanWeight >= 0.95,
    report.initial.coverage.meanWeight,
  );
  await page.screenshot({ path: out + "/static-64.png" });
  report.motion = await page.evaluate(() => {
    const old = ballPool.world,
      snapshot = old.finalGatherSnapshot,
      previous = ballPool.snapshot();
    glObserver.phase("production");
    ballPool.widget.useDefaultRenderLoop = false;
    ballPool.play();
    ballPool.toss();
    ballPool.step(80);
    ballPool.widget.render();
    return {
      state: ballPool.snapshot(),
      oldDestroyed: old.isDestroyed(),
      snapshotDestroyed: snapshot.isDestroyed(),
      fgTextures: ballPool.scene.lumen.finalGather._textures.length,
      enabled: ballPool.scene.lumen.enabled,
      hud: document.getElementById("metrics").textContent,
      movement: Math.max(
        ...ballPool.descriptor.balls.map((b, i) =>
          Math.hypot(
            ...b.position.map(
              (x, k) => x - previous.descriptor.balls[i].position[k],
            ),
          ),
        ),
      ),
      workers: workerAudit(),
    };
  });
  check(
    "motion immediately invalidates old local GI",
    report.motion.oldDestroyed &&
      report.motion.snapshotDestroyed &&
      !report.motion.enabled &&
      report.motion.fgTextures === 0 &&
      !report.motion.state.worldGeneration,
    report.motion,
  );
  check(
    "real finite physics interaction",
    report.motion.movement > 0.2,
    report.motion.movement,
  );
  check(
    "motion HUD reports no active receivers and zero actual FG rays",
    report.motion.hud.includes("无活动接收纹理") &&
      report.motion.hud.includes("实际 0r"),
    report.motion.hud,
  );
  await page.screenshot({ path: out + "/motion-64.png" });
  await page.evaluate(() => {
    ballPool.pause();
    ballPool.widget.useDefaultRenderLoop = true;
  });
  report.once = await page.evaluate(async () => {
    const before = ballPool.snapshot().worldBuilds,
      a = ballPool.freeze(),
      b = ballPool.freeze();
    const same = a === b;
    await Promise.all([a, b]);
    return { same, before, after: ballPool.snapshot().worldBuilds };
  });
  await ready();
  check(
    "one frozen pose starts one world rebuild",
    report.once.same && report.once.after - report.once.before === 1,
    report.once,
  );
  report.frozen = await page.evaluate(async () => {
    glObserver.phase("diagnostic");
    const s = ballPool.snapshot(),
      b = s.descriptor.balls.reduce((a, b) =>
        a.position[2] > b.position[2] ? a : b,
      ),
      w = ballPool.world;
    const centers = s.descriptor.balls.map((b) => {
      const m = ballPool.model.getNode(`ball-${b.ballId}`).matrix,
        p = ballPool.physics.bodies.get(b.ballId).translation();
      return {
        id: b.ballId,
        display: Math.hypot(...b.position.map((x, k) => x - m[12 + k])),
        physics: Math.hypot(
          b.position[0] - p.x,
          b.position[1] - p.y,
          b.position[2] - p.z,
        ),
      };
    });
    const gltf = await (await fetch(w.options.url)).json(),
      nodes = s.descriptor.balls.map((b) => ({
        id: b.ballId,
        frozen: Math.hypot(
          ...b.position.map(
            (x, k) =>
              x -
              gltf.nodes.find((n) => n.name === `ball-${b.ballId}`).translation[
                k
              ],
          ),
        ),
      }));
    const ray = {
        origin: [b.position[0], b.position[1], b.position[2] + b.radius + 0.1],
        direction: [0, 0, -1],
      },
      hit = (await w.trace([ray]))[0];
    const { captureCurved } = await import("/demo/curved-diagnostics.js");
    return {
      state: s,
      centers,
      nodes,
      hit,
      radiusError: hit.status === "Hit" ? Math.abs(hit.distance - 0.1) : null,
      coverage: captureCurved(ballPool),
      lighting: structuredClone(ballPool.lighting),
      physics: ballPool.physics.metrics(),
      workers: workerAudit(),
    };
  });
  check(
    "display physics frozen centers agree",
    report.frozen.centers.every((p) => p.display < 1e-6 && p.physics < 1e-6) &&
      report.frozen.nodes.every((p) => p.frozen < 1e-9),
    report.frozen.centers.slice(0, 2),
  );
  check(
    "world BVH contains current curved geometry",
    report.frozen.radiusError !== null && report.frozen.radiusError < 0.008,
    report.frozen.hit,
  );
  check(
    "generation revision and frozen coverage match",
    report.frozen.state.generation === report.frozen.state.worldGeneration &&
      report.frozen.state.generation === report.frozen.state.modelGeneration &&
      report.frozen.state.worldRevision ===
        report.frozen.state.snapshotRevision &&
      report.frozen.coverage.meanWeight >= 0.95,
    report.frozen.coverage.meanWeight,
  );
  await page.screenshot({ path: out + "/frozen-64.png" });
  const encoded = ballPoolGltf(report.frozen.state.descriptor),
    geometry = await loadGeometry(
      `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(encoded.gltf)).toString("base64")}`,
    ),
    bvh = new BVH(geometry, { strategy: "sah" });
  report.frozen.reference = report.frozen.coverage.points
    .slice(0, 16)
    .map((p, i) => ({
      ...p,
      reference: referenceIrradiance(
        bvh,
        p.position,
        p.normal,
        report.frozen.lighting,
        8192,
        3019 + i,
        p.geometricNormal,
      ),
    }));
  const numerator = report.frozen.reference.reduce(
      (s, p) =>
        s +
        p.E.reduce((v, x, k) => v + (x - p.reference.irradiance[k]) ** 2, 0),
      0,
    ),
    denominator = report.frozen.reference.reduce(
      (s, p) => s + p.reference.irradiance.reduce((v, x) => v + x * x, 0),
      0,
    );
  report.frozen.independentNRMSE = Math.sqrt(
    numerator / Math.max(0.00001, denominator),
  );
  check(
    "frozen 64-ball E matches independent integral",
    report.frozen.reference.length >= 12 &&
      report.frozen.independentNRMSE <= 0.2,
    report.frozen.independentNRMSE,
  );
  report.offscreen = await page.evaluate(async () => {
    const C = Cesium,
      d = ballPool,
      b = d.descriptor.balls[0],
      p = [b.position[0], b.position[1] + 0.7, 0.002],
      eye = C.Matrix4.multiplyByPoint(
        d.frame,
        C.Cartesian3.fromArray([p[0], p[1], 0.4]),
        new C.Cartesian3(),
      ),
      rotation = C.Matrix4.getMatrix3(d.frame, new C.Matrix3());
    d.scene.camera.setView({
      destination: eye,
      orientation: {
        direction: C.Matrix3.multiplyByVector(
          rotation,
          new C.Cartesian3(0, 0, -1),
          new C.Cartesian3(),
        ),
        up: C.Matrix3.multiplyByVector(
          rotation,
          C.Cartesian3.UNIT_Y,
          new C.Cartesian3(),
        ),
      },
    });
    const volume = d.scene.camera.frustum.computeCullingVolume(
        d.scene.camera.positionWC,
        d.scene.camera.directionWC,
        d.scene.camera.upWC,
      ),
      center = C.Matrix4.multiplyByPoint(
        d.frame,
        C.Cartesian3.fromArray(b.position),
        new C.Cartesian3(),
      ),
      outside =
        volume.computeVisibility(new C.BoundingSphere(center, b.radius)) ===
        C.Intersect.OUTSIDE,
      material = b.material,
      color = [...d.descriptor.materials[material].color],
      point = { position: p, normal: [0, 0, 1] },
      before = (
        await d.world.sampleFinalGather([point], {
          samples: 1024,
          seed: 19,
          sampling: "reconstructed",
          epoch: 5,
        })
      )[0];
    d.widget.useDefaultRenderLoop = true;
    await d.setMaterial(material, [0, 0, 0]);
    const after = (
      await d.world.sampleFinalGather([point], {
        samples: 1024,
        seed: 19,
        sampling: "reconstructed",
        epoch: 5,
      })
    )[0];
    const magnitude = Math.hypot(
      ...before.irradiance.map((x, k) => x - after.irradiance[k]),
    );
    await d.setMaterial(material, color);
    d.camera("overview");
    return { outside, point, material, color, before, after, magnitude };
  });
  await ready();
  check(
    "offscreen ball causally changes frozen receiver E",
    report.offscreen.outside &&
      report.offscreen.before.valid &&
      report.offscreen.after.valid &&
      report.offscreen.magnitude > 0.005,
    report.offscreen,
  );
  await page.evaluate(() => glObserver.phase("production"));
  await page.evaluate(() => ballPool.reset(16));
  await ready();
  report.countTransitions = [];
  for (const count of [64, 128, 16]) {
    const row = await page.evaluate(async (count) => {
      const old = ballPool.model;
      await ballPool.reset(count);
      const s = ballPool.snapshot();
      return {
        count,
        state: s,
        oldDestroyed: old.isDestroyed(),
        nodes: s.descriptor.balls.every(
          (b) => !!ballPool.model.getNode(`ball-${b.ballId}`),
        ),
        workers: workerAudit(),
      };
    }, count);
    await ready();
    report.countTransitions.push(row);
    check(
      `count switch to ${count} preserves descriptor/model/world`,
      row.oldDestroyed &&
        row.nodes &&
        row.state.descriptor.balls.length === count &&
        row.state.generation === row.state.modelGeneration &&
        row.state.generation === row.state.worldGeneration &&
        row.workers.localWorldWorkers === 1 &&
        row.state.resources.peakAdditionalBytes <= 64 * 1048576,
      row,
    );
  }
  report.cycles = [];
  for (let cycle = 0; cycle < 20; cycle++) {
    const row = await page.evaluate(async (cycle) => {
      ballPool.play();
      ballPool.step(2);
      ballPool.pause();
      const before = ballPool.snapshot();
      await ballPool.freeze();
      if (cycle % 5 === 4) await ballPool.reset(16);
      const s = ballPool.snapshot();
      return {
        cycle,
        generation: s.generation,
        worldGeneration: s.worldGeneration,
        modelGeneration: s.modelGeneration,
        history: s.historyFrames,
        resource: s.resources,
        workers: workerAudit(),
        oldWorldRemoved: before.worldGeneration === null,
      };
    }, cycle);
    await ready();
    report.cycles.push(row);
    check(
      `cycle ${cycle} is consistent`,
      row.generation === row.worldGeneration &&
        row.generation === row.modelGeneration &&
        row.workers.localWorldWorkers === 1 &&
        row.history <= 1 &&
        row.oldWorldRemoved &&
        row.resource.peakAdditionalBytes <= 64 * 1048576,
      row,
    );
    console.log(`Ball Pool lifecycle ${cycle + 1}/20`);
  }
  report.race = await page.evaluate(async () => {
    ballPool.play();
    ballPool.step(1);
    const old = ballPool.freeze();
    ballPool.play();
    ballPool.step(2);
    const latest = ballPool.freeze();
    const oldResult = await old;
    await latest;
    const s = ballPool.snapshot();
    return { oldResult, state: s, workers: workerAudit() };
  });
  await ready();
  check(
    "latest generation owns rapid requests",
    report.race.oldResult.cancelled &&
      report.race.state.generation === report.race.state.worldGeneration &&
      report.race.workers.localWorldWorkers === 1,
    report.race.oldResult,
  );
  report.relightRace = await page.evaluate(async () => {
    ballPool.play();
    ballPool.step(1);
    const building = ballPool.freeze();
    await ballPool.relight({ sunDirection: [1, -1, 0.8] });
    await building;
    const w = ballPool.world;
    return {
      world: w.options.sunDirection,
      display: ballPool.lighting.sunDirection,
      revision: w.requestedRevision,
      snapshot: w.finalGatherSnapshot.revision,
    };
  });
  await ready();
  check(
    "rebuild adopts latest lighting inputs",
    JSON.stringify(report.relightRace.world) ===
      JSON.stringify(report.relightRace.display) &&
      report.relightRace.revision === report.relightRace.snapshot,
    report.relightRace,
  );
  report.failure = await page.evaluate(async () => {
    ballPool.play();
    ballPool.pause();
    ballPool.injectBuildFailure();
    let message;
    try {
      await ballPool.freeze();
    } catch (e) {
      message = String(e);
    }
    return {
      message,
      state: ballPool.snapshot(),
      visible: ballPool.model.show,
      enabled: ballPool.scene.lumen.enabled,
    };
  });
  check(
    "failed rebuild remains a visible preview",
    report.failure.state.phase === "failed" &&
      !report.failure.enabled &&
      report.failure.visible &&
      !report.failure.state.worldGeneration,
    report.failure.message,
  );
  await page.evaluate(() => ballPool.freeze());
  await ready();
  await page.evaluate(() => {
    glObserver.phase("dispose");
    ballPool.dispose();
  });
  report.disposed = await page.evaluate(() => ({
    workers: workerAudit(),
    gl: glObserver.snapshot(),
  }));
  check(
    "scene disposal releases GL and owned world workers",
    report.disposed.workers.localWorldWorkers === 0 &&
      report.disposed.workers.localPeak === 1 &&
      report.disposed.gl.every((s) =>
        Object.values(s.live).every((n) => n === 0),
      ),
    report.disposed,
  );
  check(
    "production never synchronously reads GPU",
    report.disposed.gl.every((s) =>
      [
        "readPixels",
        "getBufferSubData",
        "finish",
        "waitSync",
        "blockingClientWaitSync",
      ].every((k) => !s.phases.production?.[k]),
    ),
    report.disposed.gl.map((s) => s.phases.production),
  );
  check(
    "rendering stayed healthy",
    !report.errors.length && !report.renderErrors.length,
    {
      errors: report.errors,
      renderErrors: report.renderErrors.map((s) => s.slice(0, 200)),
    },
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
} finally {
  await browser.close();
  await writeFile(out + "/ballpool.json", JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    checks: report.checks.length,
    coverage: report.frozen?.coverage.meanWeight,
    latency: report.frozen?.state.latencies.at(-1),
  }),
);
if (report.status !== "passed") process.exitCode = 1;
