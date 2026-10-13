// Reading GPU_DISJOINT_EXT can clear it. Broadcast invalidation before any owner
// accepts a query, including pending queries which are not available yet.
const registries = new WeakMap();
function registry(context) {
  let r = registries.get(context);
  if (!r) {
    r = { owners: new Set(), epoch: 0 };
    registries.set(context, r);
  }
  return r;
}
const LumenGpuTimer = {
  register(context, invalidate) {
    const r = registry(context);
    r.owners.add(invalidate);
    return () => r.owners.delete(invalidate);
  },
  poll(context, extension) {
    if (extension && context._gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      const r = registry(context);
      r.epoch++;
      for (const invalidate of [...r.owners]) {invalidate(r.epoch);}
      return true;
    }
    return false;
  },
};
export default LumenGpuTimer;
