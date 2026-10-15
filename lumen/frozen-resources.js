import { readContainer, readBuffers, dataUri } from "./gltf-container.js";
const hash = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
export const inputLimits = Object.freeze({
  resources: 128,
  single: 2 * 1048576,
  total: 8 * 1048576,
  manifest: 512 * 1024,
});
export function imageDimensions(bytes) {
  const v = new DataView(bytes),
    u = new Uint8Array(bytes);
  let width, height;
  if (
    u.length >= 24 &&
    v.getUint32(0) === 0x89504e47 &&
    v.getUint32(4) === 0x0d0a1a0a
  ) {
    width = v.getUint32(16);
    height = v.getUint32(20);
  } else if (u[0] === 255 && u[1] === 216) {
    let p = 2;
    while (p + 9 < u.length) {
      if (u[p++] !== 255) throw Error("Malformed JPEG");
      const marker = u[p++],
        length = v.getUint16(p);
      if ([192, 193, 194].includes(marker)) {
        height = v.getUint16(p + 3);
        width = v.getUint16(p + 5);
        break;
      }
      if (length < 2) throw Error("Malformed JPEG segment");
      p += length;
    }
  }
  if (!width || !height || width > 512 || height > 512)
    throw Error(
      "Pilot images require PNG/JPEG dimensions 1..512 before decode",
    );
  return { width, height, bytes: width * height * 4 };
}
function jsonBound(value) {
  if (value === null) return 4;
  if (typeof value === "string") return 2 + 6 * value.length;
  if (typeof value !== "object") return 64;
  return Array.isArray(value)
    ? 2 + value.reduce((n, item) => n + 1 + jsonBound(item), 0)
    : 2 +
        Object.entries(value).reduce(
          (n, [key, item]) => n + jsonBound(key) + 2 + jsonBound(item),
          0,
        );
}

/** Content sharing is restricted to the one session and its replacement scopes.
 * Blob URLs remain owned until every matching display/worker has retired. */
export class FrozenResourceCache {
  constructor(budget) {
    this.budget = budget;
    this.content = new Map();
    this.byUrl = new Map();
  }
  allocations() {
    return [...this.content.values()].flatMap((e) => [
      { key: e.bytes, bytes: e.bytes.byteLength, category: "frozenCpu" },
      { key: e.blobKey, bytes: e.bytes.byteLength, category: "blobCpu" },
    ]);
  }
  scope(signal) {
    return new FrozenResources(this, signal);
  }
}
class FrozenResources {
  constructor(cache, signal) {
    this.cache = cache;
    this.signal = signal;
    this.owned = new Set();
    this.verified = new Map();
    this.snapshots = new Map();
    this.inputBytes = 0;
    this.closed = false;
  }
  guard() {
    this.signal?.throwIfAborted();
    if (this.closed)
      throw new DOMException("Frozen source closed", "AbortError");
  }
  own(entry) {
    this.guard();
    if (!this.owned.has(entry)) {
      this.owned.add(entry);
      entry.references++;
    }
    return entry;
  }
  async adopt(bytes, type = "application/octet-stream", digest) {
    this.guard();
    digest ??= await hash(bytes);
    this.guard();
    let entry = this.cache.content.get(digest);
    if (!entry) {
      entry = {
        digest,
        bytes,
        type,
        references: 0,
        blobKey: {},
        url: URL.createObjectURL(new Blob([bytes], { type })),
      };
      this.cache.content.set(digest, entry);
      this.cache.byUrl.set(entry.url, entry);
    }
    return this.own(entry);
  }
  async read(
    url,
    { expected, maximum = inputLimits.single, fetchResource = fetch } = {},
  ) {
    this.guard();
    const canonical = new URL(url).href;
    if (expected && this.cache.content.has(expected)) {
      const cached = this.cache.content.get(expected);
      if (cached.bytes.byteLength > maximum)
        throw Error("Cached input exceeds remaining input limit");
      return this.own(cached);
    }
    if (
      canonical.startsWith("data:") &&
      canonical.length > Math.ceil((maximum * 4) / 3) + 256
    )
      throw Error("Declared data URI exceeds input limit");
    const response = await fetchResource(canonical, { signal: this.signal });
    if (!response.ok)
      throw Error(`Resource ${response.status}: ${canonical.slice(0, 180)}`);
    const header = response.headers.get("content-length");
    const bytesExpected = header === null ? maximum : Number(header);
    if (
      !Number.isSafeInteger(bytesExpected) ||
      bytesExpected < 0 ||
      bytesExpected > maximum
    )
      throw Error("Resource content length exceeds input limit");
    // Input plus Blob copy, response-copy scratch and bounded decode workspace.
    const lease = this.cache.budget.reserve(
      bytesExpected * 4 + 65536,
      "input/decode",
    );
    try {
      const reader = response.body.getReader(),
        chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > bytesExpected || total > maximum)
            throw Error("Resource exceeded declared input limit");
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const digest = await hash(bytes);
      if (expected && digest !== expected)
        throw Error("Resource version mismatch");
      const entry = await this.adopt(
        bytes.buffer,
        response.headers.get("content-type") ?? "application/octet-stream",
        digest,
      );
      lease.commit();
      return entry;
    } finally {
      lease.release();
    }
  }
  async manifest(url) {
    const entry = await this.read(url, { maximum: inputLimits.manifest });
    const lease = this.cache.budget.reserve(
      entry.bytes.byteLength * 2,
      "manifest-decode",
    );
    try {
      return JSON.parse(new TextDecoder().decode(entry.bytes));
    } finally {
      lease.release();
    }
  }
  async verify(resources, base) {
    const entries = Object.entries(resources ?? {});
    if (!entries.length || entries.length > inputLimits.resources)
      throw Error("Resource count limit (1..128)");
    for (const [relative, digest] of entries) {
      this.guard();
      if (!/^[0-9a-f]{64}$/.test(digest))
        throw Error("Resource SHA-256 required");
      const url = new URL(relative, base).href;
      const previous = this.verified.get(url);
      if (previous && previous.digest !== digest)
        throw Error("Conflicting canonical resource identity");
      if (previous) continue;
      const entry = await this.read(url, {
        expected: digest,
        maximum: Math.min(
          inputLimits.single,
          inputLimits.total - this.inputBytes,
        ),
      });
      this.inputBytes += entry.bytes.byteLength;
      if (this.inputBytes > inputLimits.total)
        throw Error("Total dataset input exceeds 8MiB");
      this.verified.set(url, entry);
    }
  }
  response(input) {
    const entry =
      this.verified.get(new URL(input).href) ??
      this.cache.byUrl.get(new URL(input).href);
    if (!entry || !this.owned.has(entry))
      throw Error("Undeclared resource: " + String(input).slice(0, 180));
    return new Response(entry.bytes, {
      headers: {
        "content-type": entry.type,
        "content-length": String(entry.bytes.byteLength),
      },
    });
  }
  async json(value, type = "application/json") {
    this.guard();
    const bound = jsonBound(value);
    if (bound > inputLimits.single)
      throw Error("Frozen JSON bound exceeds 2MiB");
    const lease = this.cache.budget.reserve(bound * 4, "JSON encoding");
    try {
      const text = JSON.stringify(value);
      const entry = await this.adopt(
        new TextEncoder().encode(text).buffer,
        type,
      );
      lease.commit();
      return entry.url;
    } finally {
      lease.release();
    }
  }
  async asset(url) {
    const canonical = new URL(url).href;
    if (this.snapshots.has(canonical)) return this.snapshots.get(canonical);
    const entry = this.verified.get(canonical);
    if (!entry) throw Error("Undeclared asset");
    const containerLease = this.cache.budget.reserve(
      entry.bytes.byteLength * 4,
      "container decode",
    );
    let lease;
    try {
      const container = await readContainer(canonical, this.signal, (uri) =>
          this.response(uri),
        ),
        gltf = structuredClone(container.gltf);
      lease = this.cache.budget.reserve(
        entry.bytes.byteLength * 2 +
          (gltf.buffers ?? []).reduce((n, b) => {
            const actual = b.uri
              ? this.verified.get(new URL(b.uri, canonical).href)?.bytes
                  .byteLength
              : container.bin?.byteLength;
            if (
              !Number.isSafeInteger(actual) ||
              actual < b.byteLength ||
              actual - b.byteLength > 3
            )
              throw Error(
                "Buffer length must match verified input (at most GLB padding)",
              );
            return n + actual * 2;
          }, 0),
        "glTF buffers",
      );
      const buffers = await readBuffers(
        gltf,
        container.bin,
        canonical,
        this.signal,
        (uri) => this.response(uri),
      );
      for (let i = 0; i < buffers.length; i++)
        gltf.buffers[i].uri = (await this.adopt(buffers[i])).url;
      for (const image of gltf.images ?? []) {
        let bytes,
          type = image.mimeType;
        if (image.uri) {
          const resource = this.verified.get(
            new URL(image.uri, canonical).href,
          );
          if (!resource) throw Error("Undeclared image");
          bytes = resource.bytes;
          type ??= resource.type;
        } else {
          const view = gltf.bufferViews[image.bufferView];
          bytes = buffers[view.buffer].slice(
            view.byteOffset ?? 0,
            (view.byteOffset ?? 0) + view.byteLength,
          );
        }
        imageDimensions(bytes);
        image.uri = (await this.adopt(bytes, type)).url;
        delete image.bufferView;
      }
      const result = {
        gltf,
        url: await this.json(gltf, "model/gltf+json"),
        format: container.format,
        sourceBytes: container.sourceBytes,
      };
      this.snapshots.set(canonical, result);
      return result;
    } finally {
      lease?.release();
      containerLease.release();
    }
  }
  async exportManifest(manifest) {
    // Explicit diagnostics may fail admission. They never free production
    // history or silently exclude their encoding scratch from the fixed limit.
    const bytes = [...this.owned].reduce((n, e) => n + e.bytes.byteLength, 0);
    const lease = this.cache.budget.reserve(bytes * 16, "diagnostic export");
    try {
      const assets = [];
      const memo = new Map();
      for (const asset of manifest.assets) {
        const exportAsset = (uri) => {
          if (memo.has(uri)) return memo.get(uri);
          const entry = this.cache.byUrl.get(uri),
            gltf = JSON.parse(new TextDecoder().decode(entry.bytes));
          for (const item of [...(gltf.buffers ?? []), ...(gltf.images ?? [])])
            if (item.uri) {
              const binary = this.cache.byUrl.get(item.uri);
              item.uri = dataUri(binary.bytes, binary.type);
            }
          const result = dataUri(
            new TextEncoder().encode(JSON.stringify(gltf)),
            "model/gltf+json",
          );
          memo.set(uri, result);
          return result;
        };
        assets.push({
          ...asset,
          renderUri: exportAsset(asset.renderUri),
          giUri: exportAsset(asset.giUri ?? asset.renderUri),
        });
      }
      return dataUri(
        new TextEncoder().encode(JSON.stringify({ ...manifest, assets })),
        "application/json",
      );
    } finally {
      lease.release();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.owned)
      if (--entry.references === 0) {
        URL.revokeObjectURL(entry.url);
        this.cache.byUrl.delete(entry.url);
        this.cache.content.delete(entry.digest);
      }
    this.owned.clear();
    this.verified.clear();
    this.snapshots.clear();
  }
}
