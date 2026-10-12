import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
import { mkdir, writeFile } from "node:fs/promises";
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-"),
  out = `reports/globe-visibility-v3/placement-${stamp}`;
await mkdir(out, { recursive: true });
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const report = { version: sourceVersion(), snapshots: [] };
const measure = async (label) => {
  const data = await p.evaluate(() => {
    const d = earthLab,
      C = Cesium,
      g = d.scene.globe;
    return {
      tilesLoaded: g.tilesLoaded,
      anchor: { ...d.anchor },
      samples: [
        [0, 0],
        [-12, -9],
        [-12, 9],
        [12, -9],
        [12, 9],
      ].map(([x, y]) => {
        const point = C.Matrix4.multiplyByPoint(
            d.frame,
            new C.Cartesian3(x, y, -1.5),
            new C.Cartesian3(),
          ),
          cartographic = C.Cartographic.fromCartesian(point),
          terrain = g.getHeight(cartographic),
          tiles = g._surface._tilesToRender
            .filter((t) => C.Rectangle.contains(t.rectangle, cartographic))
            .map((t) => ({
              level: t.level,
              x: t.x,
              y: t.y,
              mesh: !!t.data?.mesh,
            }));
        return {
          x,
          y,
          baseEllipsoidHeight: cartographic.height,
          renderedTerrainHeight: terrain,
          gap: cartographic.height - terrain,
          tiles,
        };
      }),
      renderTiles: g._surface._tilesToRender.length,
      errors: d.errors,
    };
  });
  report.snapshots.push({ label, ...data });
  await p.screenshot({ path: `${out}/${label}.png` });
  console.log(label, JSON.stringify(data));
};
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  await p.evaluate(() => {
    earthLab.camera("context");
    window.stableFrames = 0;
  });
  await p.waitForTimeout(1000);
  await measure("after-1-second");
  await p.waitForFunction(
    () => {
      stableFrames = earthLab.scene.globe.tilesLoaded ? stableFrames + 1 : 0;
      return stableFrames >= 10;
    },
    null,
    { polling: "raf", timeout: 60000 },
  );
  await measure("stable-10-frames");
  await p.waitForTimeout(5000);
  await measure("stable-plus-5-seconds");
  await p.evaluate(() => {
    earthLab.scene.shadowMap.normalOffset = false;
    earthLab.widget.render();
    earthLab.widget.render();
  });
  await measure("normal-offset-disabled");
} finally {
  await writeFile(`${out}/placement.json`, JSON.stringify(report, null, 2));
  await b.close();
}
