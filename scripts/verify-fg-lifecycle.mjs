import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const report = { version: sourceVersion(), checks: [], errors: [], notRun: [] };
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on("pageerror", (e) => report.errors.push(String(e)));
await p.addInitScript(installGlObserver);
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=high&fgSampling=reconstructed",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  report.cycles = await p.evaluate(async () => {
    const d = earthLab,
      f = d.scene.lumen.finalGather,
      C = Cesium,
      cycles = [];
    d.widget.useDefaultRenderLoop = false;
    d.camera("boxFoot");
    const pump = async () => {
      const start = performance.now();
      while (d.world?.status !== "ready") {
        d.widget.render();
        await new Promise(requestAnimationFrame);
        if (performance.now() - start > 180000) throw Error("world timeout");
      }
    };
    for (let i = 0; i < 20; i++) {
      d.widget.resolutionScale = i % 2 ? 0.9 : 1;
      d.widget.resize();
      d.scene.msaaSamples = i % 2 ? 4 : 1;
      const configured = f.configure({
        mode: "fg",
        quality: "high",
        sampling: "reconstructed",
        model: d.model,
      });
      while (
        d.world.requestedRevision !== d.world.settledRevision ||
        !d.world.finalGatherSnapshot
      ) {
        d.widget.render();
        await new Promise(requestAnimationFrame);
      }
      await configured;
      await pump();
      d.widget.render();
      const r = f.reconstruction;
      if (!r) throw Error(f.metrics.status);
      const resources = [...r._textures, ...r._framebuffers],
        snapshot = d.world.finalGatherSnapshot;
      await f.configure({ mode: "ddgi" });
      d.widget.render();
      if (resources.some((x) => !x.isDestroyed()))
        throw Error("history resources retained after disable");
      if (f._textures.length || f._framebuffers.length || f.metrics.memoryBytes)
        throw Error("FG resources retained");
      // Rebuild the static world and ensure old geometry, snapshots and owner identity close.
      const old = d.world;
      const loading = d.reload();
      let loaded = false;
      loading.then(() => (loaded = true));
      while (!loaded) {
        d.widget.render();
        await new Promise(requestAnimationFrame);
      }
      await loading;
      while (d.world === old || !d.world?.ready) {
        d.widget.render();
        await new Promise(requestAnimationFrame);
      }
      await pump();
      d.widget.render();
      console.log("resource cycle " + i);
      cycles.push({
        i,
        oldDestroyed: old.isDestroyed(),
        oldTextures: old._textures.length,
        oldSnapshots: old._fgSnapshots.size,
        historyDestroyed: resources.every((x) => x.isDestroyed()),
        ownedFGBytes: f.metrics.memoryBytes,
        worldBytes: d.world.memoryBytes,
        live: glObserver.snapshot()[0].live,
      });
    }
    return cycles;
  });
  assert(
    report.cycles.every(
      (x) =>
        x.oldDestroyed &&
        x.oldTextures === 0 &&
        x.oldSnapshots === 0 &&
        x.historyDestroyed &&
        x.ownedFGBytes === 0,
    ),
  );
  report.checks.push({
    name: "20 enable resize AA disable and world reload cycles",
    status: "passed",
  });
  report.fbo = await p.evaluate(() => {
    const d = earthLab,
      gl = d.scene.context._gl,
      f = d.scene.lumen.finalGather,
      C = Cesium;
    const r = new C.LumenFinalGatherReconstruction(f),
      before = glObserver.snapshot()[0].live,
      binding = d.scene.context._currentFramebuffer;
    const old = gl.checkFramebufferStatus;
    gl.checkFramebufferStatus = function (target) {
      if (r._framebuffers.length) return gl.FRAMEBUFFER_UNSUPPORTED;
      return old.call(gl, target);
    };
    let rejected = false,
      error;
    try {
      r.update(64, 64);
    } catch (e) {
      rejected = true;
      error = String(e);
    } finally {
      gl.checkFramebufferStatus = old;
    }
    const result = {
      rejected,
      error,
      textures: r._textures.length,
      framebuffers: r._framebuffers.length,
      bindingRestored: d.scene.context._currentFramebuffer === binding,
      before,
      after: glObserver.snapshot()[0].live,
    };
    r.destroy();
    return result;
  });
  assert(report.fbo.rejected && report.fbo.bindingRestored);
  assert.equal(report.fbo.textures, 0);
  assert.equal(report.fbo.framebuffers, 0);
  assert.equal(report.fbo.before.textures, report.fbo.after.textures);
  assert.equal(report.fbo.before.framebuffers, report.fbo.after.framebuffers);
  report.checks.push({
    name: "history MRT allocation rollback and binding restore",
    status: "passed",
  });
  const loss = await p.evaluate(() => {
    const d = earthLab,
      e = d.scene.context._gl.getExtension("WEBGL_lose_context");
    if (!e) return { supported: false };
    d.widget.useDefaultRenderLoop = false;
    e.loseContext();
    return { supported: true };
  });
  if (loss.supported) {
    await p.waitForTimeout(100);
    const lost = await p.evaluate(() =>
      earthLab.scene.context._gl.isContextLost(),
    );
    assert(lost);
    await p.reload();
    await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
      timeout: 180000,
    });
    const rebuilt = await p.evaluate(() => {
      earthLab.camera("boxFoot");
      earthLab.widget.render();
      return {
        lost: earthLab.scene.context._gl.isContextLost(),
        ready: earthLab.scene.lumen.finalGather.ready,
      };
    });
    assert(!rebuilt.lost && rebuilt.ready);
    report.checks.push({
      name: "real context loss then explicit fresh Scene rebuild",
      status: "passed",
      evidence: { loss, lost, rebuilt },
    });
  } else
    report.notRun.push({
      name: "actual context loss",
      reason: "WEBGL_lose_context unavailable",
    });
  // Actual Chromium freeze/resume lifecycle; OS-level background scheduling remains distinct.
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await new Promise((r) => setTimeout(r, 120));
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  const resumed = await p.evaluate(() => {
    earthLab.widget.render();
    return {
      ready: earthLab.scene.lumen.finalGather.ready,
      revision: earthLab.scene.lumen.finalGather.metrics.revision,
      requested: earthLab.world.requestedRevision,
    };
  });
  assert(resumed.ready && resumed.revision === resumed.requested);
  report.checks.push({
    name: "Chromium page frozen/active restore uses matching source",
    status: "passed",
    evidence: resumed,
  });
  report.notRun.push({
    name: "native WebGL resource restoration without rebuilding Scene",
    reason:
      "explicit fresh Scene rebuild tested; engine does not promise native restoration",
  });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await b.close();
  await writeFile(
    "reports/fg-reconstruction-showcase-v6/lifecycle.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks,
    error: report.error,
  }),
);
