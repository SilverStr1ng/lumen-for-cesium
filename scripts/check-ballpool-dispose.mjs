import { launchBrowser, installGlObserver } from "./browser-tools.mjs";
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 640, height: 400 } });
try {
  await page.addInitScript(installGlObserver, { resourceStacks: true });
  await page.goto("http://localhost:8090/demo/ballpool.html?count=1");
  await page.waitForFunction(
    () => ballPool.snapshot().phase === "static-ready",
    null,
    { timeout: 180000 },
  );
  const result = await page.evaluate(() => {
    ballPool.dispose();
    return glObserver.snapshot();
  });
  console.log(JSON.stringify(result));
  if (result.some((s) => Object.values(s.live).some((n) => n > 0)))
    process.exitCode = 1;
} finally {
  await browser.close();
}
