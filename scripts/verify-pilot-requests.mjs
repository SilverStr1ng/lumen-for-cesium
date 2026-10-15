import assert from "node:assert/strict";
import { LatestRequests, afterFrame } from "../lumen/session-requests.js";
import LumenSession from "../lumen/LumenSession.js";
const ran = [],
  releases = [];
const queue = new LatestRequests(async (value) => {
  ran.push(value);
  await new Promise((resolve) => releases.push(resolve));
  return { value };
});
const first = queue.submit(1),
  second = queue.submit(2),
  third = queue.submit(3),
  fourth = queue.submit(4);
assert.equal((await second).outcome, "superseded");
assert.equal((await third).outcome, "superseded");
releases.shift()();
assert.equal((await first).outcome, "completed");
assert.deepEqual(ran, [1, 4]);
releases.shift()();
assert.equal((await fourth).value, 4);
const active = queue.submit(5),
  pending = queue.submit(6);
queue.close();
assert.equal((await active).outcome, "cancelled");
assert.equal((await pending).outcome, "cancelled");
releases.shift()();
assert.deepEqual(ran, [1, 4, 5]);

let fail;
const failing = new LatestRequests(
  () =>
    new Promise((_, reject) => {
      fail = reject;
    }),
);
const rejected = failing.submit(1),
  notRun = failing.submit(2);
const rejection = assert.rejects(rejected, /injected solve/);
fail(Error("injected solve"));
await rejection;
assert.equal((await notRun).outcome, "cancelled");
assert.equal(failing.closed, true);
const session = Object.assign(Object.create(LumenSession.prototype), {
  world: {
    solve() {
      throw Error("injected synchronous solve");
    },
  },
  generation: 1,
  _controller: new AbortController(),
  scene: { lumen: {} },
  _lighting() {},
});
await assert.rejects(session._runLighting({}, 1), /injected synchronous solve/);
assert.equal(session.phase, "failed");
assert.equal(session.scene.lumen.coverage, 0);

const listeners = new Set(),
  scene = {
    isDestroyed: () => false,
    requestRender() {},
    postRender: {
      addEventListener(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  };
await assert.rejects(
  afterFrame(scene, () => {}, undefined, 10),
  { name: "TimeoutError" },
);
assert.equal(listeners.size, 0);
const controller = new AbortController(),
  wait = afterFrame(scene, () => {}, controller.signal);
controller.abort();
await assert.rejects(wait, { name: "AbortError" });
assert.equal(listeners.size, 0);
const rendered = afterFrame(scene, () => "committed");
[...listeners][0]();
assert.equal(await rendered, "committed");
assert.equal(listeners.size, 0);
console.log(
  "PASS latest-only bounded lighting queue and frame timeout/cancel listener ownership",
);
