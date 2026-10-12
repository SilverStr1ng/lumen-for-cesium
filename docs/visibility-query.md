# Visibility query choices

`Scene.lumen.loadWorld` accepts `bvhStrategy: "median" | "sah"`, `bvhBins` (integer 4–64, default 12), and `visibilityMode: "reference" | "optimized"`. Geometry strategy and bin count are immutable for a loaded world; reload to change them. The measured production default is documented in the [v3 evidence](../reports/globe-visibility-v3/README.md).

For a reference world, retain the scene's existing asset, transforms and quality options and add:

```js
const world = scene.lumen.loadWorld({
  ...sceneOptions,
  bvhStrategy: "median",
  bvhBins: 12,
  visibilityMode: "reference",
});
await world.completed;
```

Median preserves the original stable centroid ordering. Binned SAH retains leaves of at most eight triangles, falls back for degenerate/empty splits, and bounds SAH recursion before median splitting. Both use the same stackless GPU escape-pointer layout and original triangle/material mapping.

SAH changes traversal order. This matters for coincident triangles: Sponza contains exactly equidistant, oppositely wound surfaces. Choosing another valid nearest triangle can change the surface normal and whether a solar ray is issued. For SAH only, the Worker constructs the original median order and appends its rank to the existing UV texture, four ranks per texel. Nearest-hit selection uses that rank only when distances are exactly equal; it does not introduce a distance tolerance. A hit exactly at the finite query maximum remains excluded, as in the original implementation. Median does not allocate the rank payload. Raw rank bytes, actual padded GPU memory and rank/vertex packing time are reported separately.

Optimized solar any-hit precomputes inverse direction, reads UV/alpha only after a geometric hit requires an alpha test, and exits on the first confirmed occluder. It retains double-sided blocking, alpha cutoff, origin offsets and Unknown. Budget exhaustion remains Unknown. Production probe and solar traces cover the resident root bounds; finite `world.trace` calls still describe finite diagnostic segments.

`world.trace(rays, { anyHit: true, statistics: true })` is diagnostic and reads back node, triangle and alpha counts plus status. Statistics are compiled into the query shader only; the production shaders preprocess all count operations away. Any-hit may legally return a different opaque triangle than nearest-hit, so count/alpha tests must not assume it visits every preceding transparent layer.

Run browser benchmarks serially, with the built server on port 8090 and the same Sponza service on port 8008:

```powershell
npm run build
npm start
# In another terminal:
npm run test:visibility
npm run benchmark:visibility
npm run report:globe-visibility
```

The benchmark's A variant injects the reviewed original visibility GLSL into a median world; B uses SAH plus optimized any-hit; C isolates optimized any-hit with median. The formal order is A/B, B/A, A/B. A separate complete build of reviewed HEAD `39529256309070aae6e67518b3f17fed4855a9fb` is required for a clean-runtime baseline; `LUMEN_CLEAN_BASELINE=1`, `LUMEN_BASE_URL`, `LUMEN_VARIANTS=A,A,A` and `LUMEN_REPORT` support that run and enforce the original clean source. Do not point that mode at the new server.

Performance phases never read back textures or block on GPU completion. CPU first/final Promise times are submission times; stage timer queries measure accumulated GPU work. Numerical E/visibility checks run after timing. The progressive fixture separately checks actual forward HDR and diagnostic fences; none of these headless measurements claims physical-display presentation latency.
