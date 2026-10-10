import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (
    m.type() === "error" ||
    /feedback loop|INVALID_OPERATION|CONTEXT_LOST/.test(m.text())
  )
    errors.push(m.text());
});
const report = {
  version: sourceVersion(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  mode: "numerical diagnostics; includes explicit GPU readback",
  checks: [],
  fixtures: {},
  errors,
  tolerances: {
    irradiance: { absolute: 2e-4, relative: 1e-3 },
    moments: { absolute: 2e-4, relative: 1e-4 },
  },
};
const check = (name, condition, details) => {
  report.checks.push({ name, passed: !!condition, details });
  assert.ok(condition, name);
  console.log("PASS", name);
};
async function ready() {
  await page.waitForFunction(
    () =>
      window.lumenTest?.world?.status === "ready" ||
      window.lumenTest?.errors.length,
    null,
    { timeout: 120000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
}
async function load(name) {
  await page.goto(`http://localhost:8090/demo/regression.html?fixture=${name}`);
  await ready();
  await page.evaluate(() => glObserver.phase("numerical"));
}
try {
  for (const name of ["untextured", "two-rooms", "alpha-mask"]) {
    await load(name);
    const result = await page.evaluate(async () => {
      const w = lumenTest.world,
        s = w.snapshot(),
        h = w._read(w._hitFB, s.grid.rays, s.grid.total),
        samples = await w.sample(lumenTest.metadata.receivers);
      let active = 0,
        unknown = 0,
        hits = 0;
      for (let i = 3; i < s.positions.length; i += 4)
        if (s.positions[i] > 0.5) active++;
      for (let i = 0; i < h.length; i += 4) {
        if (h[i] === -1) unknown++;
        if (Math.abs(h[i]) > 1) hits++;
      }
      return {
        backend: w.constructor.name,
        grid: s.grid,
        active,
        unknown,
        hits,
        samples,
        atlas: [w._atlas.width, w._atlas.height],
        memoryBytes: w.memoryBytes,
        allocatedBytes: w._textures.reduce((sum, t) => sum + t.sizeInBytes, 0),
        metrics: w.metrics,
        field: Array.from(s.irradiance),
        moments: Array.from(s.moments),
      };
    });
    if (process.env.LUMEN_BASELINE_DIR) {
      const baseline = JSON.parse(
        await readFile(
          `${process.env.LUMEN_BASELINE_DIR}/${name}.json`,
          "utf8",
        ),
      );
      for (const [field, tolerance] of Object.entries(report.tolerances)) {
        const actual = field === "irradiance" ? result.field : result.moments;
        assert.equal(actual.length, baseline[field].length);
        let maximumAbsolute = 0,
          failures = 0;
        actual.forEach((v, i) => {
          const error = Math.abs(v - baseline[field][i]);
          maximumAbsolute = Math.max(maximumAbsolute, error);
          if (
            error >
            tolerance.absolute +
              tolerance.relative * Math.abs(baseline[field][i])
          )
            failures++;
        });
        check(
          `${name}: ${field} agrees with frozen R0 input/result`,
          failures === 0,
          { maximumAbsolute, failures, tolerance },
        );
      }
    }
    if (process.env.LUMEN_SAVE_BASELINE_DIR) {
      await mkdir(process.env.LUMEN_SAVE_BASELINE_DIR, { recursive: true });
      await writeFile(
        `${process.env.LUMEN_SAVE_BASELINE_DIR}/${name}.json`,
        JSON.stringify({
          grid: result.grid,
          irradiance: result.field,
          moments: result.moments,
        }),
      );
    }
    delete result.field;
    delete result.moments;
    report.fixtures[name] = result;
    check(
      `${name}: actual WebGL2 GPU world, valid probes and nonempty geometry`,
      result.backend === "LumenGpuWorld" &&
        result.active > 0 &&
        result.hits > 0 &&
        result.unknown === 0,
      result,
    );
    check(
      `${name}: finite HDR irradiance and accounted texture memory`,
      result.samples.every(
        (s) => s.coverage > 0 && s.irradiance.every(Number.isFinite),
      ) && result.memoryBytes === result.allocatedBytes,
      result.samples,
    );
    if (name === "untextured") {
      check(
        "untextured: valid 1x1 material atlas",
        result.atlas[0] === 1 && result.atlas[1] === 1,
        result.atlas,
      );
      const response = await page.evaluate(async () => {
        const w = lumenTest.world,
          point = lumenTest.metadata.receivers;
        await w.solve({ sunRadiance: [0, 0, 0], skyRadiance: [0.1, 0.1, 0.1] });
        const low = await w.sample(point);
        await w.solve({ skyRadiance: [0.8, 0.8, 0.8] });
        const high = await w.sample(point);
        return {
          low,
          high,
          revision: w.packet.revision,
          updates: w.metrics.updates,
        };
      });
      check(
        "sky lighting produces actual receiver irradiance changes",
        response.high[0].irradiance.every(
          (v, i) => v > response.low[0].irradiance[i] + 0.1,
        ),
        response,
      );
      const unknown = await page.evaluate(() =>
        lumenTest.world.trace([
          { origin: [0, 0, 1], direction: [0, 0, 1], budget: 1 },
        ]),
      );
      check(
        "exhausted GPU traversal is Unknown",
        unknown[0].status === "Unknown",
        unknown,
      );
    }
    if (name === "two-rooms") {
      const wall = await page.evaluate(async () => {
        const w = lumenTest.world,
          r = lumenTest.metadata.crossingRay;
        const trace = await w.trace([r]),
          reference = await w.referenceTrace([r]);
        await w.solve({ sunRadiance: [0, 0, 0], skyRadiance: [0, 0, 0] });
        return {
          trace,
          reference,
          samples: await w.sample(lumenTest.metadata.receivers),
        };
      });
      check(
        "two-rooms: real wall agrees with independent CPU intersection",
        wall.trace[0].status === "Hit" &&
          Math.abs(wall.trace[0].distance - 1.42) < 1e-4 &&
          Math.abs(wall.trace[0].distance - wall.reference[0].distance) < 1e-4,
        wall,
      );
      check(
        "two-rooms: wall blocks red emissive transport",
        wall.samples[0].irradiance[0] > 0.01 &&
          wall.samples[1].irradiance[0] <
            wall.samples[0].irradiance[0] * 0.1 + 1e-4,
        wall.samples,
      );
    }
    if (name === "alpha-mask") {
      const masked = await page.evaluate(async () => {
        const w = lumenTest.world,
          r = lumenTest.metadata.rays,
          trace = await w.trace(r),
          reference = await w.referenceTrace(r);
        await w.solve({ sunRadiance: [0, 0, 0], skyRadiance: [0, 0, 0] });
        const s = w.snapshot();
        return {
          trace,
          reference,
          blackMaximum: Math.max(...s.irradiance.filter((_, i) => i % 4 !== 3)),
          coverage: (await w.sample(lumenTest.metadata.receivers))[0].coverage,
        };
      });
      check(
        "alpha mask: transparent texel passes through; opaque texel occludes",
        masked.trace.every(
          (h, i) =>
            h.status === "Hit" &&
            Math.abs(h.distance - [2, 1][i]) < 1e-4 &&
            Math.abs(h.distance - masked.reference[i].distance) < 1e-4,
        ),
        masked,
      );
      check(
        "black light preserves valid coverage and zero irradiance",
        masked.blackMaximum === 0 && masked.coverage > 0.5,
        masked,
      );
      const recovery = await page.evaluate(async () => {
        const old = lumenTest.world;
        old.destroy();
        const released = {
          memory: old.memoryBytes,
          textures: old._textures.length,
          framebuffers: old._framebuffers.length,
          queries: old._queries.length,
          closed: old.isDestroyed(),
        };
        const next = lumenTest.load();
        await next.completed;
        return { released, ready: next.ready, resources: next.metrics.memory };
      });
      check(
        "destroy releases owned resources and reload restores GPU lighting",
        Object.values(recovery.released).every((x) => x === 0 || x === true) &&
          recovery.ready,
        recovery,
      );
    }
    report.fixtures[name].environment = await environment(page, browser);
    const observed = await page.evaluate(() => glObserver.snapshot());
    check(
      `${name}: GL has no framebuffer feedback or errors`,
      observed.every((s) => s.feedback.length === 0 && s.errors.length === 0),
      observed,
    );
  }
  check(
    "no render, worker, browser or GL exceptions",
    errors.length === 0,
    errors,
  );
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/fixture-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
