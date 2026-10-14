// CPU-only planning. No allocation, renderer scaling, timing readback or history.
const presets = Object.freeze({
  balanced: { scale: 0.5, samples: 16 },
  high: { scale: 0.5, samples: 32 },
  fast: { scale: 0.25, samples: 16 },
  roi: { scale: 1, samples: 64, roi: 256 },
  interactive16: { scale: .5, samples: 16 },
});
const autoScales = Object.freeze([
  0.5,
  0.45,
  0.4,
  1 / 3,
  0.3,
  0.25,
  0.2,
  1 / 6,
  0.125,
]);
function planFinalGather({
  width,
  height,
  quality = "high",
  execution = "split",
  reconstruction = true,
  snapshotBytes = 0,
  additionalSceneBytes = 0,
  memoryBudget = 64 * 1048576,
  invocationBudget = 16 * 1048576,
  maximumTextureSize = 16384,
  maximumRenderbufferSize = maximumTextureSize,
  samplerUnits = 16,
  requiredSamplers = 13,
  colorAttachments = 4,
  floatRenderable = true,
} = {}) {
  const invalid =
    ![
      width,
      height,
      maximumTextureSize,
      maximumRenderbufferSize,
      samplerUnits,
      requiredSamplers,
      colorAttachments,
    ].every((n) => Number.isInteger(n) && n > 0) ||
    ![snapshotBytes, additionalSceneBytes, memoryBudget, invocationBudget].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !["split", "fused4", "fused8"].includes(execution) ||
    !(quality === "auto" || presets[quality]) ||
    typeof reconstruction !== "boolean";
  if (invalid) {
    return {
      supported: false,
      reason: "invalid planning input",
      rejections: [],
    };
  }
  // Auto keeps one receiver choice across A/B/C/D: raw ablations reserve
  // reconstruction capacity without allocating history, preserving same-size inputs.
  const automatic = quality === "auto" || quality === "interactive16";
  const planReconstruction = reconstruction || automatic;
  const p = quality === "auto" ? presets.high : presets[quality],
    rejected = [];
  for (const scale of automatic ? autoScales : [p.scale]) {
    const rw = Math.max(1, Math.ceil(width * scale)),
      rh = Math.max(1, Math.ceil(height * scale)),
      w = p.roi ? Math.min(rw, p.roi) : rw,
      h = p.roi ? Math.min(rh, p.roi) : rh,
      receiverBytes = rw * rh * 36,
      hitBytes = execution === "split" ? w * h * 64 : 0,
      workBytes = w * h * 36,
      historyBytes = reconstruction ? w * h * 100 : 0,
      bytes = receiverBytes + hitBytes + workBytes + historyBytes,
      slots = w * h * p.samples,
      geometrySlots = reconstruction ? w * h * 8 + width * height : 0,
      reservedHistoryBytes =
        !reconstruction && planReconstruction ? w * h * 100 : 0,
      reservedGeometrySlots =
        !reconstruction && planReconstruction ? w * h * 8 + width * height : 0;
    const reasons = [];
    if (!floatRenderable || colorAttachments < (planReconstruction ? 4 : 2)) {
      reasons.push("float/MRT capability");
    }
    if (samplerUnits < requiredSamplers) {
      reasons.push("fragment sampler limit");
    }
    if (
      rw > maximumTextureSize ||
      rh > maximumTextureSize ||
      (execution === "split" ? w * 4 : w) > maximumTextureSize ||
      rw > maximumRenderbufferSize ||
      rh > maximumRenderbufferSize
    ) {
      reasons.push("texture/renderbuffer dimensions");
    }
    if (bytes + reservedHistoryBytes + snapshotBytes + additionalSceneBytes > memoryBudget) {
      reasons.push("additional memory budget");
    }
    if (slots + geometrySlots + reservedGeometrySlots > invocationBudget) {
      reasons.push("primary slots plus geometry query budget");
    }
    const plan = {
      supported: reasons.length === 0,
      reason:
        reasons.join("; ") ||
        (rejected.length
          ? "Auto reduced receiver to fit budgets"
          : "requested receiver fits"),
      requestedQuality: quality,
      effectiveQuality: automatic ? `${quality}@${scale}` : quality,
      scale,
      samples: p.samples,
      targetFrames: quality === "interactive16" ? 64 : 32,
      execution,
      reconstruction,
      rw,
      rh,
      width: w,
      height: h,
      ox: Math.floor((rw - w) / 2),
      oy: Math.floor((rh - h) / 2),
      bytes,
      snapshotBytes,
      additionalSceneBytes,
      totalBytes: bytes + snapshotBytes + additionalSceneBytes,
      reservedHistoryBytes,
      reservedGeometrySlots,
      planningBytes: bytes + snapshotBytes + additionalSceneBytes + reservedHistoryBytes,
      slots,
      geometrySlots,
      checkedInvocations: slots + geometrySlots,
      requiredSamplers,
      attachments: { receiverBytes, hitBytes, workBytes, historyBytes },
    };
    if (plan.supported) {
      return { ...plan, rejections: rejected };
    }
    rejected.push({
      scale,
      receiver: [rw, rh],
      totalBytes: plan.totalBytes,
      checkedInvocations: plan.checkedInvocations,
      reasons,
    });
    if (!automatic) {
      return { ...plan, rejections: rejected };
    }
  }
  return {
    supported: false,
    reason: `no Auto receiver fits: ${rejected.at(-1).reasons.join("; ")}`,
    requestedQuality: quality,
    rejections: rejected,
  };
}
planFinalGather.presets = presets;
export default planFinalGather;
