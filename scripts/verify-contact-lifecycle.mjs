import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  sourceVersion,
  installGlObserver,
} from "./browser-tools.mjs";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  "reports/contact-transport-v9/lifecycle-first";
await mkdir(out, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion(["scripts/verify-contact-lifecycle.mjs"]),
    checks: [],
    errors: [],
  };
await page.addInitScript(installGlObserver);
page.on("pageerror", (e) => report.errors.push(String(e)));
const check = (name, value, detail) => {
  report.checks.push({ name, status: value ? "passed" : "failed", detail });
  assert(value, name + ": " + JSON.stringify(detail));
};
try {
  await page.goto(
    "http://localhost:8090/demo/ballpool.html?count=16&diagnostic=1",
  );
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  await page.evaluate(() => glObserver.phase("production"));
  const race = await page.evaluate(async () => {
    const first = ballPool.setRadianceSource("cache");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await ballPool.setRadianceSource("immediate");
    const latest = ballPool.setRadianceSource("cache");
    await first;
    const staleEnabled =
      ballPool.scene.lumen.enabled && !ballPool.world.surfaceCache?.ready;
    await latest;
    return {
      staleEnabled,
      state: ballPool.snapshot(),
      sourceReady: ballPool.world.surfaceCache?.matches(
        ballPool.world.finalGatherSnapshot,
      ),
    };
  });
  check(
    "superseded source cannot activate FG during latest cache build",
    !race.staleEnabled && race.sourceReady,
    race,
  );
  const relight = await page.evaluate(async () => {
    await ballPool.setRadianceSource("immediate");
    ballPool.world.surfaceCache.destroy();
    ballPool.world.surfaceCache = undefined;
    const source = ballPool.setRadianceSource("cache");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await ballPool.relight({ sunDirection: [1, -1, 0.3] });
    await source;
    return {
      matched: ballPool.world.surfaceCache?.matches(
        ballPool.world.finalGatherSnapshot,
      ),
      state: ballPool.snapshot(),
    };
  });
  check(
    "lighting revision owns final surface source",
    relight.matched,
    relight,
  );
  const finalYield = await page.evaluate(async () => {
    await ballPool.setRadianceSource("immediate");
    ballPool.world.surfaceCache.destroy();
    ballPool.world.surfaceCache = undefined;
    const original = setTimeout;
    let captured,
      triggered = false;
    window.setTimeout = function (fn, delay, ...args) {
      const c = ballPool.world?.surfaceCache;
      if (
        !triggered &&
        delay === 0 &&
        c &&
        !c.ready &&
        c.round === c.snapshot.round - 1 &&
        c.images
      ) {
        const v = ballPool.scene.context._gl.getParameter(
            ballPool.scene.context._gl.VIEWPORT,
          ),
          t = c.images[0].texture;
        if (v[0] === 0 && v[2] === t.width && v[1] + v[3] === t.height) {
          triggered = true;
          captured = c;
          return original(() => {
            ballPool.play();
            fn(...args);
          }, delay);
        }
      }
      return original(fn, delay, ...args);
    };
    try {
      await ballPool.setRadianceSource("cache");
    } finally {
      window.setTimeout = original;
    }
    return {
      triggered,
      destroyed: captured?.destroyed,
      ready: captured?.ready,
      enabled: captured?.enabled,
      state: ballPool.snapshot(),
    };
  });
  check(
    "cancel at final chunk cannot publish stale generation",
    finalYield.triggered &&
      finalYield.destroyed &&
      !finalYield.ready &&
      !finalYield.enabled &&
      finalYield.state.phase === "physics-preview",
    finalYield,
  );
  await page.evaluate(async () => {
    ballPool.step(8);
    ballPool.pause();
    await ballPool.freeze();
  });
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  const freeze = await page.evaluate(() => ({
    state: ballPool.snapshot(),
    matched: ballPool.world.surfaceCache?.matches(
      ballPool.world.finalGatherSnapshot,
    ),
  }));
  check(
    "freeze builds one matching geometry/source/history",
    freeze.matched && freeze.state.worldGeneration === freeze.state.generation,
    freeze,
  );
  for (const count of [64, 128, 16]) {
    await page.evaluate((count) => ballPool.reset(count), count);
    await page.waitForFunction(
      () => ballPool.snapshot().phase === "static-ready",
      null,
      { timeout: 180000 },
    );
    const state = await page.evaluate(() => ({
      state: ballPool.snapshot(),
      source: document.getElementById("sourceState").textContent,
      ready: !!ballPool.world.surfaceCache?.ready,
    }));
    check(
      `count ${count} respects 64MiB and safe source`,
      state.state.resources.peakAdditionalBytes <= 64 * 1048576 &&
        (count === 128
          ? !state.ready && state.source.includes("回退")
          : state.ready),
      state,
    );
  }
  const clean = await page.evaluate(() => {
    ballPool.dispose();
    return window.glObserver.snapshot();
  });
  check(
    "dispose releases owned GL resources",
    clean.every((s) => Object.values(s.live).every((v) => v === 0)),
    clean,
  );
  check(
    "no GL feedback",
    clean.every((s) => s.feedback.length === 0),
    clean.map((s) => s.feedback),
  );
  check(
    "no production synchronous readback",
    clean.every((s) =>
      [
        "readPixels",
        "getBufferSubData",
        "finish",
        "waitSync",
        "blockingClientWaitSync",
      ].every((k) => !s.phases.production?.[k]),
    ),
    clean.map((s) => s.phases.production),
  );
  check("no render errors", report.errors.length === 0, report.errors);
} catch (e) {
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser.close();
}
report.status = report.errors.length ? "failed" : "passed";
await writeFile(
  out + "/contact-lifecycle.json",
  JSON.stringify(report, null, 2),
  { flag: "wx" },
);
if (report.status !== "passed") process.exitCode = 1;
