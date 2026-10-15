import { mkdir } from "node:fs/promises";
import path from "node:path";
import ResourceBudget from "../lumen/resource-budget.js";
import { FrozenResourceCache } from "../lumen/frozen-resources.js";
import { loadDatasetGeometry } from "../lumen/local-dataset.js";
export const pilotBase = () =>
  process.env.LUMEN_PILOT_BASE ?? "http://localhost:8090/demo/";
export async function newOutput(kind) {
  const output =
    process.env.LUMEN_REPORT_DIRECTORY ??
    `reports/local-gi-pilot-stabilization-v11/${kind}-${new Date().toISOString().replaceAll(":", "-")}`;
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  await mkdir(output); // Never reuse a directory or partially overwrite an old run.
  return output;
}
export async function referenceDataset() {
  const uri = new URL("../fixtures/local-pilot/dataset.json", pilotBase()).href;
  const budget = new ResourceBudget(),
    cache = new FrozenResourceCache(budget),
    scope = cache.scope();
  budget.refresh = () => budget.observe(cache.allocations());
  try {
    const manifest = await scope.manifest(uri);
    await scope.verify(manifest.resources, uri);
    const assets = [];
    for (const a of manifest.assets)
      assets.push({
        ...a,
        renderUri: (await scope.asset(new URL(a.renderUri, uri))).url,
        ...(a.giUri
          ? { giUri: (await scope.asset(new URL(a.giUri, uri))).url }
          : {}),
      });
    return {
      manifest,
      geometry: await loadDatasetGeometry({ ...manifest, assets }, uri),
      diagnosticCpuPeak: budget.report().peakAdmittedBytes,
    };
  } finally {
    scope.close();
  }
}
export async function openPilot(page, display, profile = "enhanced") {
  await page.goto(pilotBase() + `pilot-${display}.html?profile=${profile}`);
  await page.waitForFunction(
    () => window.pilotSession?.ready || window.pilotSession?.phase === "failed",
    null,
    { timeout: 240000 },
  );
  const status = await page.evaluate(() => pilotSession.status());
  if (!status.ready) throw Error(status.error);
  const visible = await page.evaluate(() =>
    pilotSession.waitForVisible({ timeoutMilliseconds: 60000 }),
  );
  if (!visible.visible)
    throw Error("Display deadline: " + JSON.stringify(visible));
  return status;
}
export async function waitFg(page) {
  const start = await page.evaluate(() => ({
    generation: pilotSession.generation,
    revision: pilotSession.world.requestedRevision,
    epoch: pilotHost.scene.lumen.finalGather.metrics.sampleEpoch ?? -1,
  }));
  try {
    await page.waitForFunction(
      (expected) => {
        const s = pilotSession.status(),
          f = s.fg,
          w = s.world;
        if (
          s.generation !== expected.generation ||
          !w ||
          w.revision !== expected.revision ||
          s.phase === "failed"
        )
          throw Error("FG wait ownership changed");
        return (
          pilotHost.scene.lumen.finalGather._sampleWorld ===
            pilotSession.world &&
          s.targets > 0 &&
          f.effectiveMode === "fg" &&
          f.history &&
          f.stablePasses >= 32 &&
          f.sampleEpoch >= expected.epoch + 32 &&
          f.revision === w.revision &&
          f.round === 3 &&
          w.round === 3
        );
      },
      start,
      { timeout: 120000 },
    );
  } catch (error) {
    throw Error(
      String(error) +
        "; FG state " +
        JSON.stringify(await page.evaluate(() => pilotSession.status())),
    );
  }
  return page.evaluate(() => pilotSession.status());
}
