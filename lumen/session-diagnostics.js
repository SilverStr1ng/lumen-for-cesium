// Explicit synchronous diagnostics. This module never runs in production frames.
// Camera.update reorthogonalizes doubles every frame. Bound that roundoff in
// pose space (64 machine epsilons), rather than compare ECEF matrix strings.
// At Earth radius the position allowance is below 0.1 micrometre; actual
// camera motion, projection changes and drawing-buffer changes still reject.
export function sameDiagnosticCamera(a, b) {
  const vector = (v, n) =>
    Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if (!a || !b || !vector(a.position, 3) || !vector(b.position, 3))
    return false;
  const roundoff = 64 * Number.EPSILON,
    positionScale = Math.max(
      1,
      ...a.position.map(Math.abs),
      ...b.position.map(Math.abs),
    );
  for (const key of ["position", "direction", "up", "right"]) {
    if (!vector(a[key], 3) || !vector(b[key], 3)) return false;
    const bound = roundoff * (key === "position" ? positionScale : 1);
    if (a[key].some((v, i) => Math.abs(v - b[key][i]) > bound)) return false;
  }
  return ["projection", "buffer"].every(
    (key) =>
      vector(a[key], key === "projection" ? 16 : 2) &&
      vector(b[key], key === "projection" ? 16 : 2) &&
      a[key].every((v, i) => v === b[key][i]),
  );
}
function cameraPose(C, scene) {
  return {
    position: C.Cartesian3.pack(scene.camera.positionWC, []),
    direction: C.Cartesian3.pack(scene.camera.directionWC, []),
    up: C.Cartesian3.pack(scene.camera.upWC, []),
    right: C.Cartesian3.pack(scene.camera.rightWC, []),
    projection: C.Matrix4.toArray(scene.camera.frustum.projectionMatrix),
    buffer: [scene.drawingBufferWidth, scene.drawingBufferHeight],
  };
}
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
    pixels.length > 256 ||
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
  const inverse = C.Matrix4.inverseTransformation(
    session.frame,
    new C.Matrix4(),
  );
  let camera, rays;
  const captureRays = () =>
    pixels.map(([x, y]) => {
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
  const lease = session.budget.tryReserve(
    65536 + pixels.length * 256,
    "diagnostic pixel capture",
  );
  if (!lease)
    throw new DOMException(
      "Diagnostic capture exceeds available budget",
      "QuotaExceededError",
    );
  fg.freezeSampling = true;
  const values = {},
    frameStates = {};
  let firstPublication;
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
      // A variant change rebuilds forward/derived programs. A single postRender
      // may still have used the base fallback; never read it as FG diagnostic E.
      const deadline = performance.now() + 30000;
      let stable = 0;
      while (stable < 2) {
        await session._afterFrame(() => {
          session._guard(token, signal);
          if (
            world !== session.world ||
            revision !== world.requestedRevision ||
            profile !== session.profile
          )
            throw Error("Diagnostic frame ownership changed while preparing");
          const context = scene.context;
          stable =
            context._lastShaderPreparationPending === 0 &&
            !context._lumenBaseGroup?.blocked
              ? stable + 1
              : 0;
          if (performance.now() > deadline)
            throw new DOMException(
              "Diagnostic variant not ready",
              "TimeoutError",
            );
        }, signal);
      }
      values[name] = await session._afterFrame(() => {
        session._guard(token, signal);
        if (
          world !== session.world ||
          revision !== world.requestedRevision ||
          profile !== session.profile
        )
          throw Error("Diagnostic frame ownership changed");
        const renderedCamera = cameraPose(C, scene);
        if (!camera) {
          camera = renderedCamera;
          rays = captureRays();
        }
        if (
          width !== scene.drawingBufferWidth ||
          height !== scene.drawingBufferHeight ||
          !sameDiagnosticCamera(camera, renderedCamera)
        )
          throw Error("Diagnostic rendered camera changed");
        const color = scene._view.sceneFramebuffer._colorFramebuffer,
          framebuffer =
            color._multisampleFramebuffer?.getColorFramebuffer() ??
            color.framebuffer;
        frameStates[name] = {
          requestedRevision: world.requestedRevision,
          publishedRevision: world.publishedRevision,
          round: world.publishedBounce,
          camera: renderedCamera,
          frameNumber: scene._frameState.frameNumber,
        };
        firstPublication ??= frameStates[name];
        if (
          frameStates[name].publishedRevision !==
            firstPublication.publishedRevision ||
          frameStates[name].round !== firstPublication.round
        )
          throw Error("Diagnostic publication changed between capture frames");
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
      world.publishedRevision !== firstPublication.publishedRevision ||
      world.publishedBounce !== firstPublication.round ||
      profile !== session.profile ||
      !sameDiagnosticCamera(camera, cameraPose(C, scene))
    )
      throw Error("Diagnostic frame ownership/camera changed");
    return {
      width,
      height,
      pixels,
      rays,
      camera,
      cameraRoundoffFactor: 64,
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
    lease.release();
    if (!scene.isDestroyed()) {
      scene.lumen.debugMode = previousMode;
      fg.freezeSampling = previousFreeze;
      scene.requestRender();
    }
  }
}
