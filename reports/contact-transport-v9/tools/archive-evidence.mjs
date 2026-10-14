import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  readdir,
  stat,
  mkdir,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";
const root = "reports/contact-transport-v9",
  manifest = root + "/archive-manifest.json",
  base = path.resolve(root);
const safe = (p) => {
  const q = path.resolve(p);
  if (!q.startsWith(base + path.sep))
    throw Error("Archive escaped R10 reports");
  return q;
};
const digest = async (p) => {
  const hash = createHash("sha256");
  for await (const b of createReadStream(safe(p))) hash.update(b);
  return hash.digest("hex");
};
if (process.argv.includes("--archive")) {
  const files = [];
  async function visit(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) await visit(p);
      else if (
        e.name === "root-cause.json" &&
        (await stat(p)).size > 90 * 1048576
      )
        files.push(p);
    }
  }
  await visit(root);
  const entries = [];
  for (const raw of files) {
    const gzip = raw + ".gz";
    await pipeline(
      createReadStream(safe(raw)),
      createGzip({ level: 9 }),
      createWriteStream(safe(gzip), { flags: "wx" }),
    );
    const entry = {
      raw,
      gzip,
      bytes: (await stat(raw)).size,
      sha256: await digest(raw),
      gzipBytes: (await stat(gzip)).size,
      gzipSha256: await digest(gzip),
    };
    const full = JSON.parse(await readFile(raw, "utf8")),
      summary = raw.replace("/root-cause.json", "/root-cause-summary.json");
    await writeFile(
      summary,
      JSON.stringify(
        {
          purpose:
            "Readable summary only; no rays or failed points removed from full lossless gzip",
          full: gzip,
          fullSha256: entry.sha256,
          executionHead: full.version.head,
          policy: full.policy,
          status: full.status,
          errors: full.errors,
          environment: full.environment,
          rows: full.rows.map((r) => ({
            count: r.count,
            depth: r.depth,
            region: r.region,
            point: r.point,
            seed: r.seed,
            epoch: r.epoch,
            samples: r.samples,
            terms: r.terms,
            counts: r.counts,
            instant: r.instant,
            oracleReplaced: r.oracleReplaced,
            reference: r.reference,
          })),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    entry.summary = summary;
    entry.summarySha256 = await digest(summary);
    entries.push(entry);
  }
  await writeFile(
    manifest,
    JSON.stringify(
      {
        format:
          "lossless gzip; original bytes and original acceptance hashes preserved",
        entries,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      archived: entries.length,
      bytes: entries.reduce((s, e) => s + e.bytes, 0),
      gzipBytes: entries.reduce((s, e) => s + e.gzipBytes, 0),
    }),
  );
} else {
  const report = JSON.parse(await readFile(manifest, "utf8"));
  for (const e of report.entries) {
    if ((await digest(e.gzip)) !== e.gzipSha256)
      throw Error("Compressed artifact mismatch: " + e.gzip);
    if ((await digest(e.summary)) !== e.summarySha256)
      throw Error("Readable summary mismatch: " + e.summary);
    const target = safe(e.raw);
    let present;
    try {
      present = await stat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (present) {
      if (present.size !== e.bytes || (await digest(e.raw)) !== e.sha256)
        throw Error("Existing raw artifact mismatch: " + e.raw);
    } else {
      const temporary = target + ".restore-tmp";
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(
        createReadStream(safe(e.gzip)),
        createGunzip(),
        createWriteStream(temporary, { flags: "wx" }),
      );
      if (
        (await stat(temporary)).size !== e.bytes ||
        (await digest(temporary)) !== e.sha256
      )
        throw Error("Restored artifact mismatch: " + e.raw);
      await rename(temporary, target);
    }
  }
  console.log(
    JSON.stringify({
      verified: true,
      restoredOrPresent: report.entries.length,
    }),
  );
}
