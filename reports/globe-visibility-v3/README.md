# Globe / visibility v3 evidence

Source HEAD at report generation: `6d97e1d631cd7fae30a59d320e4a4e4be672f2d7`; branch `feat/globe-demo-visibility-v3`. See [summary.json](summary.json) for dirty paths, source/build hashes, exact per-check statuses and evidence hashes. This index hashes raw bytes; individual `sourceVersion` browser reports normalize CRLF to LF before hashing source/bundle text. Each raw browser report retains its own source/build version at execution; commits were staged during development, so do not infer the executed source solely from its HEAD field.

## Run

From the repository root, run `npm run setup` if dependencies are absent, `npm run build`, then `npm start`. Open [Earth GI Lab](http://localhost:8090/demo/globe.html). The original [Sponza entry](http://localhost:8090/demo/index.html) remains separate and requires its asset service (default port 8008).

Earth GI Lab uses the repository Cesium build, NaturalEarthII and ellipsoid terrain with no token or external requests. Its original 24×18 m pavilion uses one glTF, Z-up metre coordinates, one ENU/heading frame and the actual model axis correction for display and GI. Foundation, walls, floor, roof and skylight are triangles in that asset. Default quality: 924 probes, 2 m spacing, 128 rays, 3 bounces, 3 ms GPU update budget, gain 1. Camera, exposure and product A/B preserve the lighting revision. GBuffer and preserveDrawingBuffer are disabled outside the diagnostic URL.

Optional ion configuration is in the page's settings, held only in memory. Supply a dedicated public-client token with assets:read, asset restrictions and Allowed URLs, and an authorized imagery asset ID. World Terrain is optional. No token is committed or included in evidence. Real token/terrain operation is **not-run**; HTTP 401/403 and offline fallback are simulated tests, not successful authenticated access. Terrain activation samples the center and corners once; the common display/GI anchor is rebuilt, while failed or unsupported placement falls back locally. See [page instructions](../../demo/globe-README.md).

## Lifecycle and transport

Publication notification is queued after the Scene render and round transaction. World/Scene destruction, replacement, new solve and throwing listeners are tested at first and final rounds. A firstPublished handler may destroy the world before the queued notification; that stale notification is canceled. A late Worker error cannot change a destroyed world. See [contract](../../docs/publication-lifecycle.md) and timestamped lifecycle JSON, including the first failed startup and successful reruns.

The opt-in upper-hemisphere environment returns black below the horizon and retains Unknown as invalid. CPU and GPU transport derive a complete local root-bounds distance with the historical 100 m minimum retained. The 150 m blocker fixture verifies real production sunlight visibility beyond 100 m; explicit finite diagnostic rays still describe finite segments. No full-Earth BVH or terrain GI is claimed.

## Same-quality visibility comparison

A: original reviewed visibility GLSL + original stable median BVH. B: 12-bin SAH + optimized exact any-hit. Warm trial order A/B/B/A/A/B; three fixed solar directions per trial. All camera, model, resolution, shadows, probes, rays, bounces and update budget remain the same. See [raw measurements](visibility-performance.json), [query correctness](visibility-gpu.json), [CPU corpus](visibility-cpu.json) and [long-domain fixture](visibility-far-blocker.json). The A shader's revision and SHA256 are recorded. A uses original revision visibility GLSL and median BVH within the new lifecycle/runtime. Initialization retains full-domain probe tracing; not a byte-identical full baseline build.

Values below are median [minimum, maximum]. Per-direction tables, stage counters, query queues, initialization stages, full-frame disabled/static/updating costs and exact configuration remain in the raw report. The target uses the median of the three per-run visibility medians.

| Quantity | A | B |
| --- | ---: | ---: |
| visibility target: median of run medians / ms | 257.40 [248.12, 260.72] | 14.66 [14.44, 18.73] |
| visibility GPU / ms | 257.40 [166.90, 336.81] | 15.09 [14.29, 21.68] |
| all direction stages GPU / ms | 295.06 [203.76, 376.00] | 54.86 [51.32, 61.74] |
| first publication CPU / ms | 9928.40 [5929.00, 18194.00] | 2131.60 [1589.30, 4418.70] |
| final completion CPU / ms | 13124.70 [7728.30, 22842.60] | 5766.30 [3808.70, 7025.30] |
| submitted frames | 111.00 [92.00, 159.00] | 50.00 [38.00, 79.00] |
| GPU ms per submitted frame (target 3 ms) | 2.66 [1.81, 3.05] | 1.03 [0.75, 1.44] |
| initialization wall / ms | 28078.00 [26449.40, 57372.00] | 13498.70 [11299.00, 17529.00] |
| Worker prepare / ms | 2420.40 [1600.80, 2488.90] | 4680.50 [3193.90, 4892.20] |
| BVH build / ms | 785.30 [492.80, 941.50] | 2274.30 [1520.60, 2833.90] |
| median tie rank + vertex packing / ms | 87.00 [46.20, 140.40] | 803.90 [590.60, 1068.00] |
| BVH CPU persistent bytes | 3680736.00 [3680736.00, 3680736.00] | 4647456.00 [4647456.00, 4647456.00] |
| raw tie rank bytes | 0.00 [0.00, 0.00] | 1049072.00 [1049072.00, 1049072.00] |
| owned GPU bytes | 93338688.00 [93338688.00, 93338688.00] | 95140928.00 [95140928.00, 95140928.00] |
| initial relocate GPU / ms | 623.60 [590.86, 792.44] | 30.49 [29.60, 31.56] |
| initial intersect GPU / ms | 1919.76 [1836.50, 2030.55] | 78.59 [75.63, 80.80] |
| GI disabled FPS | 13.50 [6.16, 13.55] | 13.55 [7.01, 13.68] |
| GI static FPS | 13.61 [7.14, 13.88] | 13.55 [7.50, 13.68] |
| GI updating FPS | 9.16 [6.55, 13.52] | 12.05 [6.53, 12.77] |
| GI disabled whole-frame GPU / ms | 73.13 [72.78, 142.97] | 73.56 [73.25, 140.19] |
| GI static whole-frame GPU / ms | 72.00 [71.83, 135.87] | 72.20 [72.19, 132.86] |

Visibility improvement: **94.3%**, 30% target **met**. Do not read CPU promise times as GPU completion or physical presentation. Performance phases prohibit readPixels/finish/blocking waits; HDR, E and visibility comparisons run separately. Snapshot N-bounce equality is an algorithmic reference, not an absolute physical truth. The independently rebuilt original baseline is [baseline-clean-visibility.json](baseline-clean-visibility.json), status **passed**. It uses the same three solar directions and harness; it remains a separate experiment, not pooled into the interleaved trials. Original benchmark:relighting evidence, if available, is listed separately below.

The earlier SAH candidate has a retained [failed numerical comparison](visibility-performance-failed-sah.json). Its speed alone does not establish same-quality acceptance. [CPU asset memory](asset-memory.json) reports decoded textures, geometry and BVH typed arrays separately; these exclude JavaScript overhead and browser/driver caches. [Sponza hashes](sponza-asset-chain.json) cover the root glTF and its referenced buffers and textures.

The discrepancy was traced to 170 exactly equidistant coincident hits, including opposite winding. SAH now uses original median rank for exact-distance ties, adding no tolerance. [Single-direction diagnosis](visibility-sponza-diagnosis-ranked.json) and [three-direction Sponza verification](visibility-sponza-three-directions-ranked.json) record the corrected identities, distances, E and visibility. Traversal statistics are compiled only into the diagnostic query shader.

[Actual forward HDR comparison](visibility-sponza-hdr-2026-10-12T03-23-08-505Z.json) status **passed** separately reads the Scene color framebuffer before postprocessing after all three bounces for each of the three solar directions. Camera, model transform, exposure, gain, resolution, shadows, time and display light are checked equal. Its predeclared RGB tolerance is 2e-4 absolute + 1e-3 relative, with separate non-finite/empty-frame checks. These diagnostic readbacks are excluded from performance trials; this is browser HDR evidence, not physical-display latency.

The measured production defaults are now `bvhStrategy: "sah"`, `bvhBins: 12`, `visibilityMode: "optimized"`; the median/reference options remain available. SAH increases retained CPU BVH and GPU memory, and building the original median tie order adds Worker cost. These costs are included in the table, even though GPU initialization and direction updates improve. The 3 ms setting is a scheduling target, not a whole-frame limit; low display FPS and asynchronous timer estimates still constrain wall-clock response.

[Separate scheduler diagnosis](scheduler.json) observes the unchanged production loop with a Proxy around its cost estimates. It records each submitted frame, queue depth, queue peak and the exact branch that ends a frame after a batch when the next estimate is unavailable. It introduces diagnostic CPU overhead and is excluded from all speed claims. Reproduce with `node scripts/diagnose-scheduler.mjs`. Initial-estimate deferrals are {"initialization":{"frames":40,"byStage":{"relocate":3,"intersect":3,"classify":5,"moments":5,"momentsBorder":5,"visibility":2,"direct":3,"bounce":3,"integrate_arithmetic":6,"border":5}},"direction-update":{"frames":0,"byStage":{}}}; query queue peak/final are 27/0. These are asynchronous submission deferrals, not blocking waits.

The independent original build's median of run medians is **270.54 ms**, giving **94.6%** candidate reduction in that separate-session comparison. Raw dates, ranges and configurations remain available. This does not replace the interleaved A/B experiment.

## Screenshots and numeric evidence

Earth performance is a separate small-scene workload at 1280×800, not evidence that Sponza is real-time. [Raw Earth measurement](globe-performance-2026-10-12T03-05-12-718Z.json) status **passed**: GI off/static/updating **20.12 / 21.86 / 18.61 FPS**; first/final CPU submission **1209.20 / 3154.80 ms**. The updating rAF window can include settled frames. GBuffer and preserveDrawingBuffer are off. Three Earth/building navigation cycles record whole-context resources [[{"textures":45,"framebuffers":21,"queries":0,"programs":26,"syncs":0}],[{"textures":45,"framebuffers":21,"queries":0,"programs":26,"syncs":0}],[{"textures":45,"framebuffers":21,"queries":0,"programs":26,"syncs":0}]]; GI memory stays 12192580 → 12192580 bytes, world/Worker identity and revision are preserved, and pending Worker/GPU queries are 0/0. Initialization stages and every direction-update GPU stage remain in that raw report.

All PNGs are actual browser renders: [Earth](globe-earth.png), [pavilion on Globe](globe-context.png), [overhead](globe-top.png), [corridor](globe-corridor.png), [indoor transition](globe-inside.png), same-camera [GI on](globe-ab-on.png) / [off with IBL fallback](globe-ab-off.png), and [pure indirect](globe-indirect.png). No generated or retouched images are used. Asset SHA256, GBuffer/BVH alignment, fixed-receiver HDR with colored/neutral transfer, solar sign and equivalent GI at another longitude/latitude are in [globe-results.json](globe-results.json).

Product A/B includes the original IBL fallback when Lumen is off. The colored/neutral transfer comparison holds the visible receiver, exposure, camera and gain fixed and changes backend colored reflectance; it is a separate causal diagnostic. No display amplification is used. Globe imagery and surrounding terrain remain background and do not participate in complete indirect transport. Interpolation dark blotches around small objects/corners remain visible in the screenshots.

The final bookmark captures wait for ten consecutive tiles-loaded frames. The placement diagnostic samples `Globe.getHeight` at the center and four corners, measuring the actual rendered triangle surface rather than only the analytical ellipsoid. Stable measured foundation gaps were 0.145–0.309 mm (checked against a 1 cm limit). Some ground-shadow separation remains visually noticeable; an isolated normal-offset toggle did not establish a safe clear improvement, so the default shadow configuration and original geometry are retained. This distinguishes verified geometric contact from unresolved shadow appearance.

## Verification inventory

Run `npm run test:publication-lifecycle`, `npm run test:globe`, `npm run test:visibility`; original fixture/relighting/integration/progressive suites remain available. Run benchmarks serially with no other GPU test: `npm run benchmark:visibility`, `npm run benchmark:globe`, `npm run benchmark:relighting`. Regenerate this inventory with `npm run report:globe-visibility`.

| Evidence/check | Status |
| --- | --- |
| [node-checks.json](node-checks.json) | passed |
| [environment.json](environment.json) | passed |
| [asset-memory.json](asset-memory.json) | passed |
| [baseline-build.json](baseline-build.json) | passed |
| [gbuffer-verification.json](gbuffer-verification.json) | passed |
| [fixture-verification.json](fixture-verification.json) | passed |
| [relighting-verification.json](relighting-verification.json) | passed |
| [integration-verification.json](integration-verification.json) | passed |
| [progressive-verification.json](progressive-verification.json) | passed |
| [globe-results.json](globe-results.json) | passed |
| [visibility-cpu.json](visibility-cpu.json) | passed |
| [visibility-gpu.json](visibility-gpu.json) | passed |
| [visibility-far-blocker.json](visibility-far-blocker.json) | passed |
| [visibility-edges.json](visibility-edges.json) | passed |
| [visibility-sponza-diagnosis-ranked.json](visibility-sponza-diagnosis-ranked.json) | passed |
| [visibility-sponza-three-directions-ranked.json](visibility-sponza-three-directions-ranked.json) | passed |
| [visibility-performance.json](visibility-performance.json) | passed |
| [baseline-clean-visibility.json](baseline-clean-visibility.json) | passed |
| [baseline-relighting.json](baseline-relighting.json) | passed |
| [lifecycle](lifecycle-2026-10-12T03-14-00-976Z.json) | passed |
| [globe-performance](globe-performance-2026-10-12T03-05-12-718Z.json) | passed |
| [visibility-sponza-hdr](visibility-sponza-hdr-2026-10-12T03-23-08-505Z.json) | passed |
| realIonImageryAndTerrain | not-run |
| physicalDisplayPresentationLatency | not-run |
| [firstNewHdrReadback](progressive-verification.json) | passed |
| fullCesiumKarma | not-run |
| [scheduler](scheduler.json) | passed |

Failed/interrupted JSON records are retained; current scripts also write timestamped raw copies. One earlier successful GPU-fixture plain JSON was overwritten before timestamping was added. Four initial failed antipode PNGs were overwritten during the successful rerun; [the actual offscreen-camera diagnostic reproduction](globe-antipode-failed-offscreen-reproduction.png) is retained as a reproduction, not an original failed capture. Current Globe screenshot sets and JSON are archived under `runs/<timestamp>`. The final narrow-FOV check projects the real model at the image center: Globe-on show/hide HDR is unchanged, while Globe-off is a visible positive control. This avoids accepting an offscreen model as proof of occlusion. Full upstream Karma and physical-display latency are not claimed. No Cesium upgrade, GBuffer rewrite, dynamic geometry, Tiles GI, SDF, Cards, SSGI, reflections or WebGPU is included. The branch is not merged into main.
