import { readFile, writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const reference = JSON.parse(
  await readFile(
    "reports/ddgi-visual-quality-v4/independent-reference.json",
    "utf8",
  ),
);
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  const points = Object.values(reference.scans).flat();
  const result = await p.evaluate(async (points) => {
    const w = earthLab.world,
      rows = [];
    for (const bias of [0.15, 0.075, 0.02, 0.005]) {
      w.normalBias = bias;
      await w.solve({
        sunDirection: w.options.sunDirection,
        sunRadiance: w.options.sunRadiance,
        skyRadiance: w.options.skyRadiance,
        bounces: 3,
      });
      rows.push({ bias, samples: await w.sample(points) });
    }
    return rows;
  }, points);
  for (const row of result) {
    let cursor = 0;
    row.rmse = {};
    for (const [name, pts] of Object.entries(reference.scans)) {
      const differences = pts.flatMap((pt) => {
        const sample = row.samples[cursor++];
        return pt.E.map((v, k) => sample.irradiance[k] - v);
      });
      row.rmse[name] = Math.sqrt(
        differences.reduce((s, v) => s + v * v, 0) / differences.length,
      );
    }
  }
  const report = {
    version: sourceVersion(),
    scope:
      "diagnostic sweep of geometric normal bias only; same relocated geometry/moments, each raw 3-bounce solve regenerated; no display ambient/exposure change",
    result,
  };
  await writeFile(
    "reports/ddgi-visual-quality-v4/bias-sweep.json",
    JSON.stringify(report, null, 2),
  );
  console.log(result.map((r) => ({ bias: r.bias, rmse: r.rmse })));
} finally {
  await b.close();
}
