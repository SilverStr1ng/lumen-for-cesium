import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(
  new URL("../cesium-1.146/package.json", import.meta.url),
);
export function sourceVersion(extraFiles = []) {
  const files = [
    "cesium-1.146/packages/engine/Source/Scene/LumenGpuWorld.js",
    "cesium-1.146/packages/engine/Source/Scene/LumenGpuShaders.js",
    "cesium-1.146/packages/engine/Source/Shaders/Model/LumenStageFS.glsl",
    "lumen/gpu-worker.js",
    "lumen/math.js",
    "lumen/gltf.js",
    ...extraFiles,
  ];
  const sha256 = (file) =>
    createHash("sha256")
      .update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"))
      .digest("hex");
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sources: Object.fromEntries(files.map((file) => [file, sha256(file)])),
    compiledBundle: sha256("cesium-1.146/Build/CesiumUnminified/Cesium.js"),
    modifiedSources: execFileSync(
      "git",
      ["diff", "--name-only", "--", ...files],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean),
  };
}
export function demoUrl(backend, extra = "") {
  const url = new URL(
    process.env.LUMEN_DEMO_URL ?? "http://localhost:8090/demo/index.html",
  );
  url.searchParams.set("backend", backend);
  if (process.env.LUMEN_ASSET_URL)
    url.searchParams.set("model", process.env.LUMEN_ASSET_URL);
  for (const [key, value] of new URLSearchParams(extra))
    url.searchParams.set(key, value);
  return url.href;
}
export async function launchBrowser() {
  const { chromium } = require("@playwright/test");
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "win32"
      ? path.join(homedir(), "AppData/Local/ms-playwright")
      : path.join(
          homedir(),
          process.platform === "darwin"
            ? "Library/Caches/ms-playwright"
            : ".cache/ms-playwright",
        ));
  const installed = existsSync(cache)
    ? readdirSync(cache)
        .filter((x) => /^chromium-\d+$/.test(x))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .flatMap((x) =>
          [
            "chrome-win64/chrome.exe",
            "chrome-win/chrome.exe",
            "chrome-linux/chrome",
            "chrome-linux64/chrome",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          ].map((p) => path.join(cache, x, p)),
        )
    : [];
  const executablePath = [
    process.env.CHROMIUM_PATH,
    chromium.executablePath(),
    ...installed,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((x) => x && existsSync(x));
  if (!executablePath)
    throw new Error(
      "Chromium missing: npm --prefix cesium-1.146 exec -- playwright install chromium",
    );
  return chromium.launch({
    executablePath,
    headless: process.env.LUMEN_HEADFUL !== "1",
  });
}

// Observes actual GL calls. It is installed before any context is created.
export function installGlObserver() {
  const states = new WeakMap(),
    all = [];
  const state = (gl) => {
    if (!states.has(gl)) {
      const s = {
        phase: "initialization",
        phases: {},
        drawFB: null,
        readFB: null,
        unit: 0,
        program: null,
        textures: new Map(),
        attachments: new Map(),
        uniforms: new Map(),
        locations: new WeakMap(),
        samplers: new Map(),
        feedback: [],
        errors: [],
        live: {
          textures: 0,
          framebuffers: 0,
          queries: 0,
          programs: 0,
          syncs: 0,
        },
        peak: {
          textures: 0,
          framebuffers: 0,
          queries: 0,
          programs: 0,
          syncs: 0,
        },
        elapsed: new Map(),
        labels: new Map(),
      };
      states.set(gl, s);
      all.push(s);
    }
    return states.get(gl);
  };
  const count = (s, name) => {
    const p = (s.phases[s.phase] ??= {});
    p[name] = (p[name] ?? 0) + 1;
  };
  const wrap = (name, callback) => {
    const proto = WebGL2RenderingContext.prototype,
      original = proto[name];
    if (!original) return;
    proto[name] = function (...args) {
      const s = state(this);
      return callback.call(this, original, s, args);
    };
  };
  for (const name of ["readPixels", "getBufferSubData", "finish", "waitSync"])
    wrap(name, function (original, s, a) {
      count(s, name);
      return original.apply(this, a);
    });
  wrap("clientWaitSync", function (original, s, a) {
    count(s, a[2] > 0 ? "blockingClientWaitSync" : "nonblockingClientWaitSync");
    return original.apply(this, a);
  });
  wrap("getError", function (original, s, a) {
    const e = original.apply(this, a);
    if (e) s.errors.push({ phase: s.phase, error: e });
    return e;
  });
  for (const [create, remove, key] of [
    ["createTexture", "deleteTexture", "textures"],
    ["createFramebuffer", "deleteFramebuffer", "framebuffers"],
    ["createQuery", "deleteQuery", "queries"],
    ["createProgram", "deleteProgram", "programs"],
    ["fenceSync", "deleteSync", "syncs"],
  ]) {
    const alive = new WeakSet();
    wrap(create, function (original, s, a) {
      const r = original.apply(this, a);
      if (r) {
        alive.add(r);
        s.live[key]++;
        s.peak[key] = Math.max(s.peak[key], s.live[key]);
      }
      return r;
    });
    wrap(remove, function (original, s, a) {
      if (a[0] && alive.delete(a[0])) s.live[key]--;
      return original.apply(this, a);
    });
  }
  wrap("bindFramebuffer", function (original, s, a) {
    if (a[0] === this.FRAMEBUFFER || a[0] === this.DRAW_FRAMEBUFFER)
      s.drawFB = a[1];
    if (a[0] === this.FRAMEBUFFER || a[0] === this.READ_FRAMEBUFFER)
      s.readFB = a[1];
    return original.apply(this, a);
  });
  wrap("framebufferTexture2D", function (original, s, a) {
    const fb = a[0] === this.READ_FRAMEBUFFER ? s.readFB : s.drawFB;
    const attachments = s.attachments.get(fb) ?? new Map();
    attachments.set(a[1], { texture: a[3], level: a[4] });
    s.attachments.set(fb, attachments);
    return original.apply(this, a);
  });
  wrap("activeTexture", function (original, s, a) {
    s.unit = a[0] - this.TEXTURE0;
    return original.apply(this, a);
  });
  wrap("bindTexture", function (original, s, a) {
    s.textures.set(`${s.unit}:${a[0]}`, a[1]);
    return original.apply(this, a);
  });
  wrap("useProgram", function (original, s, a) {
    s.program = a[0];
    return original.apply(this, a);
  });
  wrap("getActiveUniform", function (original, s, a) {
    const u = original.apply(this, a);
    if (
      u &&
      [
        this.SAMPLER_2D,
        this.SAMPLER_CUBE,
        this.INT_SAMPLER_2D,
        this.UNSIGNED_INT_SAMPLER_2D,
      ].includes(u.type)
    ) {
      const samplers = s.samplers.get(a[0]) ?? new Set();
      samplers.add(u.name);
      s.samplers.set(a[0], samplers);
    }
    return u;
  });
  wrap("getUniformLocation", function (original, s, a) {
    const r = original.apply(this, a);
    if (r) s.locations.set(r, { program: a[0], name: a[1] });
    return r;
  });
  wrap("uniform1i", function (original, s, a) {
    const l = s.locations.get(a[0]);
    if (l) {
      const uniforms = s.uniforms.get(l.program) ?? new Map();
      uniforms.set(l.name, a[1]);
      s.uniforms.set(l.program, uniforms);
    }
    return original.apply(this, a);
  });
  for (const name of [
    "drawArrays",
    "drawElements",
    "drawArraysInstanced",
    "drawElementsInstanced",
  ])
    wrap(name, function (original, s, a) {
      count(s, "draws");
      if (s.labels.has(s.program)) count(s, `draws:${s.labels.get(s.program)}`);
      const attachments = s.attachments.get(s.drawFB),
        uniforms = s.uniforms.get(s.program);
      if (attachments)
        for (const sampler of s.samplers.get(s.program) ?? []) {
          const unit = uniforms?.get(sampler) ?? 0,
            texture = s.textures.get(`${unit}:${this.TEXTURE_2D}`);
          if (
            texture &&
            [...attachments.values()].some(
              (x) => x.texture === texture && x.level === 0,
            )
          ) {
            if (s.feedback.length < 20)
              s.feedback.push({ phase: s.phase, sampler, unit });
          }
        }
      return original.apply(this, a);
    });
  wrap("beginQuery", function (original, s, a) {
    if (s.elapsed.has(a[0])) count(s, "queryCollisions");
    s.elapsed.set(a[0], a[1]);
    return original.apply(this, a);
  });
  wrap("endQuery", function (original, s, a) {
    s.elapsed.delete(a[0]);
    return original.apply(this, a);
  });
  window.glObserver = {
    labelProgram(program, label) {
      for (const s of all) s.labels.set(program, label);
    },
    phase(name) {
      for (const s of all) s.phase = name;
    },
    snapshot() {
      return all.map((s) => ({
        phase: s.phase,
        phases: structuredClone(s.phases),
        feedback: structuredClone(s.feedback),
        errors: structuredClone(s.errors),
        live: { ...s.live },
        peak: { ...s.peak },
      }));
    },
  };
}

export async function environment(page, browser) {
  return {
    browser: browser.version(),
    headless: process.env.LUMEN_HEADFUL !== "1",
    ...(await page.evaluate(() => {
      const scene = (window.lumenTest ?? window.lumenDemo ?? window.earthLab).scene,
        gl = scene.context._gl,
        extension = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        renderer: extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        vendor: extension
          ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
        visibility: document.visibilityState,
        resolution: [scene.drawingBufferWidth, scene.drawingBufferHeight],
        shadowSize: scene.shadowMap.size,
        webgl: gl.getParameter(gl.VERSION),
        userAgent: navigator.userAgent,
      };
    })),
  };
}
