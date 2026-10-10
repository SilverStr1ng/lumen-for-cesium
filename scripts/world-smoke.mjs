import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../cesium-1.146/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const executablePath = [
  process.env.LUMEN_CHROME,
  chromium.executablePath(),
  "C:/Users/rakuy/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
page.on("pageerror", (e) => console.log("PAGE ERROR", String(e)));
page.on("console", (m) => {
  if (m.type() === "error") console.log(m.text());
});
try {
  await page.goto("http://localhost:8090");
  await page.waitForFunction(
    () => lumenDemo?.scene.lumen.world || lumenDemo?.errors.length,
    null,
    { timeout: 90000 },
  );
  for (let i = 0; i < 90; i++) {
    const s = await page.evaluate(() => ({
      status: lumenDemo.scene.lumen.world?.status,
      progress: lumenDemo.scene.lumen.world?.progress,
      ready: lumenDemo.scene.lumen.world?.ready,
      errors: lumenDemo.errors,
    }));
    console.log(JSON.stringify(s));
    if (s.errors.length) throw new Error(s.errors.join("\n"));
    if (s.status === "ready" && s.ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const report = await page.evaluate(() => {
    const w = lumenDemo.scene.lumen.world;
    return {
      status: w.status,
      grid: w.packet?.grid,
      cache: w.packet?.cache,
      bvh: w.packet?.bvh,
      active: w.packet?.active,
      history: w.packet?.history,
      errors: lumenDemo.errors,
    };
  });
  await writeFile(
    "artifacts/world-smoke.json",
    JSON.stringify(report, null, 2),
  );
  await page.screenshot({ path: "artifacts/sponza-ddgi.png" });
  await page.selectOption("#mode", "indirect");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "artifacts/sponza-ddgi-indirect.png" });
  console.log(
    JSON.stringify(
      {
        status: report.status,
        grid: report.grid,
        bvh: report.bvh,
        history: report.history,
        active: report.active,
        surfels: report.cache?.surfels,
        errors: report.errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
