import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

const directory = "reports/globe-visibility-v3";
const read = name => existsSync(`${directory}/${name}`) ? JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) : undefined;
const latest = prefix => readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith(".json")).sort().at(-1);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const evidenceFiles = () => readdirSync(directory, { recursive: true }).filter(name => statSync(`${directory}/${name}`).isFile()).map(name => name.replaceAll("\\", "/"));
const status = report => {
  if (!report) return "not-run";
  if (report.status) return report.status;
  const checks = report.checks ?? report.tests;
  if (report.errors?.length || report.error) return "failed";
  return checks?.length ? checks.every(check => check.passed) ? "passed" : "failed" : "not-run";
};
const tests = {};
for (const file of ["node-checks.json", "environment.json", "asset-memory.json", "baseline-build.json", "gbuffer-verification.json", "fixture-verification.json", "relighting-verification.json", "integration-verification.json", "progressive-verification.json", "globe-results.json", "visibility-cpu.json", "visibility-gpu.json", "visibility-far-blocker.json", "visibility-edges.json", "visibility-sponza-diagnosis-ranked.json", "visibility-sponza-three-directions-ranked.json", "visibility-performance.json", "baseline-clean-visibility.json", "baseline-relighting.json"]) {
  tests[file] = { status: status(read(file)), evidence: existsSync(`${directory}/${file}`) ? file : null };
}
for (const prefix of ["lifecycle-", "globe-performance-", "visibility-sponza-hdr-"]) {
  const file = latest(prefix);
  tests[prefix.slice(0,-1)] = { status: status(file && read(file)), evidence: file ?? null };
}
tests.realIonImageryAndTerrain = { status: "not-run", reason: "No real token supplied. Simulated HTTP 401/403/offline paths tested separately." };
tests.physicalDisplayPresentationLatency = { status: "not-run", reason: "Headless browser captures HDR and screenshots; CPU Promise times do not establish presentation on a physical display." };
tests.firstNewHdrReadback = { status: status(read("progressive-verification.json")), evidence: "progressive-verification.json", scope: "Progressive fixture rounds.atFirst: actual forward HDR readback and separate post-readback diagnostic fence; includes readback overhead, not a performance-phase or physical-display latency measurement." };
tests.fullCesiumKarma = { status: "not-run", reason: "Targeted pipeline, transport, WebGL and integration suites used; full upstream suite not run." };
tests.scheduler = { status: status(read("scheduler.json")), evidence: "scheduler.json" };

const summarize = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length ? { median: sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2, minimum: sorted[0], maximum: sorted.at(-1), samples: sorted.length } : null;
};
const performance = read("visibility-performance.json");
const globePerformanceFile = latest("globe-performance-");
const globePerformance = read(globePerformanceFile);
const globe = globePerformance?.result;
const hdrFile = latest("visibility-sponza-hdr-");
const hdrReport = read(hdrFile);
const cleanBaseline = read("baseline-clean-visibility.json");
const candidate = performance?.candidateVariant ?? (performance?.order?.includes("C") ? "C" : "B");
const variants = {};
for (const variant of ["A", candidate]) {
  const runs = performance?.runs.filter(run => run.variant === variant) ?? [];
  const updates = runs.flatMap(run => run.updates);
  const stages = ["visibility", "direct", "bounce", "integrate", "border"];
  variants[variant] = {
    runs: runs.length,
    stageGpuMilliseconds: Object.fromEntries(stages.map(stage => [stage, summarize(updates.map(update => update.metrics.stages[stage]?.gpuMilliseconds))])),
    totalGpuMilliseconds: summarize(updates.map(update => stages.reduce((sum,stage) => sum+(update.metrics.stages[stage]?.gpuMilliseconds??0),0))),
    gpuMillisecondsPerSubmittedFrame: summarize(updates.map(update => stages.reduce((sum,stage) => sum+(update.metrics.stages[stage]?.gpuMilliseconds??0),0) / update.metrics.submittedFrames)),
    firstPublishSubmissionMilliseconds: summarize(updates.map(update => update.firstPublishedPromiseMilliseconds)),
    finalSubmissionMilliseconds: summarize(updates.map(update => update.completedPromiseMilliseconds)),
    submittedFrames: summarize(updates.map(update => update.metrics.submittedFrames)),
    initializationMilliseconds: summarize(runs.map(run => run.initializationMilliseconds)),
    workerPrepareMilliseconds: summarize(runs.map(run => run.bvh.prepareMilliseconds)),
    rankAndVertexPackMilliseconds: summarize(runs.map(run => run.bvh.rankAndVertexPackMilliseconds)),
    bvhBuildMilliseconds: summarize(runs.map(run => run.bvh.buildMilliseconds)),
    bvhCpuPersistentBytes: summarize(runs.map(run => run.bvh.persistentBytes)),
    tieRankBytes: summarize(runs.map(run => run.bvh.tieRankBytes)),
    ownedGpuBytes: summarize(runs.map(run => run.memory.currentBytes)),
    initialStageGpuMilliseconds: Object.fromEntries(["relocate", "intersect"].map(stage => [stage, summarize(runs.map(run => run.initialStages[stage]?.gpuMilliseconds))])),
    display: {
      disabledFps: summarize(runs.map(run => run.display.disabled.fps)),
      staticFps: summarize(runs.map(run => run.display.idle.fps)),
      updatingFps: summarize(updates.map(update => update.changing.fps)),
      disabledGpuMilliseconds: summarize(runs.map(run => run.display.disabled.gpuMilliseconds.mean)),
      staticGpuMilliseconds: summarize(runs.map(run => run.display.idle.gpuMilliseconds.mean)),
    },
    drainedQueryQueue: summarize(updates.map(update => update.queryQueue)),
    runMedianVisibilityMilliseconds: summarize(runs.map(run => summarize(run.updates.map(update => update.metrics.stages.visibility.gpuMilliseconds)).median)),
  };
}
const a = variants.A.runMedianVisibilityMilliseconds?.median, b = variants[candidate].runMedianVisibilityMilliseconds?.median;
const improvement = a && b ? 1-b/a : null;
const cleanRunMedians = summarize((cleanBaseline?.runs ?? []).map(run => summarize(run.updates.map(update => update.metrics.stages.visibility.gpuMilliseconds)).median));
const cleanImprovement = cleanRunMedians?.median && b ? 1-b/cleanRunMedians.median : null;
const sourceFiles = execFileSync("git", ["ls-files", "lumen", "demo", "scripts", "package.json", "cesium-1.146/packages/engine/Source/Scene/LumenGpuWorld.js", "cesium-1.146/packages/engine/Source/Scene/LumenGpuShaders.js", "cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.glsl"], { encoding: "utf8" }).trim().split("\n")
  .filter(file => /\.(m?js|json|html|css|glsl)$/.test(file) && !file.includes("config.local"));
const performanceSummary = { variants, candidateVariant: candidate, visibilityImprovementFraction: improvement, numericalStatus: performance?.numericalStatus ?? "not-run", target: 0.30, targetStatus: improvement === null ? "not-run" : performance?.numericalStatus !== "passed" ? "not-met-correctness" : !performance?.timingComplete || variants.A.runs !== 3 || variants[candidate].runs !== 3 ? "not-met-timing" : improvement >= 0.30 ? "met" : "not-met", basis: "median of three warm run medians; each run uses the same three sun directions", baselineLimitation: performance?.baselineLimitation, timingScope: "GPU accumulated work vs CPU first/final submission reported independently. Neither is physical presentation latency." };
const summary = {
  generatedAt: new Date().toISOString(),
  reviewedBaseline: "39529256309070aae6e67518b3f17fed4855a9fb",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
  dirtyPaths: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
  sourceHashScope: "SHA256 of raw bytes; allowlisted tracked sources only, no local configuration or token inputs",
  sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, hash(file)])),
  buildSha256: hash("cesium-1.146/Build/CesiumUnminified/Cesium.js"),
  environment: performance?.environment ?? read(latest("lifecycle-"))?.environment,
  host: { platform: os.platform(), release: os.release(), architecture: os.arch(), node: process.version },
  tests,
  historicalFailures: readdirSync(directory).filter(name => name.endsWith(".json") && name !== "summary.json").flatMap(file => { const result = read(file); return result?.status === "failed" || result?.errors?.length || file.includes("interrupted") ? [{ file, status: result.status ?? "incomplete", errors: result.errors ?? [] }] : []; }),
  evidenceRetention: "Failed/interrupted JSON records are retained, and current verification scripts write timestamped copies. One earlier successful GPU-fixture plain JSON was overwritten before timestamping was added. Four initial failed antipode PNGs were overwritten by the successful run; an actual offscreen-camera reproduction image is retained and explicitly labeled. Current Globe screenshots and JSON are also archived under runs/<timestamp>. Missing earlier originals are not reconstructed.",
  performance: performanceSummary,
  cleanBaseline: cleanBaseline ? { status: cleanBaseline.status, version: cleanBaseline.version, environment: cleanBaseline.environment, configuration: cleanBaseline.runs?.[0]?.options, visibilityGpuMilliseconds: summarize(cleanBaseline.runs.flatMap(run => run.updates.map(update => update.metrics.stages.visibility.gpuMilliseconds))), runMedianVisibilityMilliseconds: cleanRunMedians, candidateImprovementFraction: cleanImprovement, comparisonScope: "Same quality and harness, separate original-build session; not interleaved with the candidate and not pooled into A/B trials", firstPublicationCpuMilliseconds: summarize(cleanBaseline.runs.flatMap(run => run.updates.map(update => update.firstPublishedPromiseMilliseconds))), finalSubmissionCpuMilliseconds: summarize(cleanBaseline.runs.flatMap(run => run.updates.map(update => update.completedPromiseMilliseconds))), evidence: "baseline-clean-visibility.json" } : { status: "not-run" },
  assetMemory: read("asset-memory.json"),
  globePerformance,
  scheduler: read("scheduler.json"),
  forwardHdr: { evidence: hdrFile, status: status(hdrReport), directions: hdrReport?.result?.directionalComparisons },
  globeAssetSha256: read("globe-results.json")?.assetSha256,
  sponzaAsset: read("sponza-asset.json"),
  coverage: "GI covers resident local building/foundation/proxy triangles. Globe imagery and surrounding terrain do not participate in complete indirect transport.",
  limitations: ["Real ion imagery/terrain activation remains unverified without a token.", "Probe interpolation can leave dark blotches near corners and small objects; screenshots are evidence, not a claim of visual parity with another renderer.", "Ground shadows can visually separate from the foundation. Stable Globe triangle-mesh contact is checked separately; a normal-offset diagnostic did not establish a safe visible improvement, so shadow defaults are retained.", "Isolated A/B and independently rebuilt original baseline are distinct experiments; see cleanBaseline status and raw results.", "No dynamic geometry, Tiles GI, SDF, Cards, SSGI, reflections or WebGPU."],
  evidence: evidenceFiles().filter(name => name !== "summary.json" && name !== "README.md").map(name => ({ file: name, sha256: hash(`${directory}/${name}`) })),
};
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary,null,2));
const format = value => value ? `${value.median.toFixed(2)} [${value.minimum.toFixed(2)}, ${value.maximum.toFixed(2)}]` : "not-run";
const rows = [
  ["visibility target: median of run medians / ms", variants.A.runMedianVisibilityMilliseconds, variants[candidate].runMedianVisibilityMilliseconds],
  ["visibility GPU / ms", variants.A.stageGpuMilliseconds.visibility, variants[candidate].stageGpuMilliseconds.visibility],
  ["all direction stages GPU / ms", variants.A.totalGpuMilliseconds, variants[candidate].totalGpuMilliseconds],
  ["first publication CPU / ms", variants.A.firstPublishSubmissionMilliseconds, variants[candidate].firstPublishSubmissionMilliseconds],
  ["final completion CPU / ms", variants.A.finalSubmissionMilliseconds, variants[candidate].finalSubmissionMilliseconds],
  ["submitted frames", variants.A.submittedFrames, variants[candidate].submittedFrames],
  ["GPU ms per submitted frame (target 3 ms)", variants.A.gpuMillisecondsPerSubmittedFrame, variants[candidate].gpuMillisecondsPerSubmittedFrame],
  ["initialization wall / ms", variants.A.initializationMilliseconds, variants[candidate].initializationMilliseconds],
  ["Worker prepare / ms", variants.A.workerPrepareMilliseconds, variants[candidate].workerPrepareMilliseconds],
  ["BVH build / ms", variants.A.bvhBuildMilliseconds, variants[candidate].bvhBuildMilliseconds],
  ["median tie rank + vertex packing / ms", variants.A.rankAndVertexPackMilliseconds, variants[candidate].rankAndVertexPackMilliseconds],
  ["BVH CPU persistent bytes", variants.A.bvhCpuPersistentBytes, variants[candidate].bvhCpuPersistentBytes],
  ["raw tie rank bytes", variants.A.tieRankBytes, variants[candidate].tieRankBytes],
  ["owned GPU bytes", variants.A.ownedGpuBytes, variants[candidate].ownedGpuBytes],
  ["initial relocate GPU / ms", variants.A.initialStageGpuMilliseconds.relocate, variants[candidate].initialStageGpuMilliseconds.relocate],
  ["initial intersect GPU / ms", variants.A.initialStageGpuMilliseconds.intersect, variants[candidate].initialStageGpuMilliseconds.intersect],
  ["GI disabled FPS", variants.A.display.disabledFps, variants[candidate].display.disabledFps],
  ["GI static FPS", variants.A.display.staticFps, variants[candidate].display.staticFps],
  ["GI updating FPS", variants.A.display.updatingFps, variants[candidate].display.updatingFps],
  ["GI disabled whole-frame GPU / ms", variants.A.display.disabledGpuMilliseconds, variants[candidate].display.disabledGpuMilliseconds],
  ["GI static whole-frame GPU / ms", variants.A.display.staticGpuMilliseconds, variants[candidate].display.staticGpuMilliseconds],
];
writeFileSync(`${directory}/README.md`, `# Globe / visibility v3 evidence

Source HEAD at report generation: \`${summary.head}\`; branch \`${summary.branch}\`. See [summary.json](summary.json) for dirty paths, source/build hashes, exact per-check statuses and evidence hashes. This index hashes raw bytes; individual \`sourceVersion\` browser reports normalize CRLF to LF before hashing source/bundle text. Each raw browser report retains its own source/build version at execution; commits were staged during development, so do not infer the executed source solely from its HEAD field.

## Run

From the repository root, run \`npm run setup\` if dependencies are absent, \`npm run build\`, then \`npm start\`. Open [Earth GI Lab](http://localhost:8090/demo/globe.html). The original [Sponza entry](http://localhost:8090/demo/index.html) remains separate and requires its asset service (default port 8008).

Earth GI Lab uses the repository Cesium build, NaturalEarthII and ellipsoid terrain with no token or external requests. Its original 24×18 m pavilion uses one glTF, Z-up metre coordinates, one ENU/heading frame and the actual model axis correction for display and GI. Foundation, walls, floor, roof and skylight are triangles in that asset. Default quality: 924 probes, 2 m spacing, 128 rays, 3 bounces, 3 ms GPU update budget, gain 1. Camera, exposure and product A/B preserve the lighting revision. GBuffer and preserveDrawingBuffer are disabled outside the diagnostic URL.

Optional ion configuration is in the page's settings, held only in memory. Supply a dedicated public-client token with assets:read, asset restrictions and Allowed URLs, and an authorized imagery asset ID. World Terrain is optional. No token is committed or included in evidence. Real token/terrain operation is **not-run**; HTTP 401/403 and offline fallback are simulated tests, not successful authenticated access. Terrain activation samples the center and corners once; the common display/GI anchor is rebuilt, while failed or unsupported placement falls back locally. See [page instructions](../../demo/globe-README.md).

## Lifecycle and transport

Publication notification is queued after the Scene render and round transaction. World/Scene destruction, replacement, new solve and throwing listeners are tested at first and final rounds. A firstPublished handler may destroy the world before the queued notification; that stale notification is canceled. A late Worker error cannot change a destroyed world. See [contract](../../docs/publication-lifecycle.md) and timestamped lifecycle JSON, including the first failed startup and successful reruns.

The opt-in upper-hemisphere environment returns black below the horizon and retains Unknown as invalid. CPU and GPU transport derive a complete local root-bounds distance with the historical 100 m minimum retained. The 150 m blocker fixture verifies real production sunlight visibility beyond 100 m; explicit finite diagnostic rays still describe finite segments. No full-Earth BVH or terrain GI is claimed.

## Same-quality visibility comparison

A: original reviewed visibility GLSL + original stable median BVH. ${candidate}: ${performance?.definitions?.[candidate] ?? "candidate not measured"}. Warm trial order ${(performance?.order ?? []).join("/")}; three fixed solar directions per trial. All camera, model, resolution, shadows, probes, rays, bounces and update budget remain the same. See [raw measurements](visibility-performance.json), [query correctness](visibility-gpu.json), [CPU corpus](visibility-cpu.json) and [long-domain fixture](visibility-far-blocker.json). The A shader's revision and SHA256 are recorded. ${performance?.baselineLimitation ?? "Performance run not completed."}

Values below are median [minimum, maximum]. Per-direction tables, stage counters, query queues, initialization stages, full-frame disabled/static/updating costs and exact configuration remain in the raw report. The target uses the median of the three per-run visibility medians.

| Quantity | A | ${candidate} |
| --- | ---: | ---: |
${rows.map(([label,a,b])=>`| ${label} | ${format(a)} | ${format(b)} |`).join("\n")}

Visibility improvement: **${improvement === null ? "not-run" : (improvement*100).toFixed(1)+"%"}**, 30% target **${performanceSummary.targetStatus}**. Do not read CPU promise times as GPU completion or physical presentation. Performance phases prohibit readPixels/finish/blocking waits; HDR, E and visibility comparisons run separately. Snapshot N-bounce equality is an algorithmic reference, not an absolute physical truth. The independently rebuilt original baseline is [baseline-clean-visibility.json](baseline-clean-visibility.json), status **${cleanBaseline?.status ?? "not-run"}**. It uses the same three solar directions and harness; it remains a separate experiment, not pooled into the interleaved trials. Original benchmark:relighting evidence, if available, is listed separately below.

The earlier SAH candidate has a retained [failed numerical comparison](visibility-performance-failed-sah.json). Its speed alone does not establish same-quality acceptance. [CPU asset memory](asset-memory.json) reports decoded textures, geometry and BVH typed arrays separately; these exclude JavaScript overhead and browser/driver caches. [Sponza hashes](sponza-asset-chain.json) cover the root glTF and its referenced buffers and textures.

The discrepancy was traced to 170 exactly equidistant coincident hits, including opposite winding. SAH now uses original median rank for exact-distance ties, adding no tolerance. [Single-direction diagnosis](visibility-sponza-diagnosis-ranked.json) and [three-direction Sponza verification](visibility-sponza-three-directions-ranked.json) record the corrected identities, distances, E and visibility. Traversal statistics are compiled only into the diagnostic query shader.

[Actual forward HDR comparison](${hdrFile ?? "not-run"}) status **${status(hdrReport)}** separately reads the Scene color framebuffer before postprocessing after all three bounces for each of the three solar directions. Camera, model transform, exposure, gain, resolution, shadows, time and display light are checked equal. Its predeclared RGB tolerance is 2e-4 absolute + 1e-3 relative, with separate non-finite/empty-frame checks. These diagnostic readbacks are excluded from performance trials; this is browser HDR evidence, not physical-display latency.

The measured production defaults are now \`bvhStrategy: "sah"\`, \`bvhBins: 12\`, \`visibilityMode: "optimized"\`; the median/reference options remain available. SAH increases retained CPU BVH and GPU memory, and building the original median tie order adds Worker cost. These costs are included in the table, even though GPU initialization and direction updates improve. The 3 ms setting is a scheduling target, not a whole-frame limit; low display FPS and asynchronous timer estimates still constrain wall-clock response.

[Separate scheduler diagnosis](scheduler.json) observes the unchanged production loop with a Proxy around its cost estimates. It records each submitted frame, queue depth, queue peak and the exact branch that ends a frame after a batch when the next estimate is unavailable. It introduces diagnostic CPU overhead and is excluded from all speed claims. Reproduce with \`node scripts/diagnose-scheduler.mjs\`. Initial-estimate deferrals are ${JSON.stringify(summary.scheduler?.result?.estimateDeferrals ?? null)}; query queue peak/final are ${summary.scheduler?.result?.queryQueuePeak ?? "not-run"}/${summary.scheduler?.result?.queryQueueFinal ?? "not-run"}. These are asynchronous submission deferrals, not blocking waits.

The independent original build's median of run medians is **${cleanRunMedians?.median?.toFixed(2) ?? "not-run"} ms**, giving **${cleanImprovement === null ? "not-run" : (cleanImprovement*100).toFixed(1)+"%"}** candidate reduction in that separate-session comparison. Raw dates, ranges and configurations remain available. This does not replace the interleaved A/B experiment.

## Screenshots and numeric evidence

Earth performance is a separate small-scene workload at 1280×800, not evidence that Sponza is real-time. [Raw Earth measurement](${globePerformanceFile ?? "globe-performance-not-run.json"}) status **${globePerformance?.status ?? "not-run"}**: GI off/static/updating **${[globe?.disabled?.fps,globe?.idle?.fps,globe?.updating?.fps].map(v=>Number.isFinite(v)?v.toFixed(2):"not-run").join(" / ")} FPS**; first/final CPU submission **${[globe?.firstPublishedSubmissionMilliseconds,globe?.finalSubmissionMilliseconds].map(v=>Number.isFinite(v)?v.toFixed(2):"not-run").join(" / ")} ms**. The updating rAF window can include settled frames. GBuffer and preserveDrawingBuffer are off. Three Earth/building navigation cycles record whole-context resources ${JSON.stringify(globe?.resources ?? null)}; GI memory stays ${globe?.initialMemory?.currentBytes ?? "not-run"} → ${globe?.finalMemory?.currentBytes ?? "not-run"} bytes, world/Worker identity and revision are preserved, and pending Worker/GPU queries are ${globe?.pendingWorkerRequests ?? "not-run"}/${globe?.pendingGpuQueries ?? "not-run"}. Initialization stages and every direction-update GPU stage remain in that raw report.

All PNGs are actual browser renders: [Earth](globe-earth.png), [pavilion on Globe](globe-context.png), [overhead](globe-top.png), [corridor](globe-corridor.png), [indoor transition](globe-inside.png), same-camera [GI on](globe-ab-on.png) / [off with IBL fallback](globe-ab-off.png), and [pure indirect](globe-indirect.png). No generated or retouched images are used. Asset SHA256, GBuffer/BVH alignment, fixed-receiver HDR with colored/neutral transfer, solar sign and equivalent GI at another longitude/latitude are in [globe-results.json](globe-results.json).

Product A/B includes the original IBL fallback when Lumen is off. The colored/neutral transfer comparison holds the visible receiver, exposure, camera and gain fixed and changes backend colored reflectance; it is a separate causal diagnostic. No display amplification is used. Globe imagery and surrounding terrain remain background and do not participate in complete indirect transport. Interpolation dark blotches around small objects/corners remain visible in the screenshots.

The final bookmark captures wait for ten consecutive tiles-loaded frames. The placement diagnostic samples \`Globe.getHeight\` at the center and four corners, measuring the actual rendered triangle surface rather than only the analytical ellipsoid. Stable measured foundation gaps were 0.145–0.309 mm (checked against a 1 cm limit). Reproduce the independent visual/height diagnosis with \`node scripts/diagnose-globe-placement.mjs\`; its timestamped directories contain unchanged-default and normal-offset comparison captures. Some ground-shadow separation remains visually noticeable; an isolated normal-offset toggle did not establish a safe clear improvement, so the default shadow configuration and original geometry are retained. This distinguishes verified geometric contact from unresolved shadow appearance.

## Verification inventory

Run \`npm run test:publication-lifecycle\`, \`npm run test:globe\`, \`npm run test:visibility\`; original fixture/relighting/integration/progressive suites remain available. Run benchmarks serially with no other GPU test: \`npm run benchmark:visibility\`, \`npm run benchmark:globe\`, \`npm run benchmark:relighting\`. Regenerate this inventory with \`npm run report:globe-visibility\`.

| Evidence/check | Status |
| --- | --- |
${Object.entries(tests).map(([name,result])=>`| ${result.evidence ? `[${name}](${result.evidence})` : name} | ${result.status} |`).join("\n")}

Failed/interrupted JSON records are retained; current scripts also write timestamped raw copies. One earlier successful GPU-fixture plain JSON was overwritten before timestamping was added. Four initial failed antipode PNGs were overwritten during the successful rerun; [the actual offscreen-camera diagnostic reproduction](globe-antipode-failed-offscreen-reproduction.png) is retained as a reproduction, not an original failed capture. Current Globe screenshot sets and JSON are archived under \`runs/<timestamp>\`. The final narrow-FOV check projects the real model at the image center: Globe-on show/hide HDR is unchanged, while Globe-off is a visible positive control. This avoids accepting an offscreen model as proof of occlusion. Full upstream Karma and physical-display latency are not claimed. No Cesium upgrade, GBuffer rewrite, dynamic geometry, Tiles GI, SDF, Cards, SSGI, reflections or WebGPU is included. The branch is not merged into main.
`);
console.log(JSON.stringify({ head: summary.head, tests, performance: performanceSummary },null,2));
