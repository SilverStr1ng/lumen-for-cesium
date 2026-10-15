import { LatestRequests, afterFrame } from "./session-requests.js";
import { capturePixels } from "./session-diagnostics.js";
import { readContainer } from "./gltf-container.js";
import ResourceBudget from "./resource-budget.js";
import { FrozenResourceCache, imageDimensions } from "./frozen-resources.js";
import { collectResources, bufferKeys } from "./session-resources.js";
import { atlasBytes, worldGpuBound } from "./pilot-resource-plan.js";
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
    this._datasetReady = false;
    this._visibleController = new AbortController();
    this.models = [];
    this.audit = [];
    this.timings = [];
    this.peakKnownBytes = 0;
    this._pendingResources = new Map();
    this.budget = new ResourceBudget();
    this._frozenCache = new FrozenResourceCache(this.budget);
    this._previousBudget = scene.lumen.resourceBudget;
    scene.lumen.resourceBudget = this.budget;
    this.budget.refresh = () => this._account();
    this.budget.onPressure = (bytes) => {
      if (this._budgetRelief) return;
      const fg = scene.lumen.finalGather;
      if (fg.quality !== "auto" || !fg.receiver) return;
      this._budgetRelief = true;
      try {
        this.budget.extraPlanningBytes = bytes;
        const plan = fg._layout(fg.metrics.snapshotBytes ?? 0);
        // Admission may shrink Auto's workspace during load/relight. The same
        // resource-aware plan is used by the next production frame.
        if (plan.supported) fg._allocate(plan);
        else fg.release();
      } finally {
        this.budget.extraPlanningBytes = 0;
        this._budgetRelief = false;
      }
    };
    this._displayRemovers = [];
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
      this._lightingRequests?.close("fatal Scene render error");
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
      this._datasetReady = false;
      this._lightingRequests?.close("context lost");
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
    return this._datasetReady && ["available", "degraded"].includes(this.phase);
  }
  _guard(token, signal) {
    if (this.disposed || token !== this.generation || signal?.aborted)
      throw aborted();
  }
  _afterFrame(action, signal, timeoutMilliseconds) {
    return afterFrame(this.scene, action, signal, timeoutMilliseconds);
  }
  displayStatus() {
    const camera = this.scene.camera;
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    const visible = this.tileset
      ? (this.adapter?.status().activeModels ?? 0) > 0
      : this.models.some(
          (model) =>
            model.ready &&
            model.show &&
            cullingVolume.computeVisibility(model.boundingSphere) !==
              this.C.Intersect.OUTSIDE,
        );
    return {
      outcome: visible ? "visible" : "no-visible-content",
      visible,
      modelsReady: this.models.filter((model) => model.ready).length,
      tilesLoadedForCurrentView: this.tileset?.tilesLoaded,
      adapter: this.adapter?.status(),
    };
  }
  async waitForVisible({ timeoutMilliseconds = 5000, signal } = {}) {
    if (
      !Number.isFinite(timeoutMilliseconds) ||
      timeoutMilliseconds < 0 ||
      timeoutMilliseconds > 60000
    )
      throw Error("Visible wait must be between 0 and 60000ms");
    const token = this.generation,
      signals = [
        this._controller?.signal,
        this._visibleController.signal,
        signal,
      ].filter(Boolean),
      combined = AbortSignal.any(signals),
      deadline = performance.now() + timeoutMilliseconds;
    while (true) {
      this._guard(token, combined);
      const display = this.displayStatus();
      if (display.visible || performance.now() >= deadline)
        return {
          ...display,
          generation: token,
          datasetReady: this._datasetReady,
        };
      try {
        await this._afterFrame(
          () => {},
          combined,
          Math.max(1, deadline - performance.now()),
        );
      } catch (error) {
        if (error.name !== "TimeoutError") throw error;
        return {
          ...this.displayStatus(),
          generation: token,
          datasetReady: this._datasetReady,
          reason: error.message,
        };
      }
    }
  }
  _wait(promise, signal, timeoutMilliseconds = 30000, progress) {
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        clean();
        reject(aborted());
      };
      let previousProgress = progress?.();
      const timer = setInterval(() => {
        const nextProgress = progress?.();
        if (progress && nextProgress !== previousProgress) {
          previousProgress = nextProgress;
          return;
        }
        clean();
        reject(
          new DOMException(
            "Session stage exceeded deadline: " +
              JSON.stringify({
                phase: this.phase,
                worldStatus: this.world?.status,
                submittedFrames: this.world?.metrics.submittedFrames,
                progress: this.world?.progress,
              }),
            "TimeoutError",
          ),
        );
      }, timeoutMilliseconds);
      signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          clean();
          resolve(value);
        },
        (error) => {
          clean();
          reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  }
  async load(uri) {
    return this.replaceDataset(uri);
  }
  _nativeFactory(pending, create, signal) {
    pending.factories = (pending.factories ?? 0) + 1;
    let promise;
    try {
      promise = create();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const owned = Promise.resolve(promise).finally(() => {
      pending.factories--;
      if (pending.closed && !pending.factories) pending.release();
    });
    return this._wait(owned, signal);
  }
  async replaceDataset(uri) {
    if (this.disposed) throw aborted();
    if (this._renderError)
      throw Error("Scene rendering stopped: recreate host before loading");
    const token = ++this.generation;
    this._controller?.abort();
    this._lightingRequests?.close();
    this._visibleController.abort();
    this._visibleController = new AbortController();
    const controller = (this._controller = new AbortController()),
      signal = controller.signal,
      start = performance.now();
    this.phase = "auditing";
    this.stage = "fetch-manifest";
    this.error = undefined;
    this._cacheFailure = undefined;
    this.audit = [];
    const staged = [];
    const resources = this._frozenCache.scope(signal);
    let stagedTiles,
      committed = false;
    const displayRemovers = [];
    let displayError;
    const failDisplay = (error) => {
      if (token !== this.generation || this.disposed) return;
      displayError =
        "Display loading failed: " + String(error?.message ?? error);
      this._lightingRequests?.close(displayError);
      controller.abort();
      // Events may occur inside Model.update/tile traversal. Retire GI after it.
      queueMicrotask(() => {
        if (token !== this.generation || this.disposed) return;
        this.phase = "failed";
        this.error = displayError;
        if (committed && !this.scene.isDestroyed()) {
          this.scene.lumen.coverage = 0;
          if (this.scene.lumen.world === this.world)
            this.scene.lumen.unloadWorld();
          this.world = undefined;
          this.scene.lumen.finalGather.setModels([], true);
        }
      });
    };
    const pending = { models: staged, tileset: undefined, resources };
    pending.release = () => {
      pending.geometryLease?.release();
      pending.nativeLease?.release();
      if (!committed) resources.close();
      this._pendingResources.delete(token);
      this._account();
    };
    this._pendingResources.set(token, pending);
    try {
      const absolute = new URL(uri, document.baseURI).href,
        raw = await resources.manifest(absolute),
        manifest = validateManifest(structuredClone(raw));
      if (!manifest.resources || !Object.keys(manifest.resources).length)
        throw Error("Immutable resource SHA manifest required");
      this.stage = "verify-resources";
      await resources.verify(manifest.resources, absolute);
      // Decode only the already verified bytes; a second network fetch could change versions.
      const fetchFrozen = async (input) => {
        return resources.response(new URL(input, absolute));
      };
      this.stage = "freeze-assets";
      const snapshots = [];
      const giImages = new Map();
      let triangles = 0,
        nativeBytes = 0,
        imageBytes = 0;
      for (const a of manifest.assets) {
        this._guard(token, signal);
        const source = await resources.asset(new URL(a.renderUri, absolute));
        const audit = auditGltf(source.gltf);
        const gi = a.giUri
          ? await resources.asset(new URL(a.giUri, absolute))
          : source;
        auditGltf(gi.gltf);
        for (const image of gi.gltf.images ?? [])
          giImages.set(
            image.uri,
            imageDimensions(resources.cache.byUrl.get(image.uri).bytes).bytes,
          );
        snapshots.push({ ...a, renderUri: source.url, giUri: gi.url });
        const triangleCount = (g) => {
          const visit = (id) => {
            const node = g.nodes[id];
            return (
              (node.mesh === undefined
                ? 0
                : g.meshes[node.mesh].primitives.reduce(
                    (n, p) =>
                      n +
                      g.accessors[p.indices ?? p.attributes.POSITION].count / 3,
                    0,
                  )) + (node.children ?? []).reduce((n, id) => n + visit(id), 0)
            );
          };
          return g.scenes[g.scene ?? 0].nodes.reduce(
            (n, id) => n + visit(id),
            0,
          );
        };
        triangles += triangleCount(gi.gltf);
        nativeBytes += (source.gltf.buffers ?? []).reduce(
          (n, b) => n + b.byteLength * 2,
          0,
        );
        for (const image of source.gltf.images ?? [])
          imageBytes += imageDimensions(
            resources.cache.byUrl.get(image.uri).bytes,
          ).bytes;
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
      if (!Number.isSafeInteger(triangles) || triangles > 200000)
        throw Error("Expanded dataset triangle input limit");
      // Includes JS expansion/accessor scratch, transfer/packing CPU buffers and
      // atlas slots. Native capacity also covers later resident parent+child LOD.
      const geometryLease = this.budget.reserve(
        Math.ceil(
          triangles * 512 +
            resources.inputBytes * 2 +
            imageBytes * 3 +
            atlasBytes(giImages.size) +
            [...giImages.values()].reduce((n, bytes) => n + bytes * 3, 0),
        ),
        "geometry preparation",
      );
      pending.geometryLease = geometryLease;
      const frozen = { ...manifest, assets: snapshots },
        geometry = await loadDatasetGeometry(
          frozen,
          absolute,
          (phase) => {
            this.stage = "geometry: " + phase;
          },
          signal,
        );
      pending.geometry = geometry;
      const snapshotUri = await resources.json(frozen);
      const C = this.C,
        frame = C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(
            manifest.anchor.longitude,
            manifest.anchor.latitude,
            manifest.anchor.height,
          ),
        );
      if (this.display === "models") {
        pending.nativeLease = this.budget.reserve(
          nativeBytes +
            imageBytes * 2 +
            snapshots.length * 524288 +
            resources.inputBytes * 2,
          "native display capacity",
        );
        for (const a of snapshots) {
          this._guard(token, signal);
          this.stage = "native-model: " + a.id;
          const model = await this._nativeFactory(
            pending,
            () =>
              C.Model.fromGltfAsync({
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
              }).then((model) => {
                if (
                  this.disposed ||
                  token !== this.generation ||
                  signal.aborted
                ) {
                  if (!model.isDestroyed()) model.destroy();
                  throw aborted();
                }
                return model;
              }),
            signal,
          );
          staged.push(model);
          displayRemovers.push(model.errorEvent.addEventListener(failDisplay));
          this._guard(token, signal);
          this.scene.primitives.add(model);
        }
      } else {
        nativeBytes = imageBytes = 0;
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
            // fetchFrozen is indexed by canonical URL and already SHA-verified.
            // Basenames alias nested resources and must never identify an asset.
            const entry = resources.verified.get(resource.href);
            const container = await readContainer(
              resource.href,
              signal,
              fetchFrozen,
            );
            auditGltf(container.gltf);
            if (
              container.format !== "glb" ||
              container.gltf.buffers.some((b) => b.uri) ||
              (container.gltf.images ?? []).some((im) => im.uri)
            )
              throw Error("Pilot Tiles require self-contained GLB");
            const snapshot = await resources.asset(resource.href);
            nativeBytes += snapshot.gltf.buffers.reduce(
              (n, b) => n + b.byteLength * 2,
              0,
            );
            for (const image of snapshot.gltf.images ?? [])
              imageBytes += imageDimensions(
                resources.cache.byUrl.get(image.uri).bytes,
              ).bytes;
            node.content.uri = entry.url;
          }
          for (const child of node.children ?? []) await freeze(child);
        };
        await freeze(tiles.root);
        tiles.root.transform = C.Matrix4.toArray(frame);
        const tileSnapshot = await resources.json(tiles);
        pending.nativeLease = this.budget.reserve(
          nativeBytes + imageBytes * 2 + 524288 + resources.inputBytes * 2,
          "native display capacity",
        );
        this.stage = "native-tiles";
        stagedTiles = await this._nativeFactory(
          pending,
          () =>
            C.Cesium3DTileset.fromUrl(tileSnapshot, {
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
            }).then((tileset) => {
              if (
                this.disposed ||
                token !== this.generation ||
                signal.aborted
              ) {
                if (!tileset.isDestroyed()) tileset.destroy();
                throw aborted();
              }
              return tileset;
            }),
          signal,
        );
        pending.tileset = stagedTiles;
        displayRemovers.push(
          stagedTiles.tileFailed.addEventListener(failDisplay),
        );
        this._guard(token, signal);
        this.scene.primitives.add(stagedTiles);
      }
      this._guard(token, signal);
      this.stage = "commit-frame";
      await this._afterFrame(() => {
        this._guard(token, signal);
        const l = this.scene.lumen;
        this._account();
        const retiredKeys = bufferKeys(this.world?.packet);
        for (const value of [
          this.world?._prepared,
          this.world?._order,
          this.world?._baseMaterials,
        ])
          bufferKeys(value, retiredKeys);
        if (this.world?.worker) retiredKeys.add(this.world.worker);
        const retired = [...this.budget.entries.values()].reduce(
          (n, e) =>
            n +
            (retiredKeys.has(e.key) ||
            ["giGpu", "snapshotGpu", "fgGpu"].includes(e.category)
              ? e.bytes
              : 0),
          0,
        );
        const prospective =
          this.budget.admittedBytes -
          retired +
          worldGpuBound(geometry, this.profile !== "baseline");
        if (prospective > this.budget.limit)
          throw new DOMException(
            `World admission ${prospective}/${this.budget.limit}B; matching old dataset retained`,
            "QuotaExceededError",
          );
        // World constructor validates/posts before old illumination is retired.
        const world = l.loadWorld({
          backend: "gpu",
          workerUrl: this.workerUrl,
          url: snapshotUri,
          preparedGeometry: geometry,
          modelMatrix: frame,
          spacing: manifest.gi.spacing,
          rays: manifest.gi.rays,
          bounces: manifest.gi.bounces,
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
        this._removePublication = undefined;
        this._displayRemovers.forEach((remove) => remove());
        this._displayRemovers = displayRemovers;
        this.adapter?.dispose();
        this.adapter = undefined;
        this.models.forEach((m) => this.scene.primitives.remove(m));
        if (this.tileset) this.scene.primitives.remove(this.tileset);
        this._resources?.close();
        this._nativeLease?.release();
        this._resources = resources;
        this._nativeLease = pending.nativeLease;
        pending.nativeLease = undefined;
        this.models = staged;
        this.tileset = stagedTiles;
        this.world = world;
        pending.world = world;
        this._datasetReady = false;
        this._lightingTarget = undefined;
        this.frame = frame;
        this.manifest = manifest;
        this.geometry = geometry;
        this._snapshotUri = snapshotUri;
        this._frozenManifest = frozen;
        committed = true;
        this._committedGeneration = token;
        pending.models = [];
        pending.tileset = undefined;
        pending.geometry = undefined;
        l.enabled = true;
        l.coverage = 0;
        l.iblPolicy = "enhanced";
        // Start the resident GI independently. Showing native content here can
        // synchronously compile its forward shader before the preparation
        // worker's first message is delivered, falsely timing out GI loading.
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
      this.stage = "gi-solve";
      await this._wait(
        this.world.completed,
        signal,
        30000,
        () => this.world?.status + ":" + this.world?.metrics.submittedFrames,
      );
      this._guard(token, signal);
      await this._afterFrame(() => {}, signal);
      // GI/data readiness is independent of viewport visibility and tile traversal.
      this._guard(token, signal);
      if (this.profile === "contact-experimental")
        await this._experimental(signal);
      this._guard(token, signal);
      this.stage = "ready";
      this._datasetReady = true;
      this.models.forEach((m) => (m.show = true));
      if (this.tileset) this.tileset.show = true;
      this.scene.requestRender();
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
      controller.abort();
      if (!committed) {
        displayRemovers.forEach((remove) => remove());
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
            : displayError
              ? "failed"
              : error.name === "AbortError"
                ? "cancelled"
                : "failed";
        this.error = this._contextLost
          ? "Context lost: recreate Scene/session"
          : (displayError ?? this._renderError ?? String(error));
        this.scene.requestRender();
      }
      throw error;
    } finally {
      pending.closed = true;
      if (!pending.factories) pending.release();
    }
  }
  cancel() {
    this._visibleController.abort();
    this._visibleController = new AbortController();
    if (this.disposed || this.ready) return this.status();
    this._lightingRequests?.close();
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
  setLighting(changes) {
    if (
      !this._datasetReady ||
      !this.world ||
      !["available", "degraded", "lighting"].includes(this.phase)
    )
      return Promise.reject(Error("Dataset is not available"));
    const allowed = ["sunDirection", "sunRadiance", "skyRadiance"];
    if (
      !changes ||
      Object.keys(changes).some((k) => !allowed.includes(k)) ||
      Object.values(changes).some(
        (v) => !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite),
      ) ||
      ["sunRadiance", "skyRadiance"].some((k) =>
        changes[k]?.some((v) => v < 0),
      ) ||
      (changes.sunDirection && Math.hypot(...changes.sunDirection) < 1e-6)
    )
      return Promise.reject(
        Error("Finite nonnegative RGB and nonzero sun direction required"),
      );
    this._lightingTarget ??= Object.fromEntries(
      allowed.map((key) => [key, [...this.world.options[key]]]),
    );
    Object.assign(this._lightingTarget, structuredClone(changes));
    if (!this._lightingRequests || this._lightingRequests.closed)
      this._lightingRequests = new LatestRequests((value, requestId) =>
        this._runLighting(value, requestId),
      );
    const datasetGeneration = this.generation;
    return this._lightingRequests
      .submit(structuredClone(this._lightingTarget))
      .then((result) => ({ ...result, datasetGeneration }));
  }
  async _runLighting(changes, requestId) {
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
    try {
      this.phase = "lighting";
      this.scene.lumen.coverage = 0;
      this._lighting(changes);
      const completed = world.solve(changes),
        first = world.firstPublished;
      const progress = () => world.status + ":" + world.metrics.submittedFrames;
      const firstResult = await this._wait(first, signal, 30000, progress);
      this._guard(token, signal);
      const firstSubmitted = performance.now() - start;
      await this._afterFrame(() => {}, signal);
      const firstFrameSubmitted = performance.now() - start;
      await this._wait(completed, signal, 30000, progress);
      this._guard(token, signal);
      const finalPublished = performance.now() - start;
      await this._afterFrame(() => {}, signal);
      if (this.profile === "contact-experimental")
        await this._experimental(signal);
      this._guard(token, signal);
      this.phase = this._lightingRequests.pending
        ? "lighting"
        : this._cacheFailure
          ? "degraded"
          : "available";
      this.timings.push({
        type: "lighting",
        requestId,
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
      if (token === this.generation && !this.disposed && !signal.aborted) {
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
      this._guard(token, signal);
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
    const token = this.generation;
    let lease;
    try {
      lease = this.budget.reserve(
        12 * 1048576 + 16384,
        "experimental cache preparation",
      );
      const cache = await this.world.buildSurfaceRadiance({
        spacing: 0.08,
        samples: 256,
      });
      this._guard(token, signal);
      this.cache = cache;
    } catch (error) {
      this._guard(token, signal);
      if (error.name === "AbortError") throw error;
      this._cacheFailure = "Experimental cache unavailable: " + String(error);
    } finally {
      lease?.release();
    }
  }
  _account() {
    if (this.disposed) {
      const entries = this._frozenCache.allocations();
      for (const pending of this._pendingResources.values())
        for (const buffer of bufferKeys(pending.geometry))
          entries.push({
            key: buffer,
            bytes: buffer.byteLength,
            category: "cancelledGeometryCpu",
          });
      this.budget.observe(entries);
      this.resources = {
        ...this.budget.report(),
        scope:
          "Disposed; unabortable native factories retain admission until they settle",
      };
      return;
    }
    const entries = collectResources(this);
    const sum = (categories) =>
      entries.reduce(
        (n, e) => n + (categories.includes(e.category) ? e.bytes : 0),
        0,
      );
    const pending = [...this._pendingResources.values()];
    // Capacity reservations are consumed by observed allocations, never added
    // again to the bytes that already occupy those identities.
    const nativeBytes = (models, tileset) => {
      const owners = new Set(models);
      models.forEach((m) => {
        if (!m.isDestroyed()) owners.add(m.environmentMapManager);
      });
      owners.add(tileset?.environmentMapManager);
      return entries.reduce(
        (n, e) => n + ([...e.owners].some((o) => owners.has(o)) ? e.bytes : 0),
        0,
      );
    };
    this._nativeLease?.cover(
      nativeBytes(
        [...this.models, ...(this.adapter?.loaded ?? [])],
        this.tileset,
      ),
    );
    for (const p of pending) {
      p.nativeLease?.cover(nativeBytes(p.models, p.tileset));
      const keys = bufferKeys(p.geometry);
      for (const v of [
        p.world?.packet,
        p.world?._prepared,
        p.world?._order,
        p.world?._baseMaterials,
      ])
        bufferKeys(v, keys);
      if (p.world?.worker) keys.add(p.world.worker);
      p.geometryLease?.cover(
        entries.reduce((n, e) => n + (keys.has(e.key) ? e.bytes : 0), 0),
      );
    }
    this.budget.observe(entries);
    const report = this.budget.report();
    this.peakKnownBytes = report.peakKnownBytes;
    this.resources = {
      ...report,
      giGpu: sum(["giGpu"]),
      snapshots: sum(["snapshotGpu"]),
      fgGpu: sum(["fgGpu"]),
      displayGpu: sum(["displayGpu", "environmentGpu"]),
      cpuKnown: sum([
        "geometryCpu",
        "workerCpu",
        "packetCpu",
        "frozenCpu",
        "blobCpu",
        "displayCpu",
        "ownerCpu",
      ]),
      queryAllowance:
        "4KiB per live timer handle; implementation storage unmeasured",
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
      datasetReady: this._datasetReady && !!this.world,
      displayState: this.displayStatus(),
      lightingRequests: {
        active: this._lightingRequests?.active?.id,
        pending: this._lightingRequests?.pending?.id,
      },
      anchor: this.manifest?.anchor,
      phase: this.phase,
      ready: this.ready,
      error: this.error,
      stage: this.stage,
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
        uri: await this._resources.exportManifest(this._frozenManifest),
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
    this._datasetReady = false;
    this._lightingRequests?.close();
    this._visibleController.abort();
    clearInterval(this._sceneMonitor);
    ++this.generation;
    this._controller?.abort();
    this._removePublication?.();
    this._removePublication = undefined;
    this._displayRemovers.forEach((remove) => remove());
    this._displayRemovers = [];
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
      l.resourceBudget = this._previousBudget;
      this.scene.light = this._previous.light;
    }
    this._resources?.close();
    this._nativeLease?.release();
    this.models = [];
    this.tileset = this.world = this.geometry = undefined;
    this._snapshotUri = this._geometryUri = undefined;
    this._snapshotBytes = 0;
    this.onDatasetCommitted = undefined;
    this._account();
    this.phase = "disposed";
    sessions.delete(this.scene);
  }
}
export { profiles };
