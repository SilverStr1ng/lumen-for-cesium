import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import plan from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherPlan.js";
const rows = [];
for (const [width, height] of [
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
])
  for (const snapshotBytes of [2957760, 5645952])
    for (const execution of ["split", "fused4", "fused8"]) {
      const fixed = plan({ width, height, snapshotBytes, execution }),
        auto = plan({
          width,
          height,
          snapshotBytes,
          execution,
          quality: "auto",
        });
      assert(auto.supported);
      assert(auto.totalBytes <= 67108864);
      assert(auto.checkedInvocations <= 16777216);
      assert.equal(auto.samples, 32);
      assert(Math.abs(auto.rw / auto.rh - width / height) < 0.01);
      if (execution === "split")
        assert.equal(
          fixed.totalBytes,
          Math.ceil(width / 2) * Math.ceil(height / 2) * 236 + snapshotBytes,
        );
      if (width >= 1920) assert.equal(fixed.supported, false);
      rows.push({
        drawingBuffer: [width, height],
        snapshotBytes,
        execution,
        fixed,
        auto,
      });
    }
assert.equal(
  plan({ width: 1280, height: 800, snapshotBytes: 2957760 }).totalBytes,
  63373760,
);
for (const bad of [
  { width: 0 },
  { memoryBudget: 1 },
  { invocationBudget: 1 },
  { maximumTextureSize: 1 },
  { samplerUnits: 8 },
  { colorAttachments: 1 },
  { floatRenderable: false },
])
  assert.equal(
    plan({ width: 1920, height: 1080, quality: "auto", ...bad }).supported,
    false,
  );
for (const pixelRatio of [1, 1.5, 2])
  for (const resolutionScale of [0.5, 1, 1.25]) {
    const width = Math.round(960 * pixelRatio * resolutionScale),
      height = Math.round(540 * pixelRatio * resolutionScale);
    const result = plan({
      width,
      height,
      quality: "auto",
      snapshotBytes: 5645952,
    });
    assert(result.supported);
    rows.push({
      css: [960, 540],
      pixelRatio,
      resolutionScale,
      drawingBuffer: [width, height],
      result,
    });
  }
await mkdir("reports/fg-runtime-budget-v7", { recursive: true });
await writeFile(
  "reports/fg-runtime-budget-v7/budget-plan.json",
  JSON.stringify(
    {
      status: "passed",
      scope: "pure formulas; browser allocations verified separately",
      rows,
    },
    null,
    2,
  ),
);
console.log(
  "PASS pure budget plans: desktop buffers, snapshots, split/fused attachments, capability rejection, DPR/scale inputs",
);
