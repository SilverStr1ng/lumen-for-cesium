// Explicit synchronized diagnostics; never imported by production.
export function readReconstruction(lab) {
  const f = lab.scene.lumen.finalGather,
    w = lab.world;
  if (!f.ready || !f.reconstruction) throw Error(f.metrics.status);
  const r = f.reconstruction,
    [width, height] = f.metrics.resolution,
    [rw, rh] = f.metrics.receiverResolution;
  const raw = w._read(
    f.ping[(f.samples / 4 - 1) % 2].framebuffer,
    width,
    height,
  );
  const temporal = w._read(r.history[r._index].framebuffer, width, height, 0);
  const moments = w._read(r.history[r._index].framebuffer, width, height, 1);
  const filtered = w._read(r.filterTargets[1].framebuffer, width, height);
  const positions = w._read(f.receiver.framebuffer, rw, rh, 0),
    normals = w._read(f.receiver.framebuffer, rw, rh, 1);
  const mask = w._read(
    f.neighborhood.framebuffer,
    width,
    height,
    0,
    Cesium.PixelDatatype.UNSIGNED_BYTE,
  );
  const connections = w._read(
    r.connectionFramebuffer,
    width,
    height,
    0,
    Cesium.PixelDatatype.UNSIGNED_BYTE,
  );
  const reasons = {},
    historyReasons = {};
  let receivers = 0,
    valid = 0,
    history = 0,
    length = 0,
    peak = 0;
  for (let i = 0; i < width * height; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const guideIndex = ((y + f.offset.y) * rw + x + f.offset.x) * 4;
    if (positions[guideIndex + 3] > 0.5) receivers++;
    if (raw[i * 4 + 3] > 0.5) valid++;
    if (temporal[i * 4 + 3] > 0.5) {
      history++;
      length += temporal[i * 4 + 3];
      peak = Math.max(peak, ...temporal.slice(i * 4, i * 4 + 3));
    }
    const reason =
      raw[i * 4 + 3] > 0.5
        ? "valid"
        : raw[i * 4 + 3] === -2
          ? "solar-unknown"
          : raw[i * 4 + 3] < 0
            ? "primary-unknown"
            : "missing";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    const h = String(moments[i * 4 + 3]);
    historyReasons[h] = (historyReasons[h] ?? 0) + 1;
  }
  return {
    width,
    height,
    rw,
    rh,
    raw,
    temporal,
    moments,
    filtered,
    positions,
    normals,
    mask,
    connections,
    counts: {
      receivers,
      rawValid: valid,
      historyValid: history,
      lengthMean: length / Math.max(history, 1),
      peakE: peak,
      rawReasons: reasons,
      historyReasons,
    },
  };
}
export async function sampleComposite(lab, points) {
  const C = Cesium,
    w = lab.world,
    f = lab.scene.lumen.finalGather;
  if (
    !f.ready ||
    !f.reconstruction ||
    w.requestedRevision !== f.metrics.revision
  )
    throw Error("matching completed FG required");
  const [{ declarations, functions }, source] = await Promise.all([
    import("/cesium-1.146/packages/engine/Source/Scene/LumenFinalGatherGeometry.js"),
    fetch(
      "/cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.glsl",
    ).then((r) => r.text()),
  ]);
  let helper = source.slice(
    source.indexOf("#ifdef LUMEN_RECEIVER_COMPOSITE"),
    source.indexOf("vec3 lumen_irradiance"),
  );
  helper = helper.replace(
    /vec3 lumen_triangleNormal\(vec3 p\) \{[\s\S]*?\n\}/,
    "vec3 lumen_triangleNormal(vec3 p){return diagNg;}",
  );
  helper = helper.replaceAll(
    "czm_metersPerPixel(vec4(positionEC,1.0),1.0)",
    "diagMetersPerPixel",
  );
  helper = helper
    .replaceAll("gl_FragCoord.xy", "diagPixel")
    .replaceAll("floor(gl_FragCoord.xy)", "floor(diagPixel)");
  const [rw, rh] = f.metrics.receiverResolution,
    [width, height] = f.metrics.resolution;
  const P = w._read(f.receiver.framebuffer, rw, rh, 0),
    N = w._read(f.receiver.framebuffer, rw, rh, 1),
    owners = new Map();
  const A = await w.sample(points),
    localToEye = C.Matrix4.inverse(w.eyeToLocal, new C.Matrix4());
  const vp = C.Matrix4.multiply(
    lab.scene.camera.frustum.projectionMatrix,
    localToEye,
    new C.Matrix4(),
  );
  const data = new Float32Array(points.length * 12),
    metadata = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i],
      p = C.Cartesian3.fromArray(point.position),
      e = C.Matrix4.multiplyByPoint(localToEye, p, new C.Cartesian3());
    const ng = C.Cartesian3.normalize(
      C.Matrix4.multiplyByPointAsVector(
        localToEye,
        C.Cartesian3.fromArray(point.normal),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const clip = C.Matrix4.multiplyByVector(
      vp,
      new C.Cartesian4(p.x, p.y, p.z, 1),
      new C.Cartesian4(),
    );
    const pixel =
      clip.w > 0
        ? [
            ((clip.x / clip.w) * 0.5 + 0.5) * lab.scene.drawingBufferWidth,
            ((clip.y / clip.w) * 0.5 + 0.5) * lab.scene.drawingBufferHeight,
          ]
        : [-1000, -1000];
    const x = Math.floor((pixel[0] * rw) / lab.scene.drawingBufferWidth),
      y = Math.floor((pixel[1] * rh) / lab.scene.drawingBufferHeight);
    // Production supplies the physical primitive ID. An occluding low pixel
    // cannot name the canonical surface; recover its planar owner from guides.
    const key = [
      ...point.normal,
      point.normal.reduce((s, n, k) => s + n * point.position[k], 0),
    ]
      .map((v) => v.toFixed(5))
      .join(":");
    if (!owners.has(key)) {
      const counts = new Map();
      for (let j = 0; j < P.length; j += 4) {
        if (P[j + 3] < 0.5) continue;
        const alignment = point.normal.reduce((s, n, k) => s + n * N[j + k], 0);
        const plane = point.normal.reduce(
          (s, n, k) => s + n * (P[j + k] - point.position[k]),
          0,
        );
        if (alignment > 0.995 && Math.abs(plane) < 0.005)
          counts.set(P[j + 3], (counts.get(P[j + 3]) ?? 0) + 1);
      }
      owners.set(key, [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
    }
    const owner = owners.get(key);
    data.set(
      [
        e.x,
        e.y,
        e.z,
        owner,
        ng.x,
        ng.y,
        ng.z,
        pixel[0],
        ...A[i].irradiance,
        pixel[1],
      ],
      i * 12,
    );
    metadata.push({
      pixel,
      owner,
      ownerContract: "physical planar primitive from receiver guides",
      A: A[i],
    });
  }
  const input = w._texture(points.length * 3, 1, C.PixelDatatype.FLOAT, data);
  const outputs = [
    w._texture(points.length, 1),
    w._texture(points.length, 1),
    w._texture(points.length, 1),
  ];
  const fb = w._framebuffer(outputs);
  const code =
    "#define LUMEN_RECEIVER_COMPOSITE\n#define LUMEN_FG_REASONS\n#define LUMEN_FG_RECONSTRUCTION\nprecision highp float;precision highp sampler2D;vec2 diagPixel;vec3 diagNg;float diagMetersPerPixel;uniform vec2 u_diagUnitPixel;uniform bool u_diagOrthographic;uniform sampler2D u_diag;uniform bool u_lumenFgEnabled,u_lumenFgHistory;uniform float u_lumenWorldGain,u_lumenFgFallbackCode;float u_lumenFgSurfaceId;uniform mat4 u_lumenEyeToLocal;uniform vec2 u_lumenFgSceneSize,u_lumenReceiverSize,u_lumenFgSize,u_lumenFgOffset;uniform sampler2D u_lumenFgNeighborhood,u_lumenFgTexture,u_lumenFgFiltered,u_lumenReceiverPosition,u_lumenReceiverNormal;\n" +
    declarations +
    helper +
    functions +
    "\nlayout(location=0)out vec4 out_FragData_0;layout(location=1)out vec4 out_FragData_1;layout(location=2)out vec4 out_FragData_2;void main(){int i=int(gl_FragCoord.x)*3;vec4 p=texelFetch(u_diag,ivec2(i,0),0),n=texelFetch(u_diag,ivec2(i+1,0),0),a=texelFetch(u_diag,ivec2(i+2,0),0);diagPixel=vec2(n.a,a.a);diagNg=n.xyz;diagMetersPerPixel=max(u_diagUnitPixel.x,u_diagUnitPixel.y)*(u_diagOrthographic?1.0:-p.z);u_lumenFgSurfaceId=p.a;vec3 E=lumen_reconstructFg(p.xyz,n.xyz,a.rgb);out_FragData_0=vec4(E,lumen_fgWeight);out_FragData_1=vec4(lumen_rawFg,lumen_fgFallbackReason);out_FragData_2=vec4(lumen_filteredFg,1);}";
  const cmd = w.scene.context.createViewportQuadCommand(code, {
    uniformMap: {
      u_diag: () => input,
      u_diagUnitPixel: () =>
        lab.scene.camera.frustum.getPixelDimensions(
          lab.scene.drawingBufferWidth,
          lab.scene.drawingBufferHeight,
          1,
          1,
          new C.Cartesian2(),
        ),
      u_diagOrthographic: () =>
        lab.scene.camera.frustum.projectionMatrix[15] !== 0,
      u_lumenFgEnabled: () => true,
      u_lumenFgHistory: () => true,
      u_lumenWorldGain: () => w.gain,
      u_lumenFgFallbackCode: () => f.fallbackReason,
      u_lumenEyeToLocal: () => w.eyeToLocal,
      u_lumenFgSceneSize: () => f.sceneSize,
      u_lumenReceiverSize: () => f.receiverSize,
      u_lumenFgSize: () => f.resultSize,
      u_lumenFgOffset: () => f.offset,
      u_lumenFgNeighborhood: () => f.neighborhood.texture,
      u_lumenFgTexture: () => f.texture,
      u_lumenFgFiltered: () => f.reconstruction.texture,
      u_lumenReceiverPosition: () => f.receiver.position,
      u_lumenReceiverNormal: () => f.receiver.normal,
      u_lumenFgNodes: () => w._nodes,
      u_lumenFgVertices: () => w._vertices,
      u_lumenFgNodeCount: () => w.packet.bvh.nodes,
      u_lumenFgBarrierBudget: () => Math.min(f.traversalBudget, 256),
    },
  });
  try {
    w._commands.fgCompositeProbe = cmd;
    w._draw("fgCompositeProbe", fb, 0, 0, points.length, 1);
    const used = w._read(fb, points.length, 1, 0),
      raw = w._read(fb, points.length, 1, 1),
      filtered = w._read(fb, points.length, 1, 2);
    return points.map((point, i) => ({
      ...point,
      ...metadata[i],
      Eused: Array.from(used.slice(i * 4, i * 4 + 3)),
      weight: used[i * 4 + 3],
      raw: Array.from(raw.slice(i * 4, i * 4 + 3)),
      fallback: raw[i * 4 + 3],
      filtered: Array.from(filtered.slice(i * 4, i * 4 + 3)),
    }));
  } finally {
    delete w._commands.fgCompositeProbe;
    cmd.shaderProgram.destroy();
    w._freeTexture(input);
    w._freeTexture(outputs[0], fb);
    outputs.slice(1).forEach((t) => w._freeTexture(t));
  }
}
