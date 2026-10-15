import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ResourceBudget from "../lumen/resource-budget.js";
import { FrozenResourceCache } from "../lumen/frozen-resources.js";
const base = new URL("../fixtures/local-pilot/dataset.json", import.meta.url);
const manifest = JSON.parse(await readFile(base, "utf8"));
const nativeFetch = globalThis.fetch;
let networkReads = 0;
globalThis.fetch = async (input, init) => {
  const uri = new URL(input);
  if (uri.protocol !== "file:") return nativeFetch(input, init);
  networkReads++;
  const bytes = await readFile(uri);
  return new Response(bytes, {
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": uri.pathname.endsWith(".png")
        ? "image/png"
        : "application/octet-stream",
    },
  });
};
const budget = new ResourceBudget(),
  cache = new FrozenResourceCache(budget);
budget.refresh = () => budget.observe(cache.allocations());
const first = cache.scope(),
  second = cache.scope(),
  third = cache.scope();
try {
  await first.verify(manifest.resources, base);
  const assets = [];
  for (const asset of manifest.assets)
    assets.push({
      ...asset,
      renderUri: (await first.asset(new URL(asset.renderUri, base))).url,
    });
  const before = budget.committedBytes,
    reads = networkReads;
  await second.verify(manifest.resources, base);
  for (let i = 0; i < manifest.assets.length; i++) {
    const repeated = await second.asset(
      new URL(manifest.assets[i].renderUri, base),
    );
    assert.equal(repeated.url, assets[i].renderUri);
  }
  budget.refresh();
  assert.equal(budget.committedBytes, before);
  assert.equal(networkReads, reads);
  const exported = await second.exportManifest({ ...manifest, assets });
  const exportedJson = await (await nativeFetch(exported)).json();
  assert(
    exportedJson.assets.every((asset) => asset.renderUri.startsWith("data:")),
  );
  first.close();
  budget.refresh();
  assert.equal(budget.committedBytes, before);
  const oldUri = assets[0].renderUri;
  second.close();
  budget.refresh();
  assert.equal(budget.committedBytes, 0);
  await assert.rejects(nativeFetch(oldUri));

  const a = new Uint8Array([1, 2, 3]),
    b = new Uint8Array([4, 5, 6]);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("data:")) return nativeFetch(url);
    const bytes = String(url).includes("/a/") ? a : b;
    return new Response(bytes, {
      headers: { "content-length": String(bytes.length) },
    });
  };
  const declaredData = "data:application/octet-stream;base64,BAUG";
  await third.verify(
    {
      "a/child.glb": digest(a),
      "b/child.glb": digest(b),
      "a/../b/child.glb": digest(b),
      [declaredData]: digest(b),
    },
    "https://local.invalid/deploy/tiles.json",
  );
  assert.equal(third.verified.size, 3);
  assert.deepEqual(
    new Uint8Array(
      await third
        .response("https://local.invalid/deploy/a/child.glb")
        .arrayBuffer(),
    ),
    a,
  );
  assert.deepEqual(
    new Uint8Array(
      await third
        .response("https://local.invalid/deploy/b/child.glb")
        .arrayBuffer(),
    ),
    b,
  );
  assert.deepEqual(
    new Uint8Array(await third.response(declaredData).arrayBuffer()),
    b,
  );
} finally {
  first.close();
  second.close();
  third.close();
}
const limits = cache.scope();
let bodyRead = false;
globalThis.fetch = async () => ({
  ok: true,
  headers: new Headers({ "content-length": "3000000" }),
  body: {
    getReader() {
      bodyRead = true;
      throw Error("Must not read");
    },
  },
});
await assert.rejects(limits.read("https://local.invalid/large"), /input limit/);
assert.equal(bodyRead, false);
limits.close();
globalThis.fetch = nativeFetch;
console.log(
  JSON.stringify({
    status: "passed",
    assets: manifest.assets.length,
    sharedBytes: budget.report().peakKnownBytes,
    peakAdmittedBytes: budget.report().peakAdmittedBytes,
    scope:
      "canonical identity, content sharing, Blob lifecycle and input admission; browser GL peaks tested separately",
  }),
);
