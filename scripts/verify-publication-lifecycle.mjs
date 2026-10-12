import { mkdir, writeFile } from "node:fs/promises";
import { launchBrowser, installGlObserver, environment, sourceVersion } from "./browser-tools.mjs";

const directory = "reports/globe-visibility-v3";
await mkdir(directory, { recursive: true });
const report = { version: sourceVersion(), started: new Date().toISOString(), checks: [], errors: [] };
const browser = await launchBrowser();
try {
  for (const final of [false, true]) {
    for (const action of ["destroy-world", "destroy-scene", "replace-world", "solve", "throw"]) {
      const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
      const browserErrors = [];
      page.on("pageerror", error => browserErrors.push(String(error)));
      await page.addInitScript(installGlObserver);
      try {
        await page.goto("http://localhost:8090/demo/regression.html?fixture=untextured&onDemand=1");
        await page.waitForFunction(() => window.lumenTest?.world?.status === "ready" || window.lumenTest?.errors?.length, null, { timeout: 120000 });
        const startup = await page.evaluate(() => ({ status: lumenTest.world?.status, errors: lumenTest.errors }));
        if (startup.errors.length) throw new Error(`Fixture initialization: ${JSON.stringify(startup)}`);
        report.environment ??= await environment(page, browser);
        const details = await page.evaluate(async ({ final, action }) => {
          const d = lumenTest, w = d.world;
          const events = [], newEvents = [];
          let callsAfterClose = 0, workerAfterClose = 0, acted = false, pendingAtAction = 0;
          let workerResult, replacementResult, nextResult, nextFirst, eventState;
          const settle = p => p.then(value => ({ state: "resolved", revision: value?.revision }), e => ({ state: "rejected", error: String(e) }));
          const bounded = async p => {
            let timer;
            try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Promise did not settle within 30 seconds")), 30000); })]); }
            finally { clearTimeout(timer); }
          };
          const draw = w._draw;
          w._draw = function(...args) { if (this.isDestroyed()) callsAfterClose++; return draw.apply(this, args); };
          const post = w.worker.postMessage.bind(w.worker);
          w.worker.postMessage = (...args) => { if (w.isDestroyed()) workerAfterClose++; return post(...args); };
          w.publicationEvent.addEventListener(event => {
            events.push({ revision: event.revision, bounce: event.bounce, final: event.final });
            if (acted || event.final !== final) return;
            acted = true;
            eventState = { status: w.status, target: w._target, previous: w._previous, published: w._published, bounce: w._bounce };
            workerResult = settle(w.referenceTrace([{ origin: [-3, 0, 1], direction: [1, 0, 0] }]));
            pendingAtAction = w._requests.size;
            if (action === "destroy-world") w.destroy();
            if (action === "destroy-scene") { d.widget.useDefaultRenderLoop = false; d.scene.destroy(); }
            if (action === "replace-world") {
              const replacement = d.load({ publicationMode: "progressive" });
              replacement.publicationEvent.addEventListener(e => newEvents.push({ revision: e.revision, bounce: e.bounce }));
              replacementResult = settle(replacement.completed);
            }
            if (action === "solve") {
              nextResult = settle(w.solve({ skyRadiance: [0.41, 0.23, 0.12], publicationMode: "progressive", bounces: 3 }));
              nextFirst = settle(w.firstPublished);
            }
            if (action === "throw") throw new Error("intentional-publication-listener-failure");
          });
          const completed = settle(w.solve({ skyRadiance: [0.23, 0.31, 0.41], publicationMode: "progressive", bounces: 3 }));
          const first = settle(w.firstPublished);
          const oldCompleted = await bounded(completed), oldFirst = await bounded(first);
          // The final settlement may precede the queued notification by one microtask.
          await Promise.resolve();
          const worker = workerResult && await bounded(workerResult);
          const replacement = replacementResult && await bounded(replacementResult);
          const next = nextResult && await bounded(nextResult);
          const requestedFirst = nextFirst && await bounded(nextFirst);
          const batchesBefore = w.metrics.submittedBatches;
          for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
          return {
            acted, eventState, pendingAtAction, oldCompleted, oldFirst, worker, replacement, next, requestedFirst,
            status: w.status, closed: w.isDestroyed(), memory: w.metrics.memory.currentBytes,
            requests: w._requests.size, queries: w._queries.length, publicationError: w.publicationError,
            callsAfterClose, workerAfterClose, batchesAfterSettlement: w.metrics.submittedBatches - batchesBefore,
            events, newEvents, fixtureErrors: d.errors, sceneDestroyed: d.scene.isDestroyed(),
            replacementReady: action === "replace-world" ? d.world.ready : undefined,
            gl: glObserver.snapshot(),
          };
        }, { final, action });
        const closing = action !== "solve";
        const monotonic = events => events.every((e, i) => !i || e.revision > events[i - 1].revision || (e.revision === events[i - 1].revision && e.bounce > events[i - 1].bounce));
        const expectedOldCompletion = final ? "resolved" : "rejected";
        const passed = details.acted && details.pendingAtAction > 0 &&
          details.oldFirst.state === "resolved" && details.oldCompleted.state === expectedOldCompletion &&
          details.callsAfterClose === 0 && details.workerAfterClose === 0 && details.batchesAfterSettlement === 0 &&
          details.requests === 0 && monotonic(details.events) && monotonic(details.newEvents) &&
          browserErrors.length === 0 && details.fixtureErrors.length === 0 &&
          details.gl.every(s => s.feedback.length === 0 && s.errors.length === 0) &&
          (closing ? details.closed && details.memory === 0 && details.queries === 0 && details.worker.state === "rejected" :
            details.status === "ready" && details.next?.state === "resolved" && details.requestedFirst?.state === "resolved" && details.worker.state === "resolved") &&
          (action === "throw" ? details.status === "error" && details.publicationError?.includes("intentional-publication") : !closing || details.status === "destroyed") &&
          (action !== "destroy-scene" || details.sceneDestroyed) &&
          (action !== "replace-world" || details.replacementReady && details.replacement?.state === "resolved" && details.newEvents.length === 3);
        report.checks.push({ name: `${final ? "final" : "non-final"} publication: ${action}`, passed, details, browserErrors });
        console.log(passed ? "PASS" : "FAIL", report.checks.at(-1).name);
      } catch (error) {
        const fixture = await page.evaluate(() => ({ status: window.lumenTest?.world?.status, errors: window.lumenTest?.errors })).catch(() => undefined);
        report.checks.push({ name: `${final ? "final" : "non-final"} publication: ${action}`, passed: false, error: String(error), browserErrors, fixture });
        console.error(error);
      } finally { await page.close(); }
    }
  }
  report.status = report.checks.every(c => c.passed) ? "passed" : "failed";
} catch (error) { report.status = "failed"; report.errors.push(String(error)); }
finally {
  report.finished = new Date().toISOString();
  const timestamp = report.started.replaceAll(/[:.]/g, "-");
  await writeFile(`${directory}/lifecycle-${timestamp}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.status !== "passed") process.exitCode = 1;
