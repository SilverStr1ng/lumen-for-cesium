// One metre/z-up descriptor supplies display nodes, physics and frozen GI.
const palette = [
  [0.72, 0.28, 0.2],
  [0.17, 0.42, 0.66],
  [0.86, 0.69, 0.24],
  [0.24, 0.58, 0.43],
  [0.61, 0.39, 0.57],
  [0.79, 0.57, 0.38],
  [0.78, 0.79, 0.73],
  [0.36, 0.46, 0.61],
];
export function createBallPool({ count = 64, seed = 19, segments = 24 } = {}) {
  if (
    ![1, 2, 16, 64, 128].includes(count) ||
    !Number.isInteger(seed) ||
    ![16, 24, 48].includes(segments)
  )
    throw Error("Unsupported Ball Pool descriptor");
  let randomState = seed >>> 0;
  const random = () =>
    ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) +
      0.5) /
    4294967296;
  const balls = [],
    radius = 0.34,
    pitch = radius * 2,
    baseX = count <= 16 ? 4 : 8,
    baseY = count <= 16 ? 4 : count === 64 ? 6 : 8;
  for (let layer = 0; balls.length < count; layer++) {
    const nx = baseX - layer,
      ny = baseY - layer;
    for (let y = 0; y < ny && balls.length < count; y++)
      for (let x = 0; x < nx && balls.length < count; x++) {
        const id = balls.length + 1;
        balls.push({
          ballId: id,
          radius,
          position: [
            (x - (nx - 1) / 2) * pitch,
            (y - (ny - 1) / 2) * pitch,
            radius + layer * radius * Math.SQRT2 + 0.001,
          ],
          rotation: [0, 0, 0, 1],
          material: Math.floor(random() * palette.length) + 3,
        });
      }
  }
  if (count <= 2)
    balls.forEach((b, i) => {
      b.position = [(i - (count - 1) / 2) * (pitch + 0.002), 0, radius + 0.001];
    });
  // The dual-ball fixture deliberately shares its material and mesh. Surface
  // ownership must still distinguish both rigid bodies.
  if (count === 2) balls[1].material = balls[0].material;
  const materials = [
    { name: "Ivory pool", color: [0.73, 0.74, 0.69], roughness: 0.85 },
    { name: "Warm wall", color: [0.65, 0.23, 0.18], roughness: 0.9 },
    { name: "Cool wall", color: [0.18, 0.37, 0.59], roughness: 0.9 },
    ...palette.map((color, i) => ({
      name: `Ball finish ${i}`,
      color,
      roughness: 0.5 + i * 0.06,
    })),
  ];
  // One independently paintable ball permits an offscreen causal control;
  // the other balls still share topology and the small finish palette.
  if (count >= 16) {
    materials.push({
      ...materials[balls[0].material],
      name: "Causal ball finish",
    });
    balls[0].material = materials.length - 1;
  }
  return {
    version: 1,
    seed,
    segments,
    generation: 0,
    balls,
    materials,
    container: [
      { name: "floor", lo: [-4.3, -3.3, -0.3], hi: [4.3, 3.3, 0], material: 0 },
      { name: "west", lo: [-4.3, -3.3, 0], hi: [-4, 3.3, 1.6], material: 1 },
      { name: "east", lo: [4, -3.3, 0], hi: [4.3, 3.3, 1.6], material: 2 },
      { name: "north", lo: [-4, 3, 0], hi: [4, 3.3, 1.6], material: 0 },
      // Low observation wall retains thickness and physical collision.
      { name: "south", lo: [-4, -3.3, 0], hi: [4, -3, 0.25], material: 0 },
    ],
  };
}
function sphere(segments) {
  const p = [],
    n = [],
    idx = [],
    rings = segments / 2;
  for (let y = 0; y <= rings; y++)
    for (let x = 0; x <= segments; x++) {
      const phi = (x / segments) * Math.PI * 2,
        theta = (y / rings) * Math.PI,
        v = [
          Math.sin(theta) * Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
          Math.cos(theta),
        ];
      p.push(...v);
      n.push(...v);
    }
  for (let y = 0; y < rings; y++)
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x,
        b = a + segments + 1;
      if (y > 0) idx.push(a, b, a + 1);
      if (y < rings - 1) idx.push(a + 1, b, b + 1);
    }
  return { p, n, idx };
}
function box(lo, hi) {
  const p = [],
    n = [],
    idx = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        start = p.length / 3,
        points = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
      if (side < 0) points.reverse();
      for (const [s, t] of points) {
        const q = [0, 0, 0],
          normal = [0, 0, 0];
        q[axis] = side > 0 ? hi[axis] : lo[axis];
        q[u] = s ? hi[u] : lo[u];
        q[v] = t ? hi[v] : lo[v];
        normal[axis] = side;
        p.push(...q);
        n.push(...normal);
      }
      idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  return { p, n, idx };
}
const base64 = (data) =>
  typeof Buffer !== "undefined"
    ? Buffer.from(data).toString("base64")
    : btoa(
        Array.from(new Uint8Array(data), (x) => String.fromCharCode(x)).join(
          "",
        ),
      );
export function ballPoolGltf(descriptor) {
  const parts = [],
    views = [],
    accessors = [],
    meshes = [],
    nodes = [],
    topology = sphere(descriptor.segments);
  let offset = 0;
  const accessor = (values, type, componentType = 5126) => {
    const typed =
        componentType === 5126
          ? Float32Array.from(values)
          : Uint16Array.from(values),
      bytes = new Uint8Array(typed.buffer),
      padding = (4 - (offset % 4)) % 4;
    if (padding) {
      parts.push(new Uint8Array(padding));
      offset += padding;
    }
    const view = views.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    parts.push(bytes);
    offset += bytes.length;
    const count = type === "VEC3" ? values.length / 3 : values.length,
      a = { bufferView: view, componentType, count, type };
    if (type === "VEC3") {
      a.min = [0, 1, 2].map((k) =>
        Math.min(...values.filter((_, i) => i % 3 === k)),
      );
      a.max = [0, 1, 2].map((k) =>
        Math.max(...values.filter((_, i) => i % 3 === k)),
      );
    }
    accessors.push(a);
    return accessors.length - 1;
  };
  const primitive = (g, material, attributes) => ({
    attributes: attributes ?? {
      POSITION: accessor(g.p, "VEC3"),
      NORMAL: accessor(g.n, "VEC3"),
    },
    indices: accessor(g.idx, "SCALAR", 5123),
    material,
  });
  for (const c of descriptor.container) {
    const mesh = meshes.length;
    meshes.push({ primitives: [primitive(box(c.lo, c.hi), c.material)] });
    nodes.push({ name: `pool-${c.name}`, mesh });
  }
  const sphereAttributes = {
      POSITION: accessor(topology.p, "VEC3"),
      NORMAL: accessor(topology.n, "VEC3"),
    },
    sphereIndices = accessor(topology.idx, "SCALAR", 5123),
    sphereMeshes = new Map();
  for (const b of descriptor.balls) {
    if (!sphereMeshes.has(b.material)) {
      sphereMeshes.set(b.material, meshes.length);
      meshes.push({
        primitives: [
          {
            attributes: sphereAttributes,
            indices: sphereIndices,
            material: b.material,
          },
        ],
      });
    }
    nodes.push({
      name: `ball-${b.ballId}`,
      mesh: sphereMeshes.get(b.material),
      translation: b.position,
      rotation: b.rotation,
      scale: [b.radius, b.radius, b.radius],
      extras: { ballId: b.ballId },
    });
  }
  const data = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  const gltf = {
    asset: {
      version: "2.0",
      generator: "Lumen R9 shared Ball Pool descriptor",
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: descriptor.materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.color, 1],
        metallicFactor: 0,
        roughnessFactor: m.roughness,
      },
      extras: { giSolid: true },
    })),
    accessors,
    bufferViews: views,
    buffers: [
      {
        byteLength: data.byteLength,
        uri: `data:application/octet-stream;base64,${base64(data.buffer)}`,
      },
    ],
    extras: {
      geometryGeneration: descriptor.generation,
      seed: descriptor.seed,
      contract: "Ns cosine / Ng clipped receiver; triangle Ng Lambert hits",
    },
  };
  return {
    gltf,
    bufferBytes: data.byteLength,
    triangles:
      (topology.idx.length / 3) * descriptor.balls.length +
      descriptor.container.length * 12,
  };
}
