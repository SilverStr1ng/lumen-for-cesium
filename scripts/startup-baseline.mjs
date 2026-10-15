import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { runBounded } from "./pilot-process.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
export async function startStartupBaseline(output) {
  const expected = JSON.parse(
    await readFile(
      "reports/local-gi-startup-v12/r13-0-before-presented/startup.json",
      "utf8",
    ),
  ).version;
  let runtime, server, base;
  if (
    process.env.LUMEN_STARTUP_RUNTIME_MANIFEST &&
    process.env.LUMEN_EQ_BEFORE_BASE
  ) {
    runtime = JSON.parse(
      await readFile(process.env.LUMEN_STARTUP_RUNTIME_MANIFEST, "utf8"),
    );
    base = process.env.LUMEN_EQ_BEFORE_BASE;
  } else {
    const root = path.resolve("artifacts", "r13-baseline-" + Date.now());
    await mkdir(root, { recursive: true });
    const archive = path.join(root, "source.tar");
    execFileSync("git", [
      "archive",
      "--format=tar",
      "--output=" + archive,
      expected.head,
    ]);
    execFileSync("tar", ["-xf", archive, "-C", root, "--exclude=reports"]);
    for (const step of ["setup", "build"]) {
      console.log("Historical runtime clean " + step);
      const result = await runBounded(
        process.platform === "win32" ? "cmd.exe" : "npm",
        process.platform === "win32"
          ? ["/d", "/s", "/c", "npm run " + step]
          : ["run", step],
        { cwd: root, timeoutMilliseconds: 900000 },
      );
      await writeFile(`${output}/baseline-${step}.log`, result.log, {
        flag: "wx",
      });
      if (result.exitCode || result.cleanupFailed)
        throw Error("Historical runtime " + step + " failed");
    }
    runtime = {
      scope:
        "Historical implementation; separate from current measurement recipe",
      root,
      reviewedHead: expected.head,
      testedImplementation: "67638369841a1ff2a8dbecddcca37f4ac0962503",
      sources: Object.fromEntries(
        Object.entries(expected.sources).filter(
          ([f]) => f.startsWith("lumen/") || f.startsWith("demo/"),
        ),
      ),
      compiledFiles: expected.compiledFiles,
      compiledBundle: expected.compiledBundle,
      assets: expected.assets,
    };
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    server = spawn(process.execPath, [path.join(root, "scripts/serve.mjs")], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, LUMEN_PORT: String(port), LUMEN_BASE_PATH: "" },
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Historical serve deadline")),
          15000,
        );
        server.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        server.once("error", reject);
      });
    } catch (error) {
      server.kill();
      throw error;
    }
    base = `http://localhost:${port}/demo/`;
  }
  try {
    if (
      runtime.reviewedHead !== expected.head ||
      runtime.compiledBundle !== expected.compiledBundle
    )
      throw Error("Wrong before implementation");
    const sources = Object.fromEntries(
      Object.entries(expected.sources).filter(
        ([f]) => f.startsWith("lumen/") || f.startsWith("demo/"),
      ),
    );
    if (Object.entries(sources).some(([f, h]) => runtime.sources[f] !== h))
      throw Error("Historical source manifest mismatch");
    for (const [f, h] of Object.entries({
      ...runtime.sources,
      ...expected.compiledFiles,
      ...expected.assets,
    })) {
      const bytes = await readFile(path.join(runtime.root, f));
      const actual = hash(
        /\.(js|css|html|json)$/.test(f) && !Object.hasOwn(expected.assets, f)
          ? bytes.toString().replaceAll("\r\n", "\n")
          : bytes,
      );
      if (actual !== h)
        throw Error("Historical disk fingerprint mismatch: " + f);
    }
    for (const [f, h] of Object.entries({
      ...runtime.sources,
      "cesium-1.146/Build/CesiumUnminified/Cesium.js": runtime.compiledBundle,
    })) {
      const response = await fetch(new URL(f, new URL("../", base)));
      if (
        !response.ok ||
        hash((await response.text()).replaceAll("\r\n", "\n")) !== h
      )
        throw Error("Historical served fingerprint mismatch: " + f);
    }
    const manifest = path.resolve(output, "baseline-runtime.json");
    await writeFile(manifest, JSON.stringify(runtime, null, 2), { flag: "wx" });
    return { base, manifest, runtime, close: () => server?.kill() };
  } catch (error) {
    server?.kill();
    throw error;
  }
}
