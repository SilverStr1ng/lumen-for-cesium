import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { newOutput, openPilot } from "./pilot-validation.mjs";
import { sourceVersion, launchBrowser } from "./browser-tools.mjs";
import { runBounded } from "./pilot-process.mjs";
import { observeDeploymentNetwork } from "./pilot-network.mjs";
const output = await newOutput("deployment"),
  report = {
    version: sourceVersion([
      "scripts/verify-pilot-deployment.mjs",
      "scripts/serve.mjs",
      "scripts/setup.mjs",
      "scripts/pilot-process.mjs",
      "scripts/pilot-network.mjs",
      "package.json",
      "package-lock.json",
      "cesium-1.146/package-lock.json",
      "docs/product/local-gi-v0.1.md",
      "docs/product/local-gi-deployment-v11.md",
    ]),
    configuration: {
      clean: true,
      root: true,
      nonRoot: "/deploy/lumen",
      browserSecurity: "enabled",
      csp: "default-src 'self'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'",
    },
    rows: [],
    errors: [],
  };
const clean = path.resolve("artifacts", "r12-clean-" + Date.now()),
  servers = [];
let browser;
const run = async (file, args, cwd, log) => {
  const result = await runBounded(file, args, {
    cwd,
    timeoutMilliseconds: 900000,
  });
  await writeFile(output + "/" + log, result.log, { flag: "wx" });
  if (result.exitCode)
    throw Error(file + " exited " + result.exitCode + "; see " + log);
};
try {
  assert.equal(
    report.version.modifiedSources.length,
    0,
    "Deployment requires frozen committed inputs",
  );
  await mkdir(clean, { recursive: true });
  const archive = path.join(clean, "source.tar");
  execFileSync("git", [
    "archive",
    "--format=tar",
    "--output=" + archive,
    report.version.head,
  ]);
  await run(
    "tar",
    ["-xf", archive, "-C", clean, "--exclude=reports"],
    process.cwd(),
    "extract.log",
  );
  const npm = (args, log) =>
    run(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "npm " + args.join(" ")]
        : args,
      clean,
      log,
    );
  console.log("Clean setup " + clean);
  await npm(["run", "setup"], "setup.log");
  await npm(["run", "build"], "build.log");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  report.cleanDirectory = clean;
  report.cleanHead = report.version.head;
  report.cleanInputs = { sources: {}, assets: {} };
  for (const [f, expected] of Object.entries(report.version.sources)) {
    const actual = sha(
      (await readFile(path.join(clean, f), "utf8")).replaceAll("\r\n", "\n"),
    );
    report.cleanInputs.sources[f] = actual;
    assert.equal(actual, expected, "Clean source differs: " + f);
  }
  for (const [f, expected] of Object.entries(report.version.assets)) {
    const actual = sha(await readFile(path.join(clean, f)));
    report.cleanInputs.assets[f] = actual;
    assert.equal(actual, expected, "Clean asset differs: " + f);
  }
  report.cleanInputs.compiledFiles = {};
  for (const [f, expected] of Object.entries(report.version.compiledFiles)) {
    const actual = sha(
      /\.(js|css|json|html)$/.test(f)
        ? (await readFile(path.join(clean, f), "utf8")).replaceAll("\r\n", "\n")
        : await readFile(path.join(clean, f)),
    );
    report.cleanInputs.compiledFiles[f] = actual;
    assert.equal(actual, expected, "Clean runtime build differs: " + f);
  }
  report.bundle = sha(
    (
      await readFile(
        path.join(clean, "cesium-1.146/Build/CesiumUnminified/Cesium.js"),
        "utf8",
      )
    ).replaceAll("\r\n", "\n"),
  );
  assert.equal(
    report.bundle,
    report.version.compiledBundle,
    "clean bundle differs from frozen build",
  );
  browser = await launchBrowser();
  for (const prefix of ["", "/deploy/lumen"]) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const server = spawn(
      process.execPath,
      [path.join(clean, "scripts/serve.mjs")],
      {
        cwd: clean,
        env: {
          ...process.env,
          LUMEN_PORT: String(port),
          LUMEN_BASE_PATH: prefix,
          LUMEN_CSP: report.configuration.csp,
        },
        windowsHide: true,
      },
    );
    servers.push(server);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("serve startup exceeded 15s")),
        15000,
      );
      const done = (error) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      server.stdout.once("data", () => done());
      server.once("error", done);
      server.once("exit", (c) => done(Error("serve exited " + c)));
    });
    const base = `http://localhost:${port}${prefix}/demo/`;
    process.env.LUMEN_PILOT_BASE = base;
    for (const display of ["models", "tiles"]) {
      // Each host owns a fresh page/context. Navigation cancellation from a
      // retired host must not be attributed to the next host's requests.
      const page = await browser.newPage({
        viewport: { width: 960, height: 600 },
      });
      page.on("pageerror", (e) => report.errors.push(String(e)));
      const requests = [],
        workers = [],
        failures = [];
      const onRequest = (r) => requests.push(r.url()),
        onWorker = (w) => workers.push(w.url()),
        onFailure = (r) => failures.push({ url: r.url(), error: r.failure() });
      page.on("request", onRequest);
      page.on("worker", onWorker);
      page.on("requestfailed", onFailure);
      console.log("Clean host " + prefix + "/" + display);
      const networkProof = await observeDeploymentNetwork(
        page,
        new URL("../fixtures/local-pilot/dataset.json", base).href,
      );
      await openPilot(page, display, "baseline");
      await page.waitForTimeout(250);
      const network = await networkProof();
      const status = await page.evaluate(() => pilotSession.status()),
        response = await fetch(base + `pilot-${display}.html`);
      const row = {
        prefix,
        display,
        status,
        requests,
        workers,
        failures,
        network,
        csp: response.headers.get("content-security-policy"),
        passed:
          status.ready &&
          status.world.ready &&
          status.world.round === 3 &&
          status.world.revision === status.world.publishedRevision &&
          status.audit.length === 8 &&
          status.world.triangles === 998 &&
          workers.some((u) => u.endsWith("/lumen/gpu-worker.js")) &&
          failures.length === network.length &&
          network.every(
            (r) => r.outcome === "cancelled-with-verified-content",
          ) &&
          requests
            .filter((u) => u.startsWith("http"))
            .every((u) => new URL(u).origin === new URL(base).origin),
      };
      report.rows.push(row);
      page.off("request", onRequest);
      page.off("worker", onWorker);
      page.off("requestfailed", onFailure);
      const image = await page.evaluate(() =>
        pilotSession.diagnostics({ image: true }),
      );
      await writeFile(
        output + `/${prefix ? "prefix" : "root"}-${display}.png`,
        Buffer.from(image.png.split(",")[1], "base64"),
        { flag: "wx" },
      );
      assert.equal(row.csp, report.configuration.csp);
      await page.close();
    }
    if (prefix) {
      assert.equal(
        (await fetch(`http://localhost:${port}/demo/pilot-models.html`)).status,
        404,
      );
    }
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
    });
    page.on("pageerror", (e) => report.errors.push(String(e)));
    const failures = [];
    page.on("requestfailed", (r) =>
      failures.push({ url: r.url(), error: r.failure() }),
    );
    const networkProof = await observeDeploymentNetwork(
      page,
      new URL("../fixtures/local-pilot/dataset.json", base).href,
    );
    await page.goto(base + "pilot-embed.html");
    await page.waitForFunction(
      () =>
        window.embedded?.session.ready ||
        window.embedded?.session.phase === "failed",
      null,
      { timeout: 240000 },
    );
    const embedded = await page.evaluate(async () => ({
      status: embedded.session.status(),
      visible: await embedded.session.waitForVisible({
        timeoutMilliseconds: 60000,
      }),
    }));
    await page.waitForTimeout(250);
    const network = await networkProof();
    const finalStatus = await page.evaluate(() => embedded.session.status());
    report.rows.push({
      prefix,
      display: "minimal-embedded",
      failures,
      network,
      ...embedded,
      finalStatus,
      passed:
        finalStatus.ready &&
        finalStatus.world.ready &&
        finalStatus.world.round === 3 &&
        finalStatus.world.revision === finalStatus.world.publishedRevision &&
        finalStatus.generation === embedded.status.generation &&
        embedded.visible.visible &&
        embedded.status.audit.length === 8 &&
        embedded.status.world.triangles === 998 &&
        failures.length === network.length &&
        network.every((r) => r.outcome === "cancelled-with-verified-content"),
    });
    await page.close();
  }
  report.status =
    report.rows.length === 6 &&
    report.rows.every((r) => r.passed) &&
    !report.errors.length
      ? "passed"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.errors.push(String(e));
  console.error(e);
} finally {
  await browser?.close();
  servers.forEach((s) => s.kill());
}
await writeFile(output + "/deployment.json", JSON.stringify(report), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.map((r) => ({
      prefix: r.prefix,
      display: r.display,
      passed: r.passed,
    })),
    errors: report.errors,
  }),
);
if (report.status !== "passed") process.exitCode = 1;
