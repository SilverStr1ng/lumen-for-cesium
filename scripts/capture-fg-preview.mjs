import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser } from "./browser-tools.mjs";
const out = "reports/fg-reconstruction-showcase-v6/preview";
await mkdir(out, { recursive: true });
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
  rows = [];
try {
  await p.goto(
    "http://localhost:8090/demo/globe.html?diagnostic=1&fg=fg&fgQuality=high&fgSampling=reconstructed",
  );
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.addStyleTag({
    content: "aside,footer,.cesium-widget-credits{display:none!important}",
  });
  await p.evaluate(async () => {
    await earthLab.world.completed;
    earthLab.widget.useDefaultRenderLoop = false;
  });
  for (const camera of ["boxFoot", "pillarFoot", "ceiling"]) {
    await p.evaluate((name) => {
      const d = earthLab,
        f = d.scene.lumen.finalGather;
      d.camera(name);
      f._historyWorld = undefined;
      f._stableFrames = 0;
      f._sampleEpoch = 0;
      d.world.setDisplayTransition(0);
      for (let i = 0; i < 32; i++) d.widget.render();
    }, camera);
    const row = await p.evaluate(() => ({
      ready: earthLab.scene.lumen.finalGather.ready,
      metrics: {
        ...earthLab.scene.lumen.finalGather.metrics,
        stages: undefined,
        completedTimings: undefined,
      },
    }));
    row.settings = await p.evaluate(() => earthLab.saveView());
    assert(row.ready, row.metrics.status);
    rows.push({ camera, ...row });
    await p.screenshot({ path: out + "/" + camera + "-32.png" });
  }
  await writeFile(
    out + "/data.json",
    JSON.stringify({ status: "executed", rows }, null, 2),
  );
} finally {
  await b.close();
}
