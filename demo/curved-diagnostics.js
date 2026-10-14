// Explicit synchronous validation only. Never imported by the render loop.
import sampling from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherSampling.js";
import normals from "../cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherNormals.js";
function primaryCounts(lab) {
  const context = lab.scene.context,
    binding = context._currentFramebuffer;
  const f = lab.scene.lumen.finalGather,
    w = lab.world,
    C = Cesium,
    width = f.resultSize.x,
    height = f.resultSize.y,
    texture = w._texture(width, 1, C.PixelDatatype.FLOAT),
    fb = w._framebuffer([texture]);
  const command = lab.scene.context.createViewportQuadCommand(
    sampling +
      normals.declarations +
      normals.functions +
      `
uniform sampler2D u_countP,u_countN;uniform ivec2 u_countOffset;uniform int u_countHeight;
void main(){int x=int(gl_FragCoord.x);float rays=0.0,zeros=0.0,receivers=0.0;
 for(int y=0;y<4096;y++){if(y>=u_countHeight)break;ivec2 r=ivec2(x,y)+u_countOffset;
  if(texelFetch(u_countP,r,0).a<.5)continue;receivers+=1.0;
  vec4 n=texelFetch(u_countN,r,0);vec3 ng=lumen_fgNg(n),ns=lumen_fgNs(n);
  for(int i=0;i<1024;i++){if(i>=u_fgSamples)break;vec3 d=fgDirection(ns,i,r);
   if(dot(ng,d)<=0.0)zeros+=1.0;else rays+=1.0;}
 }out_FragColor=vec4(rays,zeros,receivers,1);}`,
    {
      uniformMap: {
        u_countP: () => f.receiver.position,
        u_countN: () => f.receiver.normal,
        u_countOffset: () => f.offset,
        u_countHeight: () => height,
        u_lumenFgPackedNormals: () => f.smoothReceivers,
        u_fgSamples: () => f.samples,
        u_fgRayOrder: () => (f.rayOrder === "azimuth" ? 1 : 0),
        u_fgSeed: () => f.seed,
        u_fgSampling: () =>
          f.sampling === "fixed-reference"
            ? 0
            : f.sampling === "reconstructed"
              ? 2
              : 1,
        u_fgEpoch: () => f._epochForFrame | 0,
        u_fgPixelOffset: () => C.Cartesian2.ZERO,
        u_fgPreviousEnabled: () => false,
        u_fgRayBias: () => 0.0002,
      },
    },
  );
  w._commands.r9PrimaryCount = command;
  try {
    w._draw("r9PrimaryCount", fb, 0, 0, width, 1);
    const data = w._read(fb, width, 1);
    let rays = 0,
      zeros = 0,
      receivers = 0;
    for (let i = 0; i < data.length; i += 4) {
      rays += data[i];
      zeros += data[i + 1];
      receivers += data[i + 2];
    }
    return {
      actualPrimaryRays: rays,
      knownZeroDirections: zeros,
      supportedReceiverSlots: receivers * f.samples,
      plannedSlots: f.metrics.raySlots,
      solarRayUpperBound: rays,
      scratchBytes: texture.sizeInBytes,
      method:
        "same production GPU sampler, normals, pixel/epoch and Ng gate; counts every scheduled primary direction",
    };
  } finally {
    delete w._commands.r9PrimaryCount;
    command.shaderProgram.destroy();
    w._freeTexture(texture, fb);
    const gl = context._gl;
    if (binding) {
      binding._bind();
      gl.drawBuffers(binding._getActiveColorAttachments());
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawBuffers([gl.BACK]);
    }
    context._currentFramebuffer = binding;
  }
}
const decode = (x, y) => {
  x = x * 2 - 1;
  y = y * 2 - 1;
  let z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const a = x;
    x = (1 - Math.abs(y)) * (a >= 0 ? 1 : -1);
    y = (1 - Math.abs(a)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
export function captureCurved(lab, { primary = true } = {}) {
  const fg = lab.scene.lumen.finalGather,
    w = lab.world;
  if (!fg.ready || !w?.ready)
    throw Error(`Curved capture unavailable: ${fg.metrics.status}`);
  const previousLoop = lab.widget.useDefaultRenderLoop,
    previousDebug = lab.scene.lumen.debugMode,
    previousFreeze = fg.freezeSampling;
  lab.widget.useDefaultRenderLoop = false;
  fg.freezeSampling = true;
  try {
    const width = lab.scene.drawingBufferWidth,
      height = lab.scene.drawingBufferHeight;
    const frame = (mode) => {
      lab.scene.lumen.debugMode = mode;
      lab.widget.render();
      const f = lab.scene._view.sceneFramebuffer._colorFramebuffer,
        fb = f._multisampleFramebuffer?.getColorFramebuffer() ?? f.framebuffer;
      return w._read(fb, width, height);
    };
    const mask = frame(18),
      weights = frame(15),
      reasons = frame(17),
      owners = frame(19);
    const [rw, rh] = fg.metrics.receiverResolution,
      [fw, fh] = fg.metrics.resolution,
      p = w._read(fg.receiver.framebuffer, rw, rh, 0),
      n = w._read(fg.receiver.framebuffer, rw, rh, 1),
      raw = w._read(
        fg.ping.find((t) => t.texture === fg.texture).framebuffer,
        fw,
        fh,
      ),
      history = fg.reconstruction?.history[fg.reconstruction._index],
      hn = history ? w._read(history.framebuffer, fw, fh, 3) : null,
      E = fg.reconstruction?.texture
        ? (() => {
            const targets = fg.reconstruction.filterTargets;
            return w._read(targets[1].framebuffer, fw, fh);
          })()
        : raw;
    let pixels = 0,
      total = 0,
      inside = 0,
      edge = 0,
      edgeWeight = 0,
      contact = 0,
      contactWeight = 0,
      unsupported = 0;
    const angleBins = Array(7).fill(0),
      fallback = {},
      points = [],
      regionPoints = {
        foregroundContour: [],
        ballFloorContact: [],
        ballBallContact: [],
      },
      regions = Object.fromEntries(
        Object.keys(regionPoints).map((name) => [
          name,
          { pixels: 0, weight: 0 },
        ]),
      ),
      regionMask = new Uint8Array(width * height),
      balls = lab.descriptor.balls,
      floorZ = lab.descriptor.container.find((p) => p.name === "floor").hi[2];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (owners[i] < 128) continue;
        pixels++;
        total += weights[i];
        if (mask[i + 2] > 0.5) inside++;
        if (mask[i + 1] > Math.PI / 6) unsupported++;
        angleBins[Math.min(6, Math.floor((mask[i + 1] * 180) / Math.PI / 5))]++;
        const reason = Math.round(reasons[i]);
        fallback[reason] = (fallback[reason] ?? 0) + 1;
        let boundary = false,
          other = false,
          floor = false;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) {
            boundary = true;
            continue;
          }
          const j = ((y + dy) * width + x + dx) * 4;
          if (owners[j] < 128) boundary = true;
          if (owners[j] >= 128 && Math.abs(owners[i] - owners[j]) > 0.1)
            other = true;
          if (owners[j] === 1 && owners[j + 2] === 4) floor = true;
        }
        if (boundary) {
          edge++;
          edgeWeight += weights[i];
        }
        if (other) {
          contact++;
          contactWeight += weights[i];
        }
        // Full-resolution owner/position tag includes unsupported edge pixels.
        // Receiver validity must not determine this coverage denominator.
        const ground = floor && owners[i + 2] === 8;
        const memberships = [boundary && !ground, ground, other];
        Object.keys(regions).forEach((name, k) => {
          if (!memberships[k]) return;
          regions[name].pixels++;
          regions[name].weight += weights[i];
          regionMask[y * width + x] |= 1 << k;
        });
      }
    let receivers = 0,
      valid = 0,
      maxHistoryNormalDegrees = 0;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const i = (y * fw + x) * 4,
          r = ((y + fg.offset.y) * rw + x + fg.offset.x) * 4;
        if (p[r + 3] < 4096) continue;
        receivers++;
        if (raw[i + 3] > 0.5) valid++;
        const ng = decode(n[r], n[r + 1]),
          ns = decode(n[r + 2], n[r + 3]);
        if (hn) {
          const hng = decode(hn[i], hn[i + 1]),
            hns = decode(hn[i + 2], hn[i + 3]);
          const angle = (a, b) =>
            (Math.acos(
              Math.max(
                -1,
                Math.min(
                  1,
                  a.reduce((s, v, k) => s + v * b[k], 0),
                ),
              ),
            ) *
              180) /
            Math.PI;
          maxHistoryNormalDegrees = Math.max(
            maxHistoryNormalDegrees,
            angle(ng, hng),
            angle(ns, hns),
          );
        }
        const point = () => ({
          pixel: [x, y],
          position: Array.from(p.slice(r, r + 3)),
          geometricNormal: ng,
          normal: ns,
          owner: p[r + 3],
          raw: Array.from(raw.slice(i, i + 3)),
          E: Array.from(E.slice(i, i + 3)),
          valid: raw[i + 3] > 0.5,
        });
        if (
          x % Math.max(1, Math.floor(fw / 22)) === 0 &&
          y % Math.max(1, Math.floor(fh / 16)) === 0
        )
          points.push(point());
        const hx = Math.min(
            width - 1,
            Math.floor(((x + fg.offset.x + 0.5) * width) / rw),
          ),
          hy = Math.min(
            height - 1,
            Math.floor(((y + fg.offset.y + 0.5) * height) / rh),
          ),
          ownBall = balls.find((b) => b.ballId === p[r + 3] - 4096),
          nearGround = p[r + 2] <= floorZ + 0.04,
          nearBall = balls.some(
            (b) =>
              b !== ownBall &&
              Math.hypot(
                p[r] - b.position[0],
                p[r + 1] - b.position[1],
                p[r + 2] - b.position[2],
              ) <=
                b.radius + 0.04,
          ),
          memberships = [
            !!(regionMask[hy * width + hx] & 1),
            nearGround,
            nearBall,
          ];
        Object.keys(regionPoints).forEach((name, k) => {
          if (memberships[k] && regionPoints[name].length < 8)
            regionPoints[name].push(point());
        });
      }
    return {
      generation: lab.snapshot().generation,
      revision: w.finalGatherSnapshot.revision,
      round: w.finalGatherSnapshot.round,
      seed: fg.seed,
      epoch: fg.metrics.sampleEpoch,
      receiver: [rw, rh],
      samples: fg.samples,
      resolution: [width, height],
      pixels,
      insideVolumePixels: inside,
      meanWeight: pixels ? total / pixels : 0,
      unsupportedPixels: unsupported,
      edgePixels: edge,
      edgeMeanWeight: edge ? edgeWeight / edge : 0,
      contactPixels: contact,
      contactMeanWeight: contact ? contactWeight / contact : 0,
      regions: Object.fromEntries(
        Object.entries(regions).map(([name, r]) => [
          name,
          {
            pixels: r.pixels,
            meanWeight: r.pixels ? r.weight / r.pixels : null,
            status: r.pixels ? "measured" : "not-run",
          },
        ]),
      ),
      regionDefinition:
        "foreground projected contour excluding floor-contact band; ball-floor boundary within 4cm of floor; boundary against a different ball owner. Reference points use actual low receiver Ng/Ns, within 4cm of floor/other sphere; invalid samples retained.",
      regionPoints,
      rayCounts: primary ? primaryCounts(lab) : undefined,
      angleBins5Degrees: angleBins,
      fallback,
      receivers,
      validRawFraction: receivers ? valid / receivers : 0,
      maxHistoryNormalDegrees,
      points,
    };
  } finally {
    lab.scene.lumen.debugMode = previousDebug;
    fg.freezeSampling = previousFreeze;
    lab.widget.useDefaultRenderLoop = previousLoop;
    lab.scene.requestRender();
  }
}
