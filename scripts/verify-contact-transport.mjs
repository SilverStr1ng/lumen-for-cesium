import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const out =
  process.env.LUMEN_REPORT_DIRECTORY ??
  `reports/contact-transport-v9/geometry-${new Date().toISOString().replaceAll(":", "-")}`;
if (!path.resolve(out).startsWith(path.resolve("reports") + path.sep))
  throw Error("Output must be under reports");
await mkdir(out, { recursive: true });
if ((await readdir(out)).length)
  throw Error("Use a new immutable output directory");
const tests = [];
for (const name of ["verify-contact-origins", "verify-contact-geometry"]) {
  const r = spawnSync(process.execPath, ["scripts/" + name + ".mjs"], {
    env: { ...process.env, LUMEN_REPORT_DIRECTORY: out + "/" + name },
    windowsHide: true,
    encoding: "utf8",
  });
  await writeFile(
    out + "/" + name + ".log",
    (r.stdout ?? "") + (r.stderr ?? ""),
    { flag: "wx" },
  );
  tests.push({ name, exitCode: r.status ?? 1 });
}
const status = tests.every((t) => t.exitCode === 0) ? "passed" : "failed";
await writeFile(
  out + "/contact-transport.json",
  JSON.stringify({ status, tests }, null, 2),
  { flag: "wx" },
);
console.log(JSON.stringify({ status, tests }));
if (status !== "passed") process.exitCode = 1;
