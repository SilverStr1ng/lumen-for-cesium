import assert from "node:assert/strict";
import LumenReceiverPass from "../cesium-1.146/packages/engine/Source/Scene/LumenReceiverPass.js";
import LumenFinalGather from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGather.js";
import destroyLumenResource from "../cesium-1.146/packages/engine/Source/Scene/destroyLumenResource.js";
const receiver = new LumenReceiverPass();
receiver.destroy();
assert(receiver.isDestroyed());
assert.throws(
  () => receiver.command(undefined, {}),
  (e) => e.name === "DeveloperError",
);
const fg = new LumenFinalGather({
  _scene: { context: { _gl: { getExtension: () => null } } },
});
fg.destroy();
assert(fg.isDestroyed());
assert.throws(
  () => fg.configure(),
  (e) => e.name === "DeveloperError",
);
class Lease {
  retain() {
    return this;
  }
  release() {}
  destroy() {
    destroyLumenResource(this);
    this.release = this.destroy = () => undefined;
  }
  isDestroyed() {
    return false;
  }
}
const lease = new Lease();
lease.destroy();
assert(lease.isDestroyed());
assert.throws(
  () => lease.retain(),
  (e) => e.name === "DeveloperError",
);
assert.doesNotThrow(() => {
  lease.release();
  lease.destroy();
});
console.log("passed class resource guards and late lease cleanup");
