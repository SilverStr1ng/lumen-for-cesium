import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("PAGEERROR", String(e).slice(0, 2000));
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 2000));
});
page.on("response", (r) => {
  if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
});
try {
  await page.goto("http://localhost:8090", { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(
      () => window.lumenDemo?.ready || window.lumenDemo?.errors.length,
      null,
      { timeout: 90000 },
    );
  } catch (e) {
    console.log(
      "STATE",
      await page.evaluate(() => ({
        status: document.getElementById("status").textContent,
        error: document.getElementById("error").textContent,
        ready: window.lumenDemo?.model?.ready,
        state: window.lumenDemo?.model?._loader?._state,
        loop: window.lumenDemo?.widget.useDefaultRenderLoop,
      })),
    );
    throw e;
  }
  await page.waitForTimeout(1000);
  console.log(
    await page.evaluate(() => {
      const d = window.lumenDemo;
      const gl = d.scene.context._gl;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        ready: d.ready,
        errors: d.errors,
        status: document.getElementById("status").textContent,
        radius: d.model?.boundingSphere.radius,
        renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
        defines:
          d.model?._sceneGraph?._runtimeNodes?.[0]?.runtimePrimitives?.[0]
            ?.primitiveRenderResources?.shaderBuilder?._fragmentShaderParts
            ?.defineLines,
      };
    }),
  );
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await page.screenshot({
    path: new URL(
      "../artifacts/sponza-final.png",
      import.meta.url,
    ).pathname.slice(1),
  });
  await page.selectOption("#mode", "albedo");
  await page.waitForTimeout(500);
  await page.screenshot({
    path: new URL(
      "../artifacts/sponza-albedo.png",
      import.meta.url,
    ).pathname.slice(1),
  });
  await writeFile(
    new URL("../artifacts/smoke-errors.json", import.meta.url),
    JSON.stringify(errors, null, 2),
  );
  console.log(
    "MANUAL",
    await page.evaluate(() => {
      const d = lumenDemo,
        s = d.scene;
      d.widget.useDefaultRenderLoop = false;
      const states = [];
      for (let i = 0; i < 5; i++) {
        d.widget.resize();
        d.widget.render();
        states.push({
          gfrustums: s.gBuffer.frustums,
          viewFrustums: s._view.frustumCommandsList.length,
          commands: s.frameState.commandList.length,
          frame: s.frameState.frameNumber,
          mode: s.mode,
          ready: d.model.ready,
          show: d.model.show,
        });
      }
      return states;
    }),
  );
} finally {
  await browser.close();
}
