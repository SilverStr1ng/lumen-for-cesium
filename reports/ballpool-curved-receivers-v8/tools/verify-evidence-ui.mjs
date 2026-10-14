import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser } from "../../../scripts/browser-tools.mjs";
const output =
  process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
  "reports/ballpool-curved-receivers-v8/evidence-ui-final";
await mkdir(output, { recursive: true });
const browser = await launchBrowser(),
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
  errors = [],
  report = { checks: [], errors };
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
try {
  await page.goto(
    "http://localhost:8090/reports/ballpool-curved-receivers-v8/index.html",
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#states tr").length === 16,
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#desktop tr").length === 7,
  );
  assert.match(await page.locator("#summary").innerText(), /recommended=false/);
  assert.match(await page.locator("#freeze").innerText(), /10\.10%/);
  assert.equal(await page.locator("#shots img").count(), 3);
  assert(
    await page
      .locator("#shots img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0),
      ),
  );
  for (const config of [
    "original/static",
    "original/moving",
    "original/relight",
    "gallery/static",
    "gallery/moving",
    "gallery/relight",
    "ballpool/static",
  ]) {
    await page.locator("#configuration").selectOption(config);
    await page.waitForTimeout(300);
    const text = await page.locator("#cost").innerText();
    assert(!text.includes("not-run"), config);
    assert(text.includes("无活动FG / 0r"), config);
    report.checks.push({ name: config, status: "passed" });
  }
  report.summary = await page.locator("#summary").innerText();
  report.freeze = await page.locator("#freeze").innerText();
  report.curves = await page.locator("#curves").innerText();
  await page.screenshot({ path: output + "/page.png", fullPage: true });
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(output + "/ui.json", JSON.stringify(report, null, 2), {
    flag: "wx",
  });
}
console.log(JSON.stringify(report));
