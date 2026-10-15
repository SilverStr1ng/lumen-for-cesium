// Independent WebGL call observer. Logical texels/buffers, not driver VRAM.
export function installAllocationObserver() {
  const states = new WeakMap(),
    all = [];
  const identities = new WeakMap();
  let nextIdentity = 0;
  const state = (gl) => {
    if (!states.has(gl)) {
      const s = {
        unit: 0,
        bindings: new Map(),
        buffers: new Map(),
        sizes: new Map(),
        origins: new Map(),
        peak: 0,
        scopedPeak: 0,
        unknown: [],
      };
      states.set(gl, s);
      all.push(s);
    }
    return states.get(gl);
  };
  const bytes = (internal, format, type) => {
    const sized = {
      32856: 4,
      34836: 16,
      34842: 8,
      33326: 4,
      33328: 8,
      33330: 16,
      33321: 1,
      33323: 2,
      35907: 4,
      35905: 3,
      35056: 4,
      33189: 2,
      33190: 4,
      36013: 8,
    };
    if (sized[internal]) return sized[internal];
    if ([32819, 32820, 33635].includes(type)) return 2;
    if ([34042, 35899, 35902].includes(type)) return 4;
    const components = {
      6403: 1,
      6406: 1,
      6407: 3,
      6408: 4,
      6410: 2,
      33319: 2,
      6402: 1,
    }[format];
    const size = {
      5120: 1,
      5121: 1,
      5122: 2,
      5123: 2,
      5124: 4,
      5125: 4,
      5126: 4,
      5131: 2,
      36193: 2,
    }[type];
    return components && size ? components * size : undefined;
  };
  const total = (s) =>
    [...s.sizes.values()].reduce(
      (n, v) =>
        n +
        (typeof v === "number"
          ? v
          : [...v.values()].reduce((n, l) => n + l.bytes, 0)),
      0,
    );
  const wrap = (name, run) => {
    const p = WebGL2RenderingContext.prototype,
      original = p[name];
    p[name] = function (...a) {
      return run.call(this, original, state(this), a);
    };
  };
  const size = (v) =>
    typeof v === "number"
      ? v
      : v
        ? [...v.values()].reduce((n, l) => n + l.bytes, 0)
        : 0;
  const update = (s) => {
    s.peak = Math.max(s.peak, total(s));
    s.scopedPeak = Math.max(
      s.scopedPeak,
      [...s.sizes].reduce(
        (n, [h, v]) => n + (s.origins.get(h)?.additional ? size(v) : 0),
        0,
      ),
    );
  };
  for (const name of ["createTexture", "createBuffer"])
    wrap(name, function (f, s, a) {
      const r = f.apply(this, a),
        previous = Error.stackTraceLimit;
      if (!r) return r;
      identities.set(r, ++nextIdentity);
      Error.stackTraceLimit = 35;
      const stack = new Error().stack;
      Error.stackTraceLimit = previous;
      // Fixed baseline: native Scene targets/shadows/Globe/BRDF LUT/defaults.
      // Additional resources are classified by their actual allocation caller,
      // independently of the session inventory. Unlisted additional handles fail.
      const base =
        /BrdfLutGenerator|\.defaultTexture|\.defaultCubeMap|\.defaultNormalTexture/.test(
          stack,
        );
      s.origins.set(r, {
        additional:
          !base && /Lumen|Gltf|Model|DynamicEnvironmentMap/.test(stack),
        stack,
      });
      return r;
    });
  wrap("activeTexture", function (f, s, a) {
    s.unit = a[0] - this.TEXTURE0;
    return f.apply(this, a);
  });
  wrap("bindTexture", function (f, s, a) {
    s.bindings.set(`${s.unit}:${a[0]}`, a[1]);
    return f.apply(this, a);
  });
  wrap("texImage2D", function (f, s, a) {
    const result = f.apply(this, a),
      cube = a[0] >= 34069 && a[0] <= 34074,
      target = cube ? this.TEXTURE_CUBE_MAP : a[0],
      handle = s.bindings.get(`${s.unit}:${target}`);
    const full = a.length >= 9,
      w = full ? a[3] : a[5]?.width,
      h = full ? a[4] : a[5]?.height,
      bpp = bytes(a[2], a[full ? 6 : 3], a[full ? 7 : 4]);
    if (handle && w && h) {
      if (!bpp) {
        s.unknown.push(a.slice(0, 8));
        return result;
      }
      const levels = s.sizes.get(handle) ?? new Map();
      levels.set(`${a[0]}:${a[1]}`, {
        w,
        h,
        bytes: w * h * bpp,
        bpp,
        face: a[0],
      });
      s.sizes.set(handle, levels);
      update(s);
    }
    return result;
  });
  wrap("texStorage2D", function (f, s, a) {
    const r = f.apply(this, a),
      handle = s.bindings.get(`${s.unit}:${a[0]}`),
      bpp = bytes(a[2]);
    if (handle && bpp) {
      const levels = new Map();
      for (let l = 0; l < a[1]; l++)
        levels.set(`storage:${l}`, {
          w: Math.max(1, a[3] >> l),
          h: Math.max(1, a[4] >> l),
          bpp,
          bytes:
            Math.max(1, a[3] >> l) *
            Math.max(1, a[4] >> l) *
            bpp *
            (a[0] === this.TEXTURE_CUBE_MAP ? 6 : 1),
        });
      s.sizes.set(handle, levels);
      update(s);
    }
    return r;
  });
  wrap("generateMipmap", function (f, s, a) {
    const r = f.apply(this, a),
      handle = s.bindings.get(`${s.unit}:${a[0]}`),
      levels = s.sizes.get(handle);
    if (levels instanceof Map) {
      for (const [key, base] of [...levels])
        if (key.endsWith(":0")) {
          let w = base.w,
            h = base.h,
            l = 0;
          while (w > 1 || h > 1) {
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
            levels.set(`${base.face}:${++l}`, {
              w,
              h,
              bpp: base.bpp,
              bytes: w * h * base.bpp,
            });
          }
        }
      update(s);
    }
    return r;
  });
  wrap("deleteTexture", function (f, s, a) {
    s.sizes.delete(a[0]);
    s.origins.delete(a[0]);
    return f.apply(this, a);
  });
  wrap("bindBuffer", function (f, s, a) {
    s.buffers.set(a[0], a[1]);
    return f.apply(this, a);
  });
  wrap("bufferData", function (f, s, a) {
    const r = f.apply(this, a),
      handle = s.buffers.get(a[0]);
    if (handle) {
      const n =
        typeof a[1] === "number"
          ? a[1]
          : a[4] === undefined
            ? a[1]?.byteLength
            : (a[4] || a[1].length - (a[3] ?? 0)) * a[1].BYTES_PER_ELEMENT;
      s.sizes.set(handle, n ?? 0);
      update(s);
    }
    return r;
  });
  wrap("deleteBuffer", function (f, s, a) {
    s.sizes.delete(a[0]);
    s.origins.delete(a[0]);
    return f.apply(this, a);
  });
  window.glMemoryObserver = {
    snapshot(handles = []) {
      const unique = new Set(handles),
        known = new Map(all.flatMap((s) => [...s.sizes]));
      const unlisted = all.flatMap((s) =>
        [...s.sizes]
          .filter(([h]) => s.origins.get(h)?.additional && !unique.has(h))
          .map(([h, v]) => ({
            bytes: size(v),
            origin: s.origins.get(h).stack,
          })),
      );
      return {
        liveAllocationIds: [...known.keys()]
          .map((h) => identities.get(h))
          .sort((a, b) => a - b),
        allocationCount: unique.size,
        missing: [...unique].filter((h) => !known.has(h)).length,
        bytes: [...unique].reduce((n, h) => n + size(known.get(h)), 0),
        unlistedAdditional: unlisted,
        scopedPeakBytes: all.reduce((n, s) => n + s.scopedPeak, 0),
        allSceneBytes: all.reduce((n, s) => n + total(s), 0),
        allScenePeakBytes: all.reduce((n, s) => n + s.peak, 0),
        unknownFormats: all.flatMap((s) => s.unknown),
        scope:
          "Observed WebGL buffer/texel storage, including all mip levels; excludes driver overhead; independent caller classification retains unlisted GI/model/IBL allocations",
      };
    },
  };
}
