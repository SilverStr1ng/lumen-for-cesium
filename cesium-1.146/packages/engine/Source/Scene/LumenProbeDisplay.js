/** Finite probe-space display transition. Owns copies, never feeds the solver.
 * Resources are allocated/accounted/released by LumenGpuWorld.
 * @private
 */
class LumenProbeDisplay {
  constructor(world, resources) {
    this.world = world;
    this.resources = resources;
    [this.history, this.goal, this.shown] = resources;
    this.active = false;
    this.ready = false;
    this.draws = 0;
  }
  draw(output, history, target, alpha) {
    this.inputHistory = history;
    this.inputTarget = target;
    this.alpha = alpha;
    const g = this.world.packet.grid;
    this.world._draw("displayBlend", output.fb, 0, 0, g.width, g.height);
    this.draws++;
  }
  copy(source, output) {
    if (source !== output.E) this.draw(output, source, source, 1);
  }
  publish(raw, versions, lighting, revision, milliseconds) {
    const signature = [
      versions.geometry,
      versions.rayLayout,
      versions.material,
    ].join(":");
    const compatible = this.ready && signature === this.signature;
    if (revision !== this.revision) {
      const old = this.lighting,
        sun = lighting.sunDirection ?? [1, 1, 1],
        energy = [
          ...(lighting.sunRadiance ?? [2, 2, 2]),
          ...(lighting.skyRadiance ?? [0.15, 0.18, 0.25]),
        ];
      const large =
        old &&
        (sun.reduce((s, v, i) => s + v * old.sunDirection[i], 0) /
          Math.hypot(...sun) /
          Math.hypot(...old.sunDirection) <
          0.5 ||
          energy.some(
            (v, i) =>
              Math.abs(v - old.energy[i]) >
              0.5 * Math.max(v, old.energy[i], 0.01),
          ));
      this.largeChange = !!large;
      this.lighting = { sunDirection: [...sun], energy };
      this.revision = revision;
    }
    // Controls may change between progressive rounds of the same revision.
    this.duration = this.largeChange
      ? Math.min(50, milliseconds)
      : milliseconds;
    if (compatible) this.copy(this.shown.E, this.history);
    this.copy(raw, this.goal);
    this.started = performance.now();
    this.signature = signature;
    this.ready = true;
    this.active = compatible && this.duration > 0;
    if (this.active) this.draw(this.shown, this.history.E, this.goal.E, 0);
    else this.copy(this.goal.E, this.shown);
  }
  update() {
    if (!this.active) return;
    const alpha = Math.min(
      1,
      (performance.now() - this.started) / this.duration,
    );
    this.draw(this.shown, this.history.E, this.goal.E, alpha);
    this.active = alpha < 1;
    if (this.active) this.world.scene.requestRender();
  }
}
export default LumenProbeDisplay;
