import { capturePixels } from "./session-diagnostics.js";
import { readContainer, snapshotAsset, dataUri } from "./gltf-container.js";
import {
  validateManifest,
  auditGltf,
  loadDatasetGeometry,
  identity,
} from "./local-dataset.js";
import LumenTilesAdapter from "./LumenTilesAdapter.js";
const sessions = new WeakMap(),
  profiles = Object.freeze({
    baseline: { mode: "ddgi", experimental: false },
    enhanced: { mode: "fg", experimental: false },
    "contact-experimental": { mode: "fg", experimental: true },
  });
const aborted = () =>
  new DOMException("Dataset/operation superseded or disposed", "AbortError");
const sha = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
/** Thin bounded static integration. Owns its displays and world, never the Scene.
 * Engine internals are confined here and in LumenTilesAdapter, not host pages. */
export default class LumenSession {
  constructor({
    Cesium,
    scene,
    display = "models",
    profile = "baseline",
    onDatasetCommitted,
    awaitDisplay = false,
    workerUrl = new URL("./gpu-worker.js", import.meta.url).href,
  } = {}) {
    if (!Cesium || !scene || sessions.has(scene) || scene.lumen.world)
      throw Error("A session requires an unowned Cesium Scene");
    if (!profiles[profile] || !["models", "tiles"].includes(display))
      throw Error("Unsupported session display/profile");
    if (
      onDatasetCommitted !== undefined &&
      typeof onDatasetCommitted !== "function"
    )
      throw Error("onDatasetCommitted must be a function");
    if (typeof awaitDisplay !== "boolean")
      throw Error("awaitDisplay must be boolean");
    this.onDatasetCommitted = onDatasetCommitted;
    this.awaitDisplay = awaitDisplay;
    this.canvas = scene.canvas;
    this._sceneMonitor = setInterval(() => {
      if (scene.isDestroyed()) this.dispose();
    }, 500);
    this.C = Cesium;
    this.scene = scene;
    this.display = display;
    this.profile = profile;
    this.workerUrl = workerUrl;
    this.generation = 0;
    this.models = [];
    this.audit = [];
    this.timings = [];
    this.peakKnownBytes = 0;
    this._pendingResources = new Map();
    this.disposed = false;
    this.phase = "empty";
    this._previous = {
      enabled: scene.lumen.enabled,
      coverage: scene.lumen.coverage,
      iblPolicy: scene.lumen.iblPolicy,
      light: scene.light,
    };
    sessions.set(scene, this);
    this._removeRenderError = scene.renderError.addEventListener((_, error) => {
      if (this._contextLost) {
        this._controller?.abort();
        return;
      }
      this._renderError = String(error);
      this.error = this._renderError;
      this.phase = "failed";
      this._controller?.abort();
    });
    this._removeBudget = scene.preRender.addEventListener(() =>
      this._account(),
    );
    this._lost = (event) => {
      event.preventDefault();
      this._contextLost = true;
      this.phase = "context-lost";
      this.error =
        "Context lost: recreate Scene/session; in-place restoration not certified";
      this._controller?.abort();
      queueMicrotask(() => {
        if (
          !this.disposed &&
          !scene.isDestroyed() &&
          scene.lumen.world === this.world
        ) {
          scene.lumen.coverage = 0;
          scene.lumen.unloadWorld();
          this.world = undefined;
          scene.lumen.finalGather.setModels([], true);
        }
      });
    };
    scene.canvas.addEventListener("webglcontextlost", this._lost);
    this._visibility = () => {
      if (!document.hidden && !this.disposed) this.scene.requestRender();
    };
    document.addEventListener("visibilitychange", this._visibility);
  }
  get ready() {
    return this.phase === "available";
  }
  _guard(token, signal) {
    if (this.disposed || token !== this.generation || signal?.aborted)
      throw aborted();
  }
  _afterFrame(action, signal) {
    return new Promise((resolve, reject) => {
      let remove;
      const cancel = () => {
        remove?.();
        signal?.removeEventListener("abort", cancel);
        reject(aborted());
      };
      remove = this.scene.postRender.addEventListener(() => {
        remove();
        signal?.removeEventListener("abort", cancel);
        try {
          resolve(action?.());
        } catch (error) {
          reject(error);
        }
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else this.scene.requestRender();
    });
  }
  _wait(promise, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(aborted());
      signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", cancel));
      if (signal.aborted) cancel();
    });
  }
  async load(uri) {
    return this.replaceDataset(uri);
  }
  async replaceDataset(uri) {
    if (this.disposed) throw aborted();
    if (this._renderError)
      throw Error("Scene rendering stopped: recreate host before loading");
    const token = ++this.generation;
    this._controller?.abort();
    const controller = (this._controller = new AbortController()),
      signal = controller.signal,
      start = performance.now();
    this.phase = "auditing";
    this.error = undefined;
    this._cacheFailure = undefined;
    this.audit = [];
    const staged = [];
    let stagedTiles,
      committed = false;
    const pending = { bytes: 0, models: staged, tileset: undefined };
    this._pendingResources.set(token, pending);
    try {
      const absolute = new URL(uri, document.baseURI).href,
        { gltf: raw } = await readContainer(absolute, signal),
        manifest = validateManifest(structuredClone(raw));
      if (!manifest.resources || !Object.keys(manifest.resources).length)
        throw Error("Immutable resource SHA manifest required");
      const verified = new Map();
      for (const [relative, digest] of Object.entries(manifest.resources)) {
        const response = await fetch(new URL(relative, absolute), { signal });
        if (!response.ok)
          throw Error(`Resource ${response.status}: ${relative}`);
        const bytes = await response.arrayBuffer();
        if ((await sha(bytes)) !== digest)
          throw Error("Resource version mismatch: " + relative);
        pending.bytes += bytes.byteLength;
        verified.set(new URL(relative, absolute).href, {
          bytes,
          type:
            response.headers.get("content-type") ?? "application/octet-stream",
        });
      }
      // Decode only the already verified bytes; a second network fetch could change versions.
      const fetchFrozen = async (input) => {
        const value = verified.get(new URL(input, absolute).href);
        if (!value) throw Error("Undeclared resource: " + input);
        return new Response(value.bytes, {
          headers: { "content-type": value.type },
        });
      };
      const snapshots = [];
      let snapshotBytes = 0;
      for (const a of manifest.assets) {
        this._guard(token, signal);
        const source = await snapshotAsset(
          new URL(a.renderUri, absolute),
          signal,
          fetchFrozen,
        );
        const audit = auditGltf(source.gltf);
        const gi = a.giUri
          ? await snapshotAsset(new URL(a.giUri, absolute), signal, fetchFrozen)
          : source;
        auditGltf(gi.gltf);
        snapshots.push({ ...a, renderUri: source.url, giUri: gi.url });
        snapshotBytes +=
          2 * (source.url.length + (gi === source ? 0 : gi.url.length));
        this.audit.push({
          id: a.id,
          ...audit,
          format: source.format,
          version: manifest.version,
          proxy: a.giUri
            ? "declared-static-proxy"
            : "same-frozen-display-bytes",
        });
      }
      const frozen = { ...manifest, assets: snapshots },
        geometry = await loadDatasetGeometry(
          frozen,
          absolute,
          () => {},
          signal,
        );
      pending.geometry = geometry;
      pending.bytes += snapshotBytes;
      const snapshotUri = dataUri(
        new TextEncoder().encode(JSON.stringify(frozen)),
        "application/json",
      );
      snapshotBytes += snapshotUri.length * 4;
      if (snapshotBytes > 32 * 1048576)
        throw Error("Snapshot CPU budget exceeds 32MiB");
      const C = this.C,
        frame = C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(
            manifest.anchor.longitude,
            manifest.anchor.latitude,
            manifest.anchor.height,
          ),
        );
      if (this.display === "models") {
        for (const a of snapshots) {
          this._guard(token, signal);
          const model = await C.Model.fromGltfAsync({
            url: a.renderUri,
            modelMatrix: C.Matrix4.multiply(
              frame,
              C.Matrix4.fromArray(a.localTransform ?? identity()),
              new C.Matrix4(),
            ),
            upAxis: C.Axis[a.upAxis ?? "Z"],
            forwardAxis: C.Axis[a.forwardAxis ?? "X"],
            show: false,
            incrementallyLoadTextures: false,
            environmentMapOptions: {
              enabled: true,
              generateSphericalHarmonics: false,
              mipmapLevels: 7,
              gamma: 1,
              brightness: 1,
              atmosphereScatteringIntensity: 2,
            },
          });
          staged.push(model);
          this._guard(token, signal);
          this.scene.primitives.add(model);
        }
      } else {
        if (!manifest.tilesUri) throw Error("tilesUri required");
        const tileUri = new URL(manifest.tilesUri, absolute).href,
          { gltf: tiles } = await readContainer(tileUri, signal, fetchFrozen);
        if (
          tiles.asset?.gltfUpAxis !== "Z" ||
          tiles.root?.refine !== "REPLACE" ||
          tiles.extras?.datasetId !== manifest.datasetId ||
          tiles.extras?.datasetVersion !== manifest.version
        )
          throw Error("Controlled Z-up REPLACE tiles/version required");
        const freeze = async (node) => {
          if (node.content) {
            const resource = new URL(node.content.uri, tileUri);
            const response = await fetchFrozen(resource);
            if (!response.ok) throw Error("Tile resource " + response.status);
            const bytes = await response.arrayBuffer(),
              relative = decodeURIComponent(
                resource.pathname.split("/").at(-1),
              );
            if ((await sha(bytes)) !== manifest.resources[relative])
              throw Error("Tile content version mismatch");
            const container = await readContainer(
              dataUri(bytes, "model/gltf-binary"),
              signal,
            );
            if (
              container.format !== "glb" ||
              container.gltf.buffers.some((b) => b.uri) ||
              (container.gltf.images ?? []).some((im) => im.uri)
            )
              throw Error("Pilot Tiles require self-contained GLB");
            node.content.uri = dataUri(bytes, "model/gltf-binary");
            snapshotBytes += node.content.uri.length * 2;
          }
          for (const child of node.children ?? []) await freeze(child);
        };
        await freeze(tiles.root);
        tiles.root.transform = C.Matrix4.toArray(frame);
        const tileSnapshot = dataUri(
          new TextEncoder().encode(JSON.stringify(tiles)),
          "application/json",
        );
        snapshotBytes += tileSnapshot.length * 2;
        stagedTiles = await C.Cesium3DTileset.fromUrl(tileSnapshot, {
          show: false,
          cacheBytes: 8 * 1048576,
          maximumCacheOverflowBytes: 4 * 1048576,
          maximumScreenSpaceError: 16,
          environmentMapOptions: {
            enabled: true,
            generateSphericalHarmonics: false,
            mipmapLevels: 7,
            gamma: 1,
            brightness: 1,
            atmosphereScatteringIntensity: 2,
          },
        });
        pending.tileset = stagedTiles;
        this._guard(token, signal);
        this.scene.primitives.add(stagedTiles);
      }
      if (snapshotBytes > 32 * 1048576)
        throw Error("Snapshot CPU budget exceeds 32MiB");
      this._guard(token, signal);
      await this._afterFrame(() => {
        this._guard(token, signal);
        const l = this.scene.lumen;
        // World constructor validates/posts before old illumination is retired.
        const world = l.loadWorld({
          backend: "gpu",
          workerUrl: this.workerUrl,
          url: snapshotUri,
          modelMatrix: frame,
          ...manifest.gi,
          bvhStrategy: "sah",
          publicationMode: "progressive",
          environmentMode: "upper-hemisphere",
          captureFinalGather: this.profile !== "baseline",
          contactTransport: false,
          sunDirection: [-0.8, 0.6, 1.1],
          sunRadiance: [2, 2, 2],
          skyRadiance: [0.15, 0.18, 0.22],
        });
        this._removePublication?.();
        this.adapter?.dispose();
        this.adapter = undefined;
        this.models.forEach((m) => this.scene.primitives.remove(m));
        if (this.tileset) this.scene.primitives.remove(this.tileset);
        this.models = staged;
        this.tileset = stagedTiles;
        this.world = world;
        this.frame = frame;
        this.manifest = manifest;
        this.geometry = geometry;
        this._snapshotBytes = snapshotBytes;
        this._snapshotUri = snapshotUri;
        this._geometryUri = dataUri(
          new TextEncoder().encode(JSON.stringify(frozen)),
          "application/json",
        );
        committed = true;
        this._committedGeneration = token;
        pending.models = [];
        pending.tileset = undefined;
        pending.geometry = undefined;
        pending.bytes = 0;
        l.enabled = true;
        l.coverage = 0;
        l.iblPolicy = "enhanced";
        this.models.forEach((m) => (m.show = true));
        if (this.tileset) this.tileset.show = true;
        l.finalGather.setModels(this.models, true);
        l.finalGather.configure({
          mode: profiles[this.profile].mode,
          quality: "auto",
          sampling: "reconstructed",
          smoothReceivers: false,
        });
        if (this.tileset)
          this.adapter = new LumenTilesAdapter(
            this.scene,
            this.tileset,
            l.finalGather,
          );
        this._lighting({
          sunDirection: [-0.8, 0.6, 1.1],
          sunRadiance: [2, 2, 2],
        });
        this.phase = "lighting";
        this.onDatasetCommitted?.({
          anchor: manifest.anchor,
          version: manifest.version,
        });
        this._removePublication = world.publicationEvent.addEventListener(
          (event) => {
            if (
              !this.disposed &&
              this.world === world &&
              event.revision === world.requestedRevision
            ) {
              l.coverage = 1;
              this.scene.requestRender();
            }
          },
        );
      }, signal);
      await this._wait(this.world.completed, signal);
      this._guard(token, signal);
      await this._afterFrame(() => {}, signal);
      while (
        this.models.some((model) => !model.ready) ||
        (this.awaitDisplay &&
          this.tileset &&
          (!this.tileset.tilesLoaded ||
            this.adapter.status().activeModels === 0))
      ) {
        this._guard(token, signal);
        await this._afterFrame(() => {}, signal);
      }
      await this._afterFrame(() => {}, signal);
      this._guard(token, signal);
      if (this.profile === "contact-experimental")
        await this._experimental(signal);
      this.phase = this._cacheFailure ? "degraded" : "available";
      this.timings.push({
        type: "load",
        generation: token,
        wallMilliseconds: performance.now() - start,
        version: manifest.version,
        plan: geometry.plan,
      });
      return this.status();
    } catch (error) {
      if (!committed) {
        staged.forEach((m) => {
          if (!m.isDestroyed()) {
            if (!this.scene.isDestroyed() && this.scene.primitives.contains(m))
              this.scene.primitives.remove(m);
            else m.destroy();
          }
        });
        if (stagedTiles && !stagedTiles.isDestroyed()) {
          if (
            !this.scene.isDestroyed() &&
            this.scene.primitives.contains(stagedTiles)
          )
            this.scene.primitives.remove(stagedTiles);
          else stagedTiles.destroy();
        }
      }
      if (token === this.generation && !this.disposed) {
        if (committed) {
          this.scene.lumen.coverage = 0;
          this.scene.lumen.unloadWorld();
          this.world = undefined;
        }
        this.phase = this._contextLost
          ? "context-lost"
          : this._renderError
            ? "failed"
            : error.name === "AbortError"
              ? "cancelled"
              : "failed";
        this.error = this._contextLost
          ? "Context lost: recreate Scene/session"
          : (this._renderError ?? String(error));
        this.scene.requestRender();
      }
      throw error;
    } finally {
      this._pendingResources.delete(token);
    }
  }
  cancel() {
    if (this.disposed || this.ready) return this.status();
    const generation = this.generation;
    this._controller?.abort();
    ++this.generation;
    if (
      this._committedGeneration === generation &&
      this.world === this.scene.lumen.world
    ) {
      this.scene.lumen.coverage = 0;
      this.scene.lumen.unloadWorld();
      this.world = undefined;
      this.scene.lumen.finalGather.setModels([], true);
    }
    this.phase = "cancelled";
    this.error = "Operation cancelled";
    return this.status();
  }
  async setDisplayDetail(detail) {
    if (
      !this.ready ||
      !this.tileset ||
      !["parent", "children", "auto"].includes(detail)
    )
      throw Error("Available Tiles session/detail required");
    await this._afterFrame(() => {
      this.tileset.maximumScreenSpaceError =
        detail === "parent" ? 1000000 : detail === "children" ? 1 : 16;
      this.scene.requestRender();
    }, this._controller.signal);
    return this.status();
  }
  evictDisplay() {
    if (!this.tileset || this.disposed)
      throw Error("Live Tiles session required");
    this.tileset.trimLoadedTiles();
    this.scene.requestRender();
  }
  _lighting(changes) {
    const C = this.C,
      toward = C.Cartesian3.normalize(
        C.Cartesian3.fromArray(
          changes.sunDirection ?? this.world.options.sunDirection,
        ),
        new C.Cartesian3(),
      ),
      direction = C.Matrix4.multiplyByPointAsVector(
        this.frame,
        toward,
        new C.Cartesian3(),
      );
    C.Cartesian3.negate(direction, direction);
    const radiance = changes.sunRadiance ?? this.world.options.sunRadiance,
      intensity = Math.max(...radiance, 0.000001);
    this.scene.light = new C.DirectionalLight({
      direction,
      color: new C.Color(...radiance.map((v) => v / intensity)),
      intensity,
    });
    const managers = new Set(
      [
        ...this.models.map((m) => m.environmentMapManager),
        this.tileset?.environmentMapManager,
      ].filter(Boolean),
    );
    for (const manager of managers) {
      manager.atmosphereScatteringIntensity = intensity;
      manager.reset();
    }
  }
  async setLighting(changes) {
    if (!this.ready || !this.world) throw Error("Dataset is not available");
    const world = this.world,
      token = this.generation,
      signal = this._controller.signal,
      start = performance.now();
    const allowed = ["sunDirection", "sunRadiance", "skyRadiance"];
    if (
      Object.keys(changes).some((k) => !allowed.includes(k)) ||
      Object.values(changes).some(
        (v) => !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite),
      ) ||
      ["sunRadiance", "skyRadiance"].some((k) =>
        changes[k]?.some((v) => v < 0),
      ) ||
      (changes.sunDirection && Math.hypot(...changes.sunDirection) < 1e-6)
    )
      throw Error("Finite nonnegative RGB and nonzero sun direction required");
    this.phase = "lighting";
    this.scene.lumen.coverage = 0;
    this._lighting(changes);
    const completed = world.solve(changes),
      first = world.firstPublished;
    try {
      const firstResult = await this._wait(first, signal);
      this._guard(token, signal);
      const firstSubmitted = performance.now() - start;
      await this._afterFrame(() => {}, signal);
      const firstFrameSubmitted = performance.now() - start;
      await this._wait(completed, signal);
      this._guard(token, signal);
      const finalPublished = performance.now() - start;
      await this._afterFrame(() => {}, signal);
      if (this.profile === "contact-experimental")
        await this._experimental(signal);
      this.phase = this._cacheFailure ? "degraded" : "available";
      this.timings.push({
        type: "lighting",
        firstSubmitted,
        firstFrameSubmitted,
        firstVisible: "not-run",
        finalPublished,
        finalFrameSubmitted: performance.now() - start,
        finalVisible: "not-run",
        timingScope:
          "CPU publication/postRender submission; rendered pixel visibility requires separate diagnostics",
        revision: firstResult.revision,
      });
      return this.status();
    } catch (error) {
      if (token === this.generation && !this.disposed) {
        this.phase = "failed";
        this.error = String(error);
        this.scene.lumen.coverage = 0;
      }
      throw error;
    }
  }
  async setQuality(profile) {
    if (!this.ready)
      throw Error("Quality changes require an available dataset");
    if (!profiles[profile] || this.disposed)
      throw Error("Unknown profile or disposed session");
    this.phase = "quality";
    this.profile = profile;
    this._cacheFailure = undefined;
    const token = this.generation,
      signal = this._controller.signal;
    if (this.world?.surfaceCache) {
      this.world.surfaceCache.destroy();
      this.world.surfaceCache = undefined;
    }
    try {
      await this._wait(
        this.scene.lumen.finalGather.configure({
          mode: profiles[profile].mode,
          quality: "auto",
          sampling: "reconstructed",
        }),
        signal,
      );
      this._guard(token, signal);
      if (profile === "contact-experimental" && this.world?.ready)
        await this._experimental(this._controller.signal);
      this.phase = this.world?.ready
        ? this._cacheFailure
          ? "degraded"
          : "available"
        : "empty";
      this._guard(token, signal);
      return this.status();
    } catch (error) {
      if (token === this.generation && !this.disposed) {
        this.phase = "failed";
        this.error = String(error);
      }
      throw error;
    }
  }
  async _experimental(signal) {
    signal.throwIfAborted();
    try {
      this.cache = await this.world.buildSurfaceRadiance({
        spacing: 0.08,
        samples: 256,
      });
      signal.throwIfAborted();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      this._cacheFailure = "Experimental cache unavailable: " + String(error);
    }
  }
  _account() {
    if (this.disposed) return;
    const w = this.world,
      fg = this.scene.lumen.finalGather;
    const modelBytes = (m) =>
      (m.statistics?.geometryByteLength ??
        m._statistics?.geometryByteLength ??
        0) +
      (m.statistics?.texturesByteLength ??
        m._statistics?.texturesByteLength ??
        0);
    const geometryBytes = (g) =>
      g
        ? [g.positions, g.normals, g.uvs, g.materialIds, g.owners].reduce(
            (s, a) => s + (a?.byteLength ?? 0),
            0,
          ) + g.images.reduce((s, im) => s + (im?.data?.byteLength ?? 0), 0)
        : 0;
    const pending = [...this._pendingResources.values()],
      transientCpu = pending.reduce(
        (s, p) => s + p.bytes + geometryBytes(p.geometry),
        0,
      ),
      transientGpu = pending.reduce(
        (s, p) =>
          s +
          p.models.reduce((n, m) => n + modelBytes(m), 0) +
          (p.tileset?.totalMemoryUsageInBytes ?? 0),
        0,
      );
    const managers = new Set(
      [
        ...this.models.map((m) => m.environmentMapManager),
        this.tileset?.environmentMapManager,
        ...pending.flatMap((p) => p.models.map((m) => m.environmentMapManager)),
        ...pending.map((p) => p.tileset?.environmentMapManager),
      ].filter(Boolean),
    );
    const environmentTextures = new Set();
    for (const manager of managers)
      for (const texture of [
        manager._radianceCubeMap,
        manager._irradianceMapTexture,
        ...(manager._radianceMapTextures ?? []),
        ...(manager._specularMapTextures ?? []),
      ])
        if (texture && !texture.isDestroyed()) environmentTextures.add(texture);
    const environmentGpu = [...environmentTextures].reduce(
      (n, t) => n + (t.sizeInBytes ?? 0),
      0,
    );
    const modelGpu =
      environmentGpu +
      transientGpu +
      this.models.reduce(
        (s, m) =>
          s +
          (m.statistics?.geometryByteLength ??
            m._statistics?.geometryByteLength ??
            0) +
          (m.statistics?.texturesByteLength ??
            m._statistics?.texturesByteLength ??
            0),
        0,
      ) +
      (this.tileset?.totalMemoryUsageInBytes ?? 0);
    const g = this.geometry,
      packetBuffers = new Set();
    const countPacket = (v) => {
      if (ArrayBuffer.isView(v)) {
        if (packetBuffers.has(v.buffer)) return 0;
        packetBuffers.add(v.buffer);
        return v.buffer.byteLength;
      }
      if (v && typeof v === "object")
        return Object.values(v).reduce((n, x) => n + countPacket(x), 0);
      return 0;
    };
    const cpu =
      transientCpu +
      (this._snapshotBytes ?? 0) +
      geometryBytes(g) +
      (w?.packet?.bvh?.cpuRetainedBytes ?? 0) +
      countPacket(w?.packet);
    const giGpu = w?.metrics?.memory?.currentBytes ?? 0;
    fg.additionalSceneBytes = cpu + modelGpu + giGpu;
    const known =
      fg.additionalOwnedBytes +
      (fg.metrics.memoryBytes ?? 0) +
      (fg.metrics.snapshotBytes ?? 0);
    this.peakKnownBytes = Math.max(this.peakKnownBytes, known);
    this.resources = {
      transientCpu,
      transientGpu,
      environmentGpu,
      giGpu,
      displayGpu: modelGpu,
      cpuKnown: cpu,
      fgGpu: fg.metrics.memoryBytes ?? 0,
      snapshots: fg.metrics.snapshotBytes ?? 0,
      knownAdditionalBytes: known,
      peakKnownBytes: this.peakKnownBytes,
      budget: 64 * 1048576,
      driverVram: "not-run",
      jsAllocator: "not-run",
    };
  }
  status() {
    if (this.scene.isDestroyed())
      return {
        phase: "disposed",
        ready: false,
        pilotReady: false,
        world: null,
        targets: 0,
        error: "Scene destroyed",
      };
    return {
      pilotReady: false,
      anchor: this.manifest?.anchor,
      phase: this.phase,
      ready: this.ready,
      error: this.error,
      display: this.display,
      profile: this.profile,
      effectiveProfile: this._cacheFailure ? "enhanced" : this.profile,
      fg: {
        requestedMode: this.scene.lumen.finalGather.mode,
        ...this.scene.lumen.finalGather.metrics,
        receiverSize: [
          this.scene.lumen.finalGather.receiverSize.x,
          this.scene.lumen.finalGather.receiverSize.y,
        ],
        drawingBuffer: [
          this.scene.drawingBufferWidth,
          this.scene.drawingBufferHeight,
        ],
      },
      fallbackReason:
        this._cacheFailure ?? this.scene.lumen.finalGather.metrics.status,
      generation: this.generation,
      datasetId: this.manifest?.datasetId,
      version: this.manifest?.version,
      audit: this.audit,
      plan: this.geometry?.plan,
      targets: this.scene.lumen.finalGather.models.size,
      ownerCounter: this.scene.lumen.finalGather._nextSurfaceOwner,
      world: this.world
        ? {
            revision: this.world.requestedRevision,
            publishedRevision: this.world.publishedRevision,
            round: this.world.publishedBounce,
            triangles: this.world.packet?.bvh?.triangles,
            ready: this.world.ready,
          }
        : null,
      tiles: this.adapter?.status(),
      resources: this.resources,
      timings: this.timings,
      experimentalFailures: profiles[this.profile]?.experimental
        ? {
            r10FinalPixels: "18/60 failed",
            oneRound: "2 failed",
            pilotReady: false,
          }
        : undefined,
    };
  }
  async diagnostics({
    points,
    geometry = false,
    image = false,
    pixels,
    usedOnly = false,
  } = {}) {
    if (
      !this.ready &&
      !(
        pixels &&
        usedOnly &&
        this.phase === "lighting" &&
        this.world?.ready &&
        this.world.publishedRevision === this.world.requestedRevision
      )
    )
      throw Error(
        "Diagnostics require available static dataset or a published lighting frame",
      );
    if (pixels) return capturePixels(this, pixels, { usedOnly });
    if (image)
      return this._afterFrame(() => {
        this.world.metrics.diagnosticReadbacks++;
        return {
          png: this.canvas.toDataURL("image/png"),
          width: this.scene.drawingBufferWidth,
          height: this.scene.drawingBufferHeight,
          scope:
            "Explicit normal-render canvas serialization; no production reads",
        };
      }, this._controller.signal);
    if (geometry)
      return {
        uri: this._geometryUri,
        audit: this.audit,
        plan: this.geometry.plan,
      };
    if (
      !Array.isArray(points) ||
      points.some(
        (p) =>
          [p.position, p.normal, p.geometricNormal ?? p.normal].some(
            (v) =>
              !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite),
          ) ||
          Math.hypot(...p.normal) < 1e-6 ||
          Math.hypot(...(p.geometricNormal ?? p.normal)) < 1e-6,
      )
    )
      throw Error("Finite diagnostic points and nonzero normals required");
    const world = this.world,
      token = this.generation,
      revision = world.requestedRevision,
      signal = this._controller.signal;
    const values = await this._wait(
      this.profile === "baseline"
        ? world.sample(points)
        : world.sampleFinalGather(points, {
            samples: 1024,
            seed: 0,
            sampling: "reconstructed",
            epoch: 31,
          }),
      signal,
    );
    this._guard(token, signal);
    if (world !== this.world || revision !== world.requestedRevision)
      throw aborted();
    return {
      generation: token,
      version: this.manifest.version,
      revision,
      values,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this._sceneMonitor);
    ++this.generation;
    this._controller?.abort();
    this._removePublication?.();
    this._removeBudget();
    this._removeRenderError();
    this.adapter?.dispose();
    this.canvas.removeEventListener("webglcontextlost", this._lost);
    document.removeEventListener("visibilitychange", this._visibility);
    if (!this.scene.isDestroyed()) {
      const l = this.scene.lumen;
      if (l.world === this.world) l.unloadWorld();
      l.finalGather.setModels([], true);
      this.models.forEach((model) => this.scene.primitives.remove(model));
      if (this.tileset) this.scene.primitives.remove(this.tileset);
      l.finalGather.additionalSceneBytes = 0;
      l.enabled = this._previous.enabled;
      l.coverage = this._previous.coverage;
      l.iblPolicy = this._previous.iblPolicy;
      this.scene.light = this._previous.light;
    }
    this.models = [];
    this.tileset = this.world = this.geometry = undefined;
    this._snapshotUri = this._geometryUri = undefined;
    this._snapshotBytes = 0;
    this.onDatasetCommitted = undefined;
    this.resources = {
      knownAdditionalBytes: 0,
      peakKnownBytes: this.peakKnownBytes,
      scope:
        "Released logical ownership; pending cancelled construction settles asynchronously",
      driverVram: "not-run",
      jsAllocator: "not-run",
    };
    this.phase = "disposed";
    sessions.delete(this.scene);
  }
}
export { profiles };
