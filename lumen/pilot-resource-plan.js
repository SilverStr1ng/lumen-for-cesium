// Upper bounds for the existing static WebGL2 packing, not a quality preset.
export function atlasBytes(images) {
  if (!images) return 4;
  const columns = Math.min(8, images);
  return columns * Math.ceil(images / columns) * 512 * 512 * 4;
}
export function worldGpuBound(geometry, enhanced) {
  const n = geometry.materialIds.length,
    p = geometry.plan.total;
  const padded = (texels) => 2048 * Math.ceil(texels / 2048) * 16;
  const materials = geometry.materials.length * 12 * 16;
  return (
    padded(n * 4) +
    padded(n * 3) +
    padded(n + Math.ceil(n / 4)) +
    materials +
    atlasBytes(geometry.images.filter(Boolean).length) +
    p * (32 + 128 * 36 + 100 * 64 + 64 * 32) +
    (enhanced ? p * 100 * 32 + materials : 0)
  );
}
