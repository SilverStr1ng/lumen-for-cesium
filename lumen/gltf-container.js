/** Static glTF/GLB transport. No renderer, Blob URL, or implicit animation policy. */
export async function readContainer(url, signal, fetchResource = fetch) {
  const response = await fetchResource(url, { signal });
  if (!response.ok) throw Error(`Asset ${response.status}: ${url}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 32 * 1048576)
    throw Error("Asset exceeds 32MiB input limit");
  const view = new DataView(bytes);
  if (bytes.byteLength < 4 || view.getUint32(0, true) !== 0x46546c67) {
    return {
      gltf: JSON.parse(new TextDecoder().decode(bytes)),
      bin: undefined,
      format: "gltf",
      sourceBytes: bytes.byteLength,
    };
  }
  if (
    bytes.byteLength < 20 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength
  )
    throw Error("Invalid GLB 2.0 header/length");
  let offset = 12,
    gltf,
    bin;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength)
      throw Error("Truncated GLB chunk header");
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > bytes.byteLength)
      throw Error("Invalid GLB chunk length/alignment");
    const chunk = bytes.slice(offset, offset + length);
    if (type === 0x4e4f534a) {
      if (gltf || offset !== 20)
        throw Error("GLB JSON must be first and unique");
      gltf = JSON.parse(new TextDecoder().decode(chunk));
    } else if (type === 0x004e4942) {
      if (bin || !gltf) throw Error("Invalid duplicate/order GLB BIN");
      bin = chunk;
    }
    offset += length;
  }
  if (!gltf || gltf.asset?.version !== "2.0")
    throw Error("GLB needs a glTF 2.0 JSON chunk");
  return { gltf, bin, format: "glb", sourceBytes: bytes.byteLength };
}
export async function readBuffers(
  gltf,
  bin,
  url,
  signal,
  fetchResource = fetch,
) {
  return Promise.all(
    (gltf.buffers ?? []).map(async (b, i) => {
      let bytes;
      if (b.uri) {
        const response = await fetchResource(new URL(b.uri, url), { signal });
        if (!response.ok) throw Error(`Buffer ${response.status}: ${b.uri}`);
        bytes = await response.arrayBuffer();
      } else if (i === 0 && bin) bytes = bin;
      else throw Error("Missing buffer URI / GLB BIN");
      if (bytes.byteLength < b.byteLength || bytes.byteLength > 32 * 1048576)
        throw Error("Buffer length/input budget mismatch");
      return bytes;
    }),
  );
}
export function dataUri(bytes, type = "application/octet-stream") {
  const array = new Uint8Array(bytes);
  let text = "";
  for (let i = 0; i < array.length; i += 32768)
    text += String.fromCharCode(...array.subarray(i, i + 32768));
  return `data:${type};base64,${btoa(text)}`;
}
export async function snapshotAsset(url, signal, fetchResource = fetch) {
  const container = await readContainer(url, signal, fetchResource),
    gltf = structuredClone(container.gltf);
  if (gltf.asset?.version !== "2.0") throw Error("Only glTF 2.0 supported");
  const buffers = await readBuffers(
    gltf,
    container.bin,
    url,
    signal,
    fetchResource,
  );
  gltf.buffers.forEach((b, i) => {
    b.uri = dataUri(buffers[i]);
  });
  for (const image of gltf.images ?? [])
    if (image.uri) {
      const response = await fetchResource(new URL(image.uri, url), { signal });
      if (!response.ok) throw Error(`Image ${response.status}: ${image.uri}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 16 * 1048576)
        throw Error("Image exceeds input budget");
      image.uri = dataUri(
        bytes,
        response.headers.get("content-type") ?? "image/png",
      );
    }
  return {
    url: dataUri(
      new TextEncoder().encode(JSON.stringify(gltf)),
      "model/gltf+json",
    ),
    format: container.format,
    sourceBytes: container.sourceBytes,
    gltf,
  };
}
