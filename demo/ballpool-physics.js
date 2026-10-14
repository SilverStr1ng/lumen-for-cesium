import RAPIER from "../node_modules/@dimforge/rapier3d-deterministic-compat/rapier.mjs";
let initialization;
let wasmMemory;
async function initialize() {
  // Observe this library's initialization only; restore the platform API before
  // starting the scene. The compatibility package embeds its own WASM locally.
  const native = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...args) => {
    const result = await native(...args);
    const memory = (result.instance ?? result).exports?.memory;
    if (memory instanceof WebAssembly.Memory) wasmMemory = memory;
    return result;
  };
  try {
    await RAPIER.init();
  } finally {
    WebAssembly.instantiate = native;
  }
}
export class BallPoolPhysics {
  static get memoryBytes() {
    return wasmMemory?.buffer.byteLength ?? 0;
  }
  static async create(descriptor) {
    await (initialization ??= initialize());
    return new BallPoolPhysics(descriptor);
  }
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
    this.world.timestep = 1 / 60;
    this.bodies = new Map();
    this.accumulator = 0;
    this.ticks = 0;
    this.costs = [];
    for (const c of descriptor.container) {
      const half = c.hi.map((x, i) => (x - c.lo[i]) / 2),
        center = c.hi.map((x, i) => (x + c.lo[i]) / 2);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...half)
          .setTranslation(...center)
          .setFriction(0.65),
      );
    }
    for (const b of descriptor.balls) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(...b.position)
          .setRotation({
            x: b.rotation[0],
            y: b.rotation[1],
            z: b.rotation[2],
            w: b.rotation[3],
          })
          .setLinearDamping(0.12)
          .setAngularDamping(0.15)
          .setCanSleep(true),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.ball(b.radius)
          .setDensity(1)
          .setFriction(0.55)
          .setRestitution(0.2),
        body,
      );
      this.bodies.set(b.ballId, body);
      body.sleep();
    }
  }
  wake() {
    for (const body of this.bodies.values()) body.wakeUp();
  }
  advance(seconds) {
    // 1/60 fixed step, at most 5 substeps, discard long background gaps.
    this.accumulator = Math.min(
      this.accumulator + Math.max(0, Math.min(seconds, 0.1)),
      5 / 60,
    );
    const started = performance.now();
    let steps = 0;
    while (this.accumulator >= 1 / 60 && steps < 5) {
      this.step();
      this.accumulator -= 1 / 60;
      steps++;
    }
    const ms = performance.now() - started;
    this.costs.push(ms);
    if (this.costs.length > 600) this.costs.shift();
    return steps;
  }
  step() {
    this.world.step();
    this.ticks++;
    this.capture();
  }
  capture() {
    for (const b of this.descriptor.balls) {
      const body = this.bodies.get(b.ballId),
        p = body.translation(),
        q = body.rotation();
      b.position = [p.x, p.y, p.z];
      b.rotation = [q.x, q.y, q.z, q.w];
      const v = body.linvel(),
        speed = Math.hypot(v.x, v.y, v.z);
      if (speed > 20)
        body.setLinvel(
          {
            x: (v.x * 20) / speed,
            y: (v.y * 20) / speed,
            z: (v.z * 20) / speed,
          },
          true,
        );
      // A finite observation pool can eject a ball over its low front wall.
      // Recover that ball inside the pool; do not grow the body/model count.
      if (p.z < -0.8 || Math.abs(p.x) > 6 || Math.abs(p.y) > 5) {
        body.setTranslation({ x: 0, y: 0, z: 2.6 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.position = [0, 0, 2.6];
      }
    }
    return this.descriptor;
  }
  toss(id = 1) {
    const body = this.bodies.get(id);
    if (!body) throw Error("Unknown ball");
    body.setTranslation({ x: -1.4, y: -1, z: 2.8 }, true);
    body.setLinvel({ x: 3, y: 2, z: 1.5 }, true);
    body.enableCcd(true);
    this.capture();
  }
  metrics() {
    return {
      package: "@dimforge/rapier3d-deterministic-compat",
      version: "0.18.0",
      license: "Apache-2.0",
      step: 1 / 60,
      maxSubsteps: 5,
      ticks: this.ticks,
      wasmReservedBytes: this.memoryBytes,
      sleeping: [...this.bodies.values()].filter((b) => b.isSleeping()).length,
      bodies: this.bodies.size,
      serializedBytes: this.world.takeSnapshot().byteLength,
      cpuMilliseconds: [...this.costs],
    };
  }
  destroy() {
    if (this.world) {
      this.world.free();
      this.world = undefined;
      this.bodies.clear();
    }
  }
  get memoryBytes() {
    return BallPoolPhysics.memoryBytes;
  }
}
