// Explicit synchronous diagnostics only. Production rendering never calls this module.
export function receiverSamples(lab, limit = 48) {
  const w = lab.world,
    fg = lab.scene.lumen.finalGather;
  if (!fg.ready) throw Error(fg.metrics.status);
  const [width, height] = fg.metrics.resolution,
    [rw, rh] = fg.metrics.receiverResolution;
  const positions = w._read(fg.receiver.framebuffer, rw, rh, 0),
    normals = w._read(fg.receiver.framebuffer, rw, rh, 1);
  const index = (fg.samples / 4 - 1) % 2,
    raw = w._read(fg.ping[index].framebuffer, width, height),
    points = [];
  let validReceivers = 0,
    validFg = 0,
    unknown = 0,
    nonfinite = 0,
    primaryRays = 0;
  for (let i = 0; i < width * height; i++) {
    const x = i % width,
      y = Math.floor(i / width),
      r = ((y + fg.offset.y) * rw + x + fg.offset.x) * 4;
    if (positions[r + 3] > 0.5) {
      validReceivers++;
      primaryRays += fg.samples;
    }
    if (raw[i * 4 + 3] > 0.5) validFg++;
    if (raw[i * 4 + 3] < 0) unknown++;
    for (let j = 0; j < 4; j++)
      if (!Number.isFinite(raw[i * 4 + j])) nonfinite++;
  }
  for (let gy = 0; gy < 6; gy++)
    for (let gx = 0; gx < 8; gx++) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / 8)),
        y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / 6)),
        i = (y * width + x) * 4,
        r = ((y + fg.offset.y) * rw + x + fg.offset.x) * 4;
      if (positions[r + 3] < 0.5) continue;
      points.push({
        pixel: [x, y],
        position: Array.from(positions.slice(r, r + 3)),
        normal: Array.from(normals.slice(r, r + 3)),
        owner: positions[r + 3],
        E: Array.from(raw.slice(i, i + 3)),
        valid: raw[i + 3] > 0.5,
        unknown: raw[i + 3] < 0,
      });
    }
  return {
    points: points.slice(0, limit),
    validReceivers,
    validFg,
    unknown,
    unknownFraction: validReceivers ? unknown / validReceivers : 0,
    nonfinite,
    primaryRays,
    solarRayUpperBound: primaryRays,
  };
}
export function linearFrame(lab, mode) {
  lab.scene.lumen.debugMode = mode;
  lab.widget.render();
  const { scene, world } = lab,
    width = scene.drawingBufferWidth,
    height = scene.drawingBufferHeight;
  const f = scene._view.sceneFramebuffer._colorFramebuffer,
    fb = f._multisampleFramebuffer?.getColorFramebuffer() ?? f.framebuffer;
  const data = world._read(fb, width, height);
  return data;
}
export async function rawHash(lab) {
  const w = lab.world,
    g = w.packet.grid,
    a = w._read(w._atlases[w._published].fb, g.width, g.height);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", a.buffer)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
