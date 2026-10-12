import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const root = new URL(process.env.LUMEN_ASSET_URL ?? "http://localhost:8008/gltf/2.0/Sponza/glTF/Sponza.gltf");
if (root.username || root.password || root.search) throw new Error("Evidence asset URL must not include credentials or query parameters");
const assets = [];
async function digest(url) {
  if (url.origin !== root.origin || url.search) throw new Error("Asset evidence is limited to the same unauthenticated origin");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Asset HTTP ${response.status}: ${url.pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assets.push({ url: url.href, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return bytes;
}
const gltf = JSON.parse(await digest(root));
for (const uri of new Set([...gltf.buffers ?? [], ...gltf.images ?? []].map(item => item.uri).filter(uri => uri && !uri.startsWith("data:")))) await digest(new URL(uri,root));
await writeFile("reports/globe-visibility-v3/sponza-asset-chain.json", JSON.stringify({ date: new Date().toISOString(), scope: "Root glTF plus all external buffers and images; embedded data is covered by root hash", status: "passed", assets },null,2));
console.log(`Hashed ${assets.length} Sponza files`);
