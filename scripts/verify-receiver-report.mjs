import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { launchBrowser } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
let status = "failed",
  failure;
p.on("pageerror", (e) => errors.push(String(e)));
try {
  await p.goto(
    "http://localhost:8090/reports/receiver-final-gather-v5/index.html",
  );
  await p.waitForFunction(() =>
    document.querySelector("#points tr:nth-child(50)"),
  );
  assert((await p.locator("#status").textContent()).includes("回归 passed"));
  await p.selectOption("#camera", "pillarFoot");
  await p.selectOption("#case", "5");
  assert.equal(await p.locator("#points tr").count(), 50);
  assert.equal(await p.locator("#errors tr").count(), 7);
  await p.locator("#play").click();
  await p.waitForTimeout(1100);
  assert((await p.locator("#step").textContent()).includes("step 1"));
  await p.screenshot({
    path: "reports/receiver-final-gather-v5/report-preview.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  status = "passed";
  console.log(
    "passed report gallery, all49-point table, held-out selector and sequence",
  );
} catch (e) {
  failure = String(e);
  process.exitCode = 1;
  console.error(failure);
} finally {
  await b.close();
  await writeFile(
    "reports/receiver-final-gather-v5/report-ui.json",
    JSON.stringify({ errors, status, failure }, null, 2),
  );
}
