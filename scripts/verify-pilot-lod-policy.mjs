import assert from "node:assert/strict";
import Adapter from "../lumen/LumenTilesAdapter.js";
const adapter = Object.assign(Object.create(Adapter.prototype), {
  scene: { _frameState: {} },
  tileset: {
    root: { getScreenSpaceError: (_, parent) => (parent ? 4250 : 1275) },
  },
});
adapter.setDetail("parent");
assert(
  adapter.tileset.maximumScreenSpaceError > 1275 &&
    adapter.tileset.maximumScreenSpaceError < 4250,
);
adapter.setDetail("children");
assert.equal(adapter.tileset.maximumScreenSpaceError, 1);
adapter.setDetail("auto");
assert.equal(adapter.tileset.maximumScreenSpaceError, 16);
console.log(
  "PASS parent SSE stays between actual root/tileset errors, rather than skipping the whole tileset",
);
