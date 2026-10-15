/** Cesium private content access is isolated here. Tile events only enqueue
 * membership; Scene postRender applies it, never during tile traversal. */
export default class LumenTilesAdapter {
  constructor(scene, tileset, finalGather) {
    this.scene = scene;
    this.tileset = tileset;
    this.fg = finalGather;
    this.pending = new Set();
    this.loaded = new Set();
    this.unloaded = new Set();
    this.frames = 0;
    this.loads = 0;
    this.unloads = 0;
    this.membershipChanges = 0;
    this.detail = "auto";
    const models = (content) =>
      content?.innerContents
        ? content.innerContents.flatMap(models)
        : content?._model
          ? [content._model]
          : [];
    this.removeLoad = tileset.tileLoad.addEventListener((tile) => {
      this.loads++;
      models(tile.content).forEach((m) => this.loaded.add(m));
    });
    this.removeUnload = tileset.tileUnload.addEventListener((tile) => {
      this.unloads++;
      models(tile.content).forEach((m) => this.unloaded.add(m));
    });
    this.removeVisible = tileset.tileVisible.addEventListener((tile) =>
      models(tile.content).forEach((m) => this.pending.add(m)),
    );
    this.removeFrame = scene.postRender.addEventListener(() => {
      if (this.closed) return;
      this.frames++;
      this.applyDetail();
      this.unloaded.forEach((m) => this.loaded.delete(m));
      this.unloaded.clear();
      const targets = [...this.pending].filter((m) => !m.isDestroyed());
      this.pending.clear();
      if (
        targets.length !== this.fg.models.size ||
        targets.some((m) => !this.fg.models.has(m))
      )
        this.membershipChanges++;
      this.fg.setModels(targets);
      for (const m of this.loaded) if (m.isDestroyed()) this.loaded.delete(m);
    });
  }
  status() {
    return {
      detail: this.detail,
      maximumScreenSpaceError: this.tileset.maximumScreenSpaceError,
      loads: this.loads,
      unloads: this.unloads,
      frames: this.frames,
      membershipChanges: this.membershipChanges,
      activeModels: this.fg.models.size,
      loadedModels: this.loaded.size,
      geometryResidency: "manifest proxy; unchanged by tile events",
    };
  }
  setDetail(detail) {
    this.detail = detail;
    this.applyDetail();
  }
  applyDetail() {
    if (this.detail !== "parent") {
      this.tileset.maximumScreenSpaceError =
        this.detail === "children" ? 1 : 16;
      return;
    }
    // Cesium skips the entire root when SSE exceeds its *parent* error.
    // Stay between the two real errors, updating as the camera moves.
    const root = this.tileset.root,
      state = this.scene._frameState;
    const childError = root.getScreenSpaceError(state, false);
    const parentError = root.getScreenSpaceError(state, true);
    if (Number.isFinite(childError) && parentError > childError)
      this.tileset.maximumScreenSpaceError = (childError + parentError) * 0.5;
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.removeLoad();
    this.removeUnload();
    this.removeVisible();
    this.removeFrame();
    this.pending.clear();
    this.loaded.clear();
    this.unloaded.clear();
  }
}
