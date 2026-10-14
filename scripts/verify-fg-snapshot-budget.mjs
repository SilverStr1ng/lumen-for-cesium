import assert from "node:assert/strict";
import Cartesian3 from "../cesium-1.146/packages/core/Source/Cartesian3.js";
import LumenGpuWorld from "../cesium-1.146/packages/engine/Source/Scene/LumenGpuWorld.js";
import LumenFinalGatherSnapshot, {
  finalGatherSnapshotBytes,
} from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSnapshot.js";

function fixture(budget = 512) {
  const texture = (width, height) => ({
    width,
    height,
    sizeInBytes: width * height * 16,
    destroyed: false,
  });
  const world = {
    packet: {
      grid: { width: 2, height: 2, origin: [0, 0, 0], counts: [2, 2, 2] },
    },
    _materials: texture(1, 1),
    _atlases: [{ E: texture(2, 2) }, { E: texture(2, 2) }],
    _atlasMetadata: [
      { complete: true, revision: 1, bounce: 0 },
      { complete: true, revision: 1, bounce: 1 },
    ],
    _fgSnapshots: new Set(),
    _captureFinalGather: true,
    _previous: 0,
    _target: 1,
    _bounce: 1,
    _jobRevision: 1,
    revision: 1,
    _jobVersions: {},
    _jobOptions: { bounces: 1, publicationMode: "snapshot" },
    origin: Cartesian3.ZERO,
    counts: new Cartesian3(2, 2, 2),
    normalBias: 0,
    spacing: 2,
    memoryBytes: 0,
    maxMemoryBytes: 1048576,
    _history: [],
    _started: 0,
    allocations: 0,
    isDestroyed: () => false,
    _light: () => ({}),
    _draw() {},
    _publishRound() {},
    _finishJob() {},
    _framebuffer: () => ({}),
    _texture(width, height) {
      const result = texture(width, height);
      this.allocations++;
      this.memoryBytes += result.sizeInBytes;
      return result;
    },
    _freeTexture(resource) {
      assert(!resource.destroyed);
      resource.destroyed = true;
      this.memoryBytes -= resource.sizeInBytes;
    },
  };
  const fg = {
    mode: "fg",
    lumen: { world },
    maxMemoryBytes: budget,
    metrics: { memoryBytes: 90, peakAdditionalBytes: 0 },
    releases: 0,
    release() {
      this.releases++;
      this.metrics.memoryBytes = 0;
    },
  };
  world.scene = { lumen: { finalGather: fg } };
  world.finalGatherSnapshot = new LumenFinalGatherSnapshot(world, 0, 1);
  return { world, fg };
}

// Real snapshot implementation and round state machine: no old/new overlap.
{
  const { world, fg } = fixture(),
    previous = world.finalGatherSnapshot;
  const allocate = world._texture;
  world._texture = function (...args) {
    assert(
      previous.isDestroyed(),
      "previous world owner must be freed before replacement allocations",
    );
    return allocate.apply(this, args);
  };
  LumenGpuWorld.prototype._completeRound.call(world);
  assert(world.finalGatherSnapshot && world.finalGatherSnapshot !== previous);
  assert.equal(world._fgSnapshots.size, 1);
  assert.equal(finalGatherSnapshotBytes(world), 144);
  assert.equal(fg.metrics.peakAdditionalBytes, 234);
  world.finalGatherSnapshot.release();
  assert.equal(world.memoryBytes, 0);
}
// An explicit query lease stays alive and charged until its owner releases it.
{
  const { world, fg } = fixture(),
    leased = world.finalGatherSnapshot.retain();
  LumenGpuWorld.prototype._completeRound.call(world);
  assert(!leased.isDestroyed());
  assert.equal(finalGatherSnapshotBytes(world), 288);
  assert.equal(fg.metrics.peakAdditionalBytes, 378);
  leased.release();
  assert.equal(finalGatherSnapshotBytes(world), 144);
  assert.equal(fg.metrics.totalAdditionalBytes, 234);
  world.finalGatherSnapshot.release();
  assert.equal(world.memoryBytes, 0);
}
// A retained lease that prevents even the snapshots fitting rejects before
// any replacement texture is allocated; releasing the lease leaves no owner.
{
  const { world, fg } = fixture(256),
    leased = world.finalGatherSnapshot.retain(),
    allocations = world.allocations;
  LumenGpuWorld.prototype._completeRound.call(world);
  assert.equal(world.finalGatherSnapshot, undefined);
  assert.match(world.finalGatherStatus, /additional memory budget/);
  assert.equal(world.allocations, allocations);
  assert.equal(fg.releases, 1);
  leased.release();
  assert.equal(world._fgSnapshots.size, 0);
  assert.equal(world.memoryBytes, 0);
}
// Shrinking a user budget clears the old receiver cache before new cloning.
{
  const { world, fg } = fixture();
  fg.maxMemoryBytes = 200;
  LumenGpuWorld.prototype._completeRound.call(world);
  assert.equal(fg.releases, 1);
  assert.equal(fg.metrics.totalAdditionalBytes, 144);
  world.finalGatherSnapshot.release();
  assert.equal(world.memoryBytes, 0);
}
console.log(
  "PASS round snapshot peak, explicit leases, preallocation budget rejection and budget shrink",
);
