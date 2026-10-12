/** Cover every triangle in the resident local scene, never infer sky at a cutoff.
 * Keep the historical 100 m floor so existing empty-ray distance moments agree.
 */
export function completeTraceDistance(bounds, origin) {
  return Math.max(
    100,
    Math.hypot(...origin.map((value, axis) =>
      Math.max(Math.abs(bounds[axis] - value), Math.abs(bounds[axis + 3] - value)))) + 1,
  );
}
