import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const patchPath = path.join(root, "artifacts/cesium-lumen.patch");
execFileSync(process.execPath, ["scripts/export-patch.mjs"], {
  cwd: root,
  windowsHide: true,
});
const patch = await readFile(patchPath, "utf8");
const touched = [
  ...patch.matchAll(new RegExp("^diff --git a/(.+) b/(.+)$", "gm")),
].map((m) => {
  assert.equal(m[1], m[2]);
  return m[1];
});
assert.equal(
  touched.length,
  patch.split("\n").filter((line) => line.startsWith("diff --git ")).length,
);
for (const dep of [
  "packages/engine/Source/Shaders/Builtin/Functions/pbrLighting.glsl",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
])
  assert(touched.includes(dep), dep + " missing from patch");
const temp = await mkdtemp(path.join(tmpdir(), "lumen-r6-patch-"));
const normalized = (s) => s.replaceAll("\r\n", "\n");
const hashes = {};
async function copyBaseline(dir, relative = "") {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name),
      rel = path.join(relative, e.name);
    if (e.isDirectory()) await copyBaseline(p, rel);
    else {
      const target = path.join(temp, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, normalized(await readFile(p, "utf8")));
    }
  }
}
try {
  await copyBaseline(path.join(root, ".lumen-baseline"));
  execFileSync("git", ["apply", "--check", patchPath], {
    cwd: temp,
    windowsHide: true,
  });
  execFileSync("git", ["apply", patchPath], { cwd: temp, windowsHide: true });
  for (const file of touched) {
    const actual = normalized(await readFile(path.join(temp, file), "utf8"));
    const expected = normalized(
      await readFile(path.join(root, "cesium-1.146", file), "utf8"),
    );
    assert.equal(actual, expected, file + " differs after patch application");
    hashes[file] = createHash("sha256").update(actual).digest("hex");
  }
  await writeFile(
    path.join(root, "reports/receiver-final-gather-v5/export-patch.json"),
    JSON.stringify(
      {
        status: "passed",
        files: touched.length,
        scope:
          "apply onto original baseline, compare all patched files with tested working tree",
        hashes,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS " + touched.length + " patch files apply and match tested tree",
  );
} finally {
  const resolved = path.resolve(temp),
    prefix = path.resolve(tmpdir()) + path.sep;
  assert(
    resolved.startsWith(prefix) &&
      path.basename(resolved).startsWith("lumen-r6-patch-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
