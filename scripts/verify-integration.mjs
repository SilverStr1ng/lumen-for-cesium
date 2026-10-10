import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  launchBrowser,
  installGlObserver,
  sourceVersion,
} from "./browser-tools.mjs";
await mkdir("artifacts", { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 512, height: 384 } });
await page.addInitScript(installGlObserver);
const report = {
  version: sourceVersion(),
  mode: "numerical GPU readback",
  checks: [],
  errors: [],
  tolerance: { absolute: 2e-4, relative: 1e-3 },
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
    "http://localhost:8090/demo/regression.html?fixture=untextured&integrationComparison=1",
  );
  await page.waitForFunction(
    () => lumenTest?.world?.status === "ready" || lumenTest?.errors.length,
    null,
    { timeout: 120000 },
  );
  assert.deepEqual(await page.evaluate(() => lumenTest.errors), []);
  const result = await page.evaluate(async (tolerance) => {
    const d = lumenTest,
      w = d.world,
      g = w.packet.grid;
    glObserver.phase("numerical");
    await w.solve({ integrationMode: "arithmetic" });
    const a = w.snapshot();
    const hdr = () => {
      d.widget.render();
      d.widget.render();
      return w._read(
        d.scene._view.sceneFramebuffer._colorFramebuffer.framebuffer,
        d.scene.drawingBufferWidth,
        d.scene.drawingBufferHeight,
      );
    };
    const ah = hdr();
    await w.solve({ integrationMode: "lut" });
    const b = w.snapshot(),
      bh = hdr();
    const compare = (a, b) => {
      let maximum = 0,
        failures = 0;
      for (let i = 0; i < a.length; i++) {
        const error = Math.abs(a[i] - b[i]);
        maximum = Math.max(maximum, error);
        if (error > tolerance.absolute + tolerance.relative * Math.abs(a[i]))
          failures++;
      }
      return { maximum, failures };
    };
    const border = (field) => {
      let mismatches = 0,
        checked = 0;
      const offset = (p, x, y) =>
        ((Math.floor(p / (g.counts[0] * g.counts[1])) * 10 + y) * g.width +
          (p % (g.counts[0] * g.counts[1])) * 10 +
          x) *
        4;
      for (let p = 0; p < g.total; p++)
        for (let y = 0; y < 10; y++)
          for (let x = 0; x < 10; x++)
            if (x === 0 || x === 9 || y === 0 || y === 9) {
              let a = x,
                b = y;
              if (x === 0 && y === 0) {
                a = 8;
                b = 8;
              } else if (x === 9 && y === 0) {
                a = 1;
                b = 8;
              } else if (x === 0 && y === 9) {
                a = 8;
                b = 1;
              } else if (x === 9 && y === 9) {
                a = 1;
                b = 1;
              } else if (x === 0) {
                a = 1;
                b = 9 - y;
              } else if (x === 9) {
                a = 8;
                b = 9 - y;
              } else if (y === 0) {
                a = 9 - x;
                b = 1;
              } else if (y === 9) {
                a = 9 - x;
                b = 8;
              }
              for (let c = 0; c < 4; c++) {
                if (field[offset(p, x, y) + c] !== field[offset(p, a, b) + c])
                  mismatches++;
                checked++;
              }
            }
      return { mismatches, checked };
    };
    const position = d.metadata.receivers[0].position,
      seams = [];
    for (const pair of [
      [
        [1, 1e-6, -1],
        [1, -1e-6, -1],
      ],
      [
        [1e-6, 1, -1],
        [-1e-6, 1, -1],
      ],
      [
        [1e-6, 1e-6, -1],
        [-1e-6, -1e-6, -1],
      ],
    ]) {
      const samples = await w.sample(
        pair.map((normal) => ({ position, normal })),
      );
      seams.push(
        Math.max(
          ...samples[0].irradiance.map((v, i) =>
            Math.abs(v - samples[1].irradiance[i]),
          ),
        ),
      );
    }
    return {
      E: compare(a.irradiance, b.irradiance),
      HDR: compare(ah, bh),
      moments: compare(a.moments, b.moments),
      borderE: border(b.irradiance),
      borderM: border(b.moments),
      seams,
      packet: w.packet.integration,
      memory: w.metrics.memory,
      gl: glObserver.snapshot(),
    };
  }, report.tolerance);
  check(
    "arithmetic and LUT produce matching fixed-input E and final HDR",
    result.E.failures === 0 && result.HDR.failures === 0,
    result,
  );
  check(
    "every octahedral border is an exact mirror without cross-probe reads",
    result.borderE.mismatches === 0 &&
      result.borderM.mismatches === 0 &&
      result.borderE.checked > 0,
    result,
  );
  check(
    "sampling is continuous across octahedral seams",
    result.seams.every((x) => x < 5e-4),
    result.seams,
  );
  check(
    "distance moments remain unchanged across integration variants",
    result.moments.maximum === 0,
    result.moments,
  );
  check(
    "copying uses distinct GL images and bounded owned resources",
    result.gl.every((x) => x.feedback.length === 0 && x.errors.length === 0) &&
      result.memory.currentBytes === result.memory.peakBytes &&
      report.errors.length === 0,
    result.gl,
  );
  report.result = result;
} finally {
  await writeFile(
    process.env.LUMEN_REPORT ?? "artifacts/integration-verification.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
