// Explicit synchronous diagnostics. This module never runs in production frames.
export async function capturePixels(
  session,
  pixels,
  { usedOnly = false } = {},
) {
  const { C, scene, world } = session,
    fg = scene.lumen.finalGather;
  const width = scene.drawingBufferWidth,
    height = scene.drawingBufferHeight;
  if (
    !Array.isArray(pixels) ||
    pixels.some(
      ([x, y]) =>
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height,
    )
  )
    throw Error("Drawing-buffer pixel coordinates required");
  const token = session.generation,
    revision = world.requestedRevision,
    profile = session.profile,
    signal = session._controller.signal;
  const camera = C.Matrix4.toArray(scene.camera.viewMatrix).join(","),
    inverse = C.Matrix4.inverseTransformation(session.frame, new C.Matrix4());
  const rays = pixels.map(([x, y]) => {
    const ray = scene.camera.getPickRay(
      new C.Cartesian2(
        ((x + 0.5) * scene.canvas.clientWidth) / width,
        ((y + 0.5) * scene.canvas.clientHeight) / height,
      ),
    );
    return {
      origin: C.Cartesian3.pack(
        C.Matrix4.multiplyByPoint(inverse, ray.origin, new C.Cartesian3()),
        [],
      ),
      direction: C.Cartesian3.pack(
        C.Cartesian3.normalize(
          C.Matrix4.multiplyByPointAsVector(
            inverse,
            ray.direction,
            new C.Cartesian3(),
          ),
          new C.Cartesian3(),
        ),
        [],
      ),
    };
  });
  const previousMode = scene.lumen.debugMode,
    previousFreeze = fg.freezeSampling;
  fg.freezeSampling = true;
  const values = {},
    frameStates = {};
  try {
    for (const [name, mode] of usedOnly
      ? [["usedE", 4]]
      : [
          ["usedE", 4],
          ["coverage", 5],
          ["fgWeight", 15],
          ["fallback", 17],
        ]) {
      scene.lumen.debugMode = mode;
      values[name] = await session._afterFrame(() => {
        const color = scene._view.sceneFramebuffer._colorFramebuffer,
          framebuffer =
            color._multisampleFramebuffer?.getColorFramebuffer() ??
            color.framebuffer;
        frameStates[name] = {
          requestedRevision: world.requestedRevision,
          publishedRevision: world.publishedRevision,
          round: world.publishedBounce,
        };
        return pixels.map(([x, y]) =>
          Array.from(
            world
              ._read(framebuffer, 1, 1, 0, undefined, x, height - 1 - y)
              .subarray(0, 3),
          ),
        );
      }, signal);
    }
    session._guard(token, signal);
    if (
      world !== session.world ||
      revision !== world.requestedRevision ||
      profile !== session.profile ||
      camera !== C.Matrix4.toArray(scene.camera.viewMatrix).join(",")
    )
      throw Error("Diagnostic frame ownership/camera changed");
    return {
      width,
      height,
      pixels,
      rays,
      ...values,
      frameStates,
      version: session.manifest.version,
      revision,
      profile,
      transientCpuReadbackBytes:
        16 + pixels.length * 3 * 8 * (usedOnly ? 1 : 4),
      scope:
        "Actual main HDR linear E; explicit diagnostic readbacks, not presentation latency",
    };
  } finally {
    if (!scene.isDestroyed()) {
      scene.lumen.debugMode = previousMode;
      fg.freezeSampling = previousFreeze;
      scene.requestRender();
    }
  }
}
