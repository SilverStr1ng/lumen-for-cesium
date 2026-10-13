// Actual GL allocation observer; estimates exclude driver padding and swapchain.
export function installGpuAllocationObserver() {
  const glp = WebGL2RenderingContext.prototype,
    T = new Map(),
    R = new Map(),
    B = new Map(),
    bufferBindings = new Map(),
    bindings = new Map();
  let unit = 0,
    rb = null;
  const wrap = (name, callback) => {
    const original = glp[name];
    glp[name] = function (...a) {
      const result = original.apply(this, a);
      callback(this, a, result);
      return result;
    };
  };
  const size = (f, t) => {
    const internal = {
      34836: 16,
      34842: 8,
      32856: 4,
      6408: 4,
      6407: 3,
      33321: 1,
      33323: 2,
      33325: 2,
      33327: 4,
      33326: 4,
      33328: 8,
      33189: 2,
      33190: 3,
      36012: 4,
      35056: 4,
      36013: 8,
    };
    if (internal[f]) return internal[f];
    return 4;
  };
  wrap("activeTexture", (g, a) => (unit = a[0] - g.TEXTURE0));
  wrap("bindTexture", (g, a) => bindings.set(unit + ":" + a[0], a[1]));
  const texture = (g, target) =>
    bindings.get(
      unit +
        ":" +
        (target >= 34069 && target <= 34074 ? g.TEXTURE_CUBE_MAP : target),
    );
  const alloc = (t, key, bytes) => {
    if (!t) return;
    const map = T.get(t) ?? new Map();
    map.set(key, bytes);
    T.set(t, map);
  };
  wrap("texImage2D", (g, a) => {
    const image = a.length < 9 ? a.at(-1) : null,
      w = image?.width ?? image?.videoWidth ?? a[3],
      h = image?.height ?? image?.videoHeight ?? a[4];
    const type = a.length < 9 ? a[4] : a[7];
    const bpp =
      a[2] === 6408 || a[2] === 6407
        ? (a[2] === 6408 ? 4 : 3) * (type === 5126 ? 4 : type === 5131 ? 2 : 1)
        : size(a[2], type);
    alloc(texture(g, a[0]), a[0] + ":" + a[1], w * h * bpp);
  });
  wrap("texStorage2D", (g, a) => {
    for (let l = 0; l < a[1]; l++)
      alloc(
        texture(g, a[0]),
        "storage:" + l,
        Math.max(1, a[3] >> l) *
          Math.max(1, a[4] >> l) *
          size(a[2]) *
          (a[0] === g.TEXTURE_CUBE_MAP ? 6 : 1),
      );
  });
  wrap("compressedTexImage2D", (g, a) =>
    alloc(texture(g, a[0]), a[0] + ":" + a[1], a[6]?.byteLength ?? a[6] ?? 0),
  );
  wrap("generateMipmap", (g, a) => {
    const t = texture(g, a[0]),
      m = T.get(t);
    if (m) {
      const base = [...m]
        .filter(([k]) => k.endsWith(":0"))
        .reduce((s, [k, v]) => s + v, 0);
      alloc(t, "generatedMips", base / 3);
    }
  });
  wrap("deleteTexture", (g, a) => T.delete(a[0]));
  wrap("bindRenderbuffer", (g, a) => (rb = a[1]));
  wrap("renderbufferStorage", (g, a) => R.set(rb, a[2] * a[3] * size(a[1])));
  wrap("renderbufferStorageMultisample", (g, a) =>
    R.set(rb, a[1] * a[3] * a[4] * size(a[2])),
  );
  wrap("deleteRenderbuffer", (g, a) => R.delete(a[0]));
  wrap("bindBuffer", (g, a) => bufferBindings.set(a[0], a[1]));
  wrap("bufferData", (g, a) => {
    const buffer = bufferBindings.get(a[0]);
    if (buffer)
      B.set(buffer, typeof a[1] === "number" ? a[1] : (a[1]?.byteLength ?? 0));
  });
  wrap("deleteBuffer", (g, a) => B.delete(a[0]));
  window.gpuAllocationEstimate = () => ({
    textureBytes: [...T.values()].reduce(
      (s, m) => s + [...m.values()].reduce((a, b) => a + b, 0),
      0,
    ),
    renderbufferBytes: [...R.values()].reduce((a, b) => a + b, 0),
    bufferBytes: [...B.values()].reduce((a, b) => a + b, 0),
    buffers: B.size,
    textures: T.size,
    renderbuffers: R.size,
    scope:
      "tracked GL texture/renderbuffer allocation estimate including Globe, HDR, shadows, IBL, MSAA and GI; excludes driver padding, browser canvas swapchain ; tracks geometry/other GL buffers when allocated through bufferData",
  });
}
