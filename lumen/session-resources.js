// The integration seam is the only consumer of Cesium allocation identities.
// World textures already contain snapshots/cache; never add aggregate counters.
export function collectResources(session) {
  const entries = [],
    seen = new Map(),
    C = session._frozenCache;
  const add = (key, bytes, category, owner, handle) => {
    if (!key || !bytes) return;
    if (seen.has(key)) {
      if (owner) seen.get(key).owners.add(owner);
      return;
    }
    const entry = {
      key,
      bytes,
      category,
      owners: new Set(owner ? [owner] : []),
      handle,
    };
    seen.set(key, entry);
    entries.push(entry);
  };
  const texture = (t, category, owner) => {
    if (t && !t.isDestroyed())
      add(
        t._id === undefined ? t : `texture:${t._id}`,
        t.sizeInBytes,
        category,
        owner,
        t._texture,
      );
  };
  const arrays = (value, category, visited = new Set(), owner) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value instanceof ArrayBuffer)
      add(value, value.byteLength, category, owner);
    else if (ArrayBuffer.isView(value))
      add(value.buffer, value.buffer.byteLength, category, owner);
    else if (Array.isArray(value))
      value.forEach((v) => arrays(v, category, visited, owner));
    else
      for (const v of Object.values(value)) arrays(v, category, visited, owner);
  };
  for (const e of C?.allocations() ?? []) add(e.key, e.bytes, e.category);
  const world = session.world,
    fg = session.scene.lumen.finalGather;
  const context = session.scene.context;
  for (const t of [
    context?._defaultTexture,
    context?._defaultEmissiveTexture,
    context?._defaultNormalTexture,
    context?._defaultCubeMap,
    session.scene._brdfLutGenerator?.colorTexture,
  ])
    texture(t, "displayGpu", session);
  for (const t of world?._textures ?? [])
    texture(t, t._lumenBudgetCategory ?? "giGpu");
  arrays(world?.packet, "packetCpu");
  arrays(world?._prepared, "packetCpu");
  arrays(world?._order, "packetCpu");
  arrays(world?._baseMaterials, "packetCpu");
  add(
    world?._closed ? undefined : world?.worker,
    world?.packet?.bvh?.cpuRetainedBytes ??
      world?._prepared?.bvh?.cpuRetainedBytes ??
      world?.metrics.memory.workerCpuBytes,
    "workerCpu",
  );
  arrays(session.geometry, "geometryCpu");
  arrays(fg._owners?.claims, "ownerCpu");
  for (const t of fg._textures ?? []) texture(t, "fgGpu");
  for (const t of fg.reconstruction?._textures ?? []) texture(t, "fgGpu");
  const receiver = fg.receiver;
  for (const t of [
    receiver?.position,
    receiver?.normal,
    receiver?.manager?._depthStencilTexture,
    receiver?.manager?._depthTexture,
  ])
    texture(t, "fgGpu");
  const pending = [...session._pendingResources.values()];
  pending.forEach((p) => arrays(p.geometry, "geometryCpu"));
  const models = new Set([
    ...session.models,
    ...(session.adapter?.loaded ?? []),
    ...pending.flatMap((p) => p.models),
  ]);
  const nativeFields = [
    "_typedArray",
    "typedArray",
    "packedTypedArray",
    "_bufferViewLoaders",
    "_bufferLoader",
    "_imageLoader",
    "_image",
    "_geometryLoaders",
    "_gltfJsonLoader",
    "_textureLoaders",
    "_vertexBufferLoader",
    "_indexBufferLoader",
    "_gltf",
    "components",
    "nodes",
    "children",
    "primitives",
    "attributes",
    "indices",
    "extras",
    "_pipeline",
    "source",
  ];
  let nativeSeen;
  const native = (value, owner) => {
    if (!value || typeof value !== "object" || nativeSeen.has(value)) return;
    nativeSeen.add(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
      arrays(value, "displayCpu", new Set(), owner);
    else if (Array.isArray(value)) value.forEach((v) => native(v, owner));
    else if (
      (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) ||
      (typeof HTMLImageElement !== "undefined" &&
        value instanceof HTMLImageElement)
    )
      add(value, value.width * value.height * 4, "displayCpu", owner);
    else for (const key of nativeFields) native(value[key], owner);
  };
  for (const model of models) {
    if (model.isDestroyed()) continue;
    const s = model.statistics ?? model._statistics;
    if (s?.geometryByteLength && !s._bufferByteLengths)
      throw Error("Rebuild Cesium: allocation identity statistics required");
    for (const [id, bytes] of Object.entries(s?._bufferByteLengths ?? {}))
      add(`buffer:${id}`, bytes, "displayGpu", model, s._bufferHandles?.[id]);
    for (const [id, bytes] of Object.entries(s?._textureIdByteLengths ?? {}))
      add(`texture:${id}`, bytes, "displayGpu", model, s._textureHandles?.[id]);
    nativeSeen = new Set();
    native(model._loader, model);
  }
  const managers = new Set(
    [...models]
      .filter((m) => !m.isDestroyed())
      .map((m) => m.environmentMapManager),
  );
  managers.add(session.tileset?.environmentMapManager);
  pending.forEach((p) => managers.add(p.tileset?.environmentMapManager));
  for (const manager of managers)
    if (manager)
      for (const t of [
        manager._radianceCubeMap,
        manager._irradianceMapTexture,
        ...(manager._radianceMapTextures ?? []),
        ...(manager._specularMapTextures ?? []),
      ])
        texture(t, "environmentGpu", manager);
  // Query object storage is implementation dependent: reserve 4KiB per live
  // handle as a disclosed logical allowance, never claim this is measured VRAM.
  for (const q of [...(world?._queries ?? []), ...(fg._queries ?? [])])
    add(q.query, 4096, "queryAllowance");
  return entries;
}
export function bufferKeys(value, result = new Set(), seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return result;
  seen.add(value);
  if (value instanceof ArrayBuffer) result.add(value);
  else if (ArrayBuffer.isView(value)) result.add(value.buffer);
  else for (const item of Object.values(value)) bufferKeys(item, result, seen);
  return result;
}
