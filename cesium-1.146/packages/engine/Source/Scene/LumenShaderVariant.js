// Finite source contracts. Values, model IDs and lighting revisions are uniforms,
// never shader-cache keys. A non-session model cannot borrow a session's GI.
export default function lumenShaderVariant(model, frameState) {
  const lumen = frameState?.lumen;
  if (model._lumenPendingDataset || !lumen?.enabled) return "cesium";
  const registered =
    lumen.finalGather?.models?.has(model) || lumen.finalGather?.model === model;
  if (lumen.resourceBudget && !registered) return "cesium";
  const fg = registered && lumen.finalGather.mode !== "ddgi";
  const diagnostic =
    (lumen.debugMode ?? 0) !== 0 || (fg && lumen.finalGather.mode === "raw");
  return `${fg ? "fg" : "ddgi"}${diagnostic ? "-diagnostic" : ""}`;
}
