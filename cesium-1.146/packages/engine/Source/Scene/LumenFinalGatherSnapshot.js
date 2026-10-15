import destroyLumenResource from "./destroyLumenResource.js";
import { Cartesian3, PixelDatatype } from "@cesium/core";
// Include explicit diagnostic leases as well as the current world owner.
export function finalGatherSnapshotBytes(world, extra) {
  const snapshots = new Set(world?._fgSnapshots ?? []);
  if (extra) {
    snapshots.add(extra);
  }
  let bytes = 0;
  const textures = new Set();
  for (const snapshot of snapshots) {
    if (!snapshot.destroyed) {
      for (const resource of snapshot.resources ?? []) {
        if (!textures.has(resource.texture))
          bytes += resource.texture.sizeInBytes;
        textures.add(resource.texture);
      }
    }
  }
  return bytes;
}
/** Owned immutable E_(k-1), E_k and material copies. Geometry/moments are
 * immutable world-owned resources; leases cannot outlive that world's geometry.
 * @private */
class LumenFinalGatherSnapshot {
  constructor(world, previous, current) {
    const g = world.packet.grid,
      bytes = 2 * g.width * g.height * 16 + world._materials.sizeInBytes;
    if (world.memoryBytes + bytes > world.maxMemoryBytes) {
      throw Error("Final Gather snapshot exceeds GPU memory budget");
    }
    const fg = world.scene?.lumen?.finalGather;
    if (fg?.lumen?.world === world && fg.mode !== "ddgi") {
      // A smaller budget or retained diagnostic lease may require dropping
      // receiver/history caches before cloning. The next frame replans them.
      if (
        fg.metrics.memoryBytes +
          finalGatherSnapshotBytes(world) +
          bytes +
          (fg.additionalOwnedBytes ?? fg.additionalSceneBytes ?? 0) >
        fg.maxMemoryBytes
      ) {
        fg.release();
      }
      if (
        finalGatherSnapshotBytes(world) +
          bytes +
          (fg.additionalOwnedBytes ?? fg.additionalSceneBytes ?? 0) >
        fg.maxMemoryBytes
      ) {
        throw Error("FG snapshots exceed additional memory budget");
      }
    }
    this.world = world;
    this.references = 1;
    this.resources = [];
    this.revision = world._jobRevision;
    this.round = world._bounce;
    this.versions = Object.freeze({ ...world._jobVersions });
    this.options = world._jobOptions;
    this.light = world._light(this.options);
    for (const value of Object.values(this.light)) {
      if (value && typeof value === "object") {
        Object.freeze(value);
      }
    }
    this.grid = Object.freeze({
      ...g,
      origin: Object.freeze([...g.origin]),
      counts: Object.freeze([...g.counts]),
    });
    this.origin = Cartesian3.clone(world.origin);
    this.counts = Cartesian3.clone(world.counts);
    this.normalBias = world.normalBias;
    this.spacing = world.spacing;
    this.positions = world.positionTexture;
    this.moments = world.distanceTexture ?? world._atlases[current].M;
    this.geometry = {
      nodes: world._nodes,
      vertices: world._vertices,
      uv: world._uv,
      atlas: world._atlas,
    };
    const copy = (source) => {
      const texture = world._texture(
        source.width,
        source.height,
        PixelDatatype.FLOAT,
        undefined,
        source.sampler,
        "snapshotGpu",
      );
      // Register each successful allocation immediately. A failed FBO must not
      // strand its texture outside this snapshot's rollback list.
      const resource = { texture, fb: undefined };
      this.resources.push(resource);
      this._recordOwnedBytes();
      const fb = world._framebuffer([texture]);
      resource.fb = fb;
      world._fgCopySource = source;
      if (!world._draw("fgCopy", fb, 0, 0, texture.width, texture.height))
        throw Error("Snapshot copy shader must be ready before publication");
      return texture;
    };
    try {
      if (this.round > 1) {
        const m = world._atlasMetadata[previous];
        if (
          !m.complete ||
          m.revision !== this.revision ||
          m.bounce !== this.round - 1
        ) {
          throw Error("FG requires same-revision previous complete round");
        }
      }
      this.previous = copy(world._atlases[previous].E);
      this.current = copy(world._atlases[current].E);
      this.materials = copy(world._materials);
      world._fgSnapshots.add(this);
    } catch (e) {
      this.destroy();
      throw e;
    } finally {
      world._fgCopySource = undefined;
    }
  }
  isDestroyed() {
    return this.destroyed === true;
  }
  _recordOwnedBytes() {
    const fg = this.world.scene?.lumen?.finalGather;
    if (fg?.lumen?.world !== this.world) {
      return;
    }
    const snapshotBytes = finalGatherSnapshotBytes(this.world, this),
      total =
        fg.metrics.memoryBytes +
        snapshotBytes +
        (fg.additionalOwnedBytes ?? fg.additionalSceneBytes ?? 0);
    fg.metrics.snapshotBytes = snapshotBytes;
    fg.metrics.totalAdditionalBytes = total;
    fg.metrics.peakAdditionalBytes = Math.max(
      fg.metrics.peakAdditionalBytes ?? 0,
      total,
    );
  }
  retain() {
    this.assertAlive();
    this.references++;
    return this;
  }
  assertAlive() {
    if (this.destroyed || this.world.isDestroyed()) {
      throw Error("Final Gather snapshot is no longer valid");
    }
  }
  release() {
    if (!this.destroyed && --this.references === 0) {
      this.destroy();
    }
  }
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const r of this.resources) {
      this.world._freeTexture(r.texture, r.fb);
    }
    this.resources.length = 0;
    this.world._fgSnapshots.delete(this);
    this._recordOwnedBytes();
    destroyLumenResource(this);
    // Releasing an outstanding lease after its world closes is harmless. All
    // access/query methods remain guarded by destroyObject.
    this.release = this.destroy = () => undefined;
  }
}
export default LumenFinalGatherSnapshot;
