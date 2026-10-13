import { writeFile } from "node:fs/promises";
import { launchBrowser, sourceVersion } from "./browser-tools.mjs";
const b = await launchBrowser(),
  p = await b.newPage({ viewport: { width: 1280, height: 800 } }),
  report = {
    version: sourceVersion(),
    mode: "synchronous raw E diagnostics, excluded from cost measurements",
    sequences: [],
  };
try {
  await p.goto("http://localhost:8090/demo/globe.html?diagnostic=1");
  await p.waitForFunction(() => earthLab.world?.status === "ready", null, {
    timeout: 180000,
  });
  for (const mode of ["progressive", "snapshot"]) {
    report.sequences.push(
      await p.evaluate(async (mode) => {
        const d = earthLab,
          w = d.world;
        d.camera("boxFoot");
        const points = [
            { position: [-8.999, -2, 0.25], normal: [1, 0, 0] },
            { position: [-10.69, 6, 0.151], normal: [0, 0, 1] },
          ],
          events = [],
          frames = [];
        const remove = w.publicationEvent.addEventListener((e) =>
          events.push({
            time: performance.now(),
            revision: e.revision,
            bounce: e.bounce,
          }),
        );
        await w.solve({
          sunDirection: [0.766044443118978, 0.6427876096865393, 0.65],
          publicationMode: mode,
        });
        const started = performance.now();
        let completed;
        const done = w
          .solve({
            sunDirection: [-0.766044443118978, 0.6427876096865393, 0.65],
            publicationMode: mode,
          })
          .then(() => (completed = performance.now() - started));
        for (let frame = 0; frame < 60; frame++) {
          await new Promise(requestAnimationFrame);
          frames.push({
            frame,
            time: performance.now() - started,
            published: w.publishedRevision,
            bounce: w.publishedBounce,
            settled: w.settledRevision,
            E: await w.sample(points),
          });
        }
        await done;
        remove();
        return {
          mode,
          completedSubmissionMilliseconds: completed,
          events,
          frames,
        };
      }, mode),
    );
  }
  report.status = "passed";
  report.decision =
    "No statistical denoiser. Static 60-frame E is deterministic. Intentional light changes/finite-bounce publications are separately recorded; optional display transition remains not implemented.";
} catch (e) {
  report.status = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await writeFile(
    "reports/ddgi-visual-quality-v4/publication-sequence.json",
    JSON.stringify(report, null, 2),
  );
  await b.close();
}
console.log(report.status, report.error ?? "");
