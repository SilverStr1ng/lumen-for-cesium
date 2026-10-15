import { defined, destroyObject } from "@cesium/core";
import ShaderProgram from "./ShaderProgram.js";
import ShaderSource from "./ShaderSource.js";

/**
 * @private
 */
function ShaderCache(context) {
  this._context = context;
  this._shaders = {};
  this._numberOfShaders = 0;
  this._shadersToRelease = {};
}

Object.defineProperties(ShaderCache.prototype, {
  numberOfShaders: {
    get: function () {
      return this._numberOfShaders;
    },
  },
});

/**
     * Returns a shader program from the cache, or creates and caches a new shader program,
     * given the GLSL vertex and fragment shader source and attribute locations.
     * <p>
     * The difference between this and {@link ShaderCache#getShaderProgram}, is this is used to
     * replace an existing reference to a shader program, which is passed as the first argument.
     * </p>
     *
     * @param {object} options Object with the following properties:
     * @param {ShaderProgram} [options.shaderProgram] The shader program that is being reassigned.
     * @param {string|ShaderSource} options.vertexShaderSource The GLSL source for the vertex shader.
     * @param {string|ShaderSource} options.fragmentShaderSource The GLSL source for the fragment shader.
     * @param {object} options.attributeLocations Indices for the attribute inputs to the vertex shader.

     * @returns {ShaderProgram} The cached or newly created shader program.
     *
     *
     * @example
     * this._shaderProgram = context.shaderCache.replaceShaderProgram({
     *     shaderProgram : this._shaderProgram,
     *     vertexShaderSource : vs,
     *     fragmentShaderSource : fs,
     *     attributeLocations : attributeLocations
     * });
     *
     * @see ShaderCache#getShaderProgram
     */
ShaderCache.prototype.replaceShaderProgram = function (options) {
  if (defined(options.shaderProgram)) {
    options.shaderProgram.destroy();
  }

  return this.getShaderProgram(options);
};

// A bounded session lease pins completed, actually requested programs in this
// existing cache across dataset replacement. Pending request-only programs keep
// normal ownership and are not pinned. No model/revision enters a cache key.
ShaderCache.prototype.beginPreparationLease = function () {
  if (this._preparationLease)
    throw Error("Shader preparation lease already owned");
  const entries = new Set();
  this._preparationLease = entries;
  return () => {
    if (this._preparationLease !== entries) return;
    this._preparationLease = undefined;
    if (!this.isDestroyed())
      for (const entry of entries)
        this.releaseShaderProgram(entry.shaderProgram);
    entries.clear();
  };
};

ShaderCache.prototype.retainPreparedProgram = function (shader) {
  const entries = this._preparationLease;
  let entry = shader._cachedShader;
  while (entry?.parent) entry = entry.parent;
  if (!entries || !entry || !entry.count || entries.has(entry)) return;
  if (entry.preparing?.size) return;
  if (entries.size >= 256) {
    this.preparationRetentionOverflow = true;
    return;
  }
  entries.add(entry);
  entry.count++;
  delete this._shadersToRelease[entry.keyword];
};

ShaderCache.prototype.beginProgramPreparation = function (shader) {
  let entry = shader._cachedShader;
  while (entry?.parent) entry = entry.parent;
  // A newly requested native child makes the family ineligible for retention.
  // Keep real Model references; release the cache-only pin until all pending
  // members have completed. Cancellation can now destroy an unowned family.
  if (entry && this._preparationLease?.delete(entry))
    this.releaseShaderProgram(entry.shaderProgram);
  if (entry) {
    (entry.preparing ??= new Set()).add(shader);
    shader._preparationFamily = entry;
  }
};

ShaderCache.prototype.finishProgramPreparation = function (shader) {
  shader._preparationFamily?.preparing.delete(shader);
  shader._preparationFamily = undefined;
};

function toSortedJson(dictionary) {
  const sortedKeys = Object.keys(dictionary).sort();
  return JSON.stringify(dictionary, sortedKeys);
}

/**
 * Returns a shader program from the cache, or creates and caches a new shader program,
 * given the GLSL vertex and fragment shader source and attribute locations.
 *
 * @param {object} options Object with the following properties:
 * @param {string|ShaderSource} options.vertexShaderSource The GLSL source for the vertex shader.
 * @param {string|ShaderSource} options.fragmentShaderSource The GLSL source for the fragment shader.
 * @param {object} options.attributeLocations Indices for the attribute inputs to the vertex shader.
 *
 * @returns {ShaderProgram} The cached or newly created shader program.
 */
ShaderCache.prototype.getShaderProgram = function (options) {
  // convert shaders which are provided as strings into ShaderSource objects
  // because ShaderSource handles all the automatic including of built-in functions, etc.

  let vertexShaderSource = options.vertexShaderSource;
  let fragmentShaderSource = options.fragmentShaderSource;
  const attributeLocations = options.attributeLocations;

  if (typeof vertexShaderSource === "string") {
    vertexShaderSource = new ShaderSource({
      sources: [vertexShaderSource],
    });
  }

  if (typeof fragmentShaderSource === "string") {
    fragmentShaderSource = new ShaderSource({
      sources: [fragmentShaderSource],
    });
  }

  // Since ShaderSource.createCombinedXxxShader() can be expensive, use a
  // simpler key for caching. This way, the function does not have to be called
  // for each cache lookup.
  const vertexShaderKey = vertexShaderSource.getCacheKey();
  const fragmentShaderKey = fragmentShaderSource.getCacheKey();
  // Sort the keys in the JSON to ensure a consistent order
  const attributeLocationKey = defined(attributeLocations)
    ? toSortedJson(attributeLocations)
    : "";
  const keyword = `${vertexShaderKey}:${fragmentShaderKey}:${attributeLocationKey}`;

  let cachedShader;
  if (defined(this._shaders[keyword])) {
    cachedShader = this._shaders[keyword];

    // No longer want to release this if it was previously released.
    delete this._shadersToRelease[keyword];
  } else {
    const context = this._context;

    const vertexShaderText =
      vertexShaderSource.createCombinedVertexShader(context);
    const fragmentShaderText =
      fragmentShaderSource.createCombinedFragmentShader(context);

    const shaderProgram = new ShaderProgram({
      gl: context._gl,
      context: context,
      asynchronousCompilation: options.asynchronousCompilation,
      logShaderCompilation: context.logShaderCompilation,
      debugShaders: context.debugShaders,
      vertexShaderSource: vertexShaderSource,
      vertexShaderText: vertexShaderText,
      fragmentShaderSource: fragmentShaderSource,
      fragmentShaderText: fragmentShaderText,
      attributeLocations: attributeLocations,
    });

    cachedShader = {
      cache: this,
      shaderProgram: shaderProgram,
      keyword: keyword,
      derivedKeywords: [],
      derivedPrograms: new Map(),
      count: 0,
    };

    // A shader can't be in more than one cache.
    shaderProgram._cachedShader = cachedShader;
    this._shaders[keyword] = cachedShader;
    ++this._numberOfShaders;
  }

  ++cachedShader.count;
  if (options.asynchronousCompilation)
    cachedShader.shaderProgram._prepareOptIn = true;
  return cachedShader.shaderProgram;
};

ShaderCache.prototype.replaceDerivedShaderProgram = function (
  shaderProgram,
  keyword,
  options,
) {
  const cachedShader = shaderProgram._cachedShader;
  const cachedDerivedShader = cachedShader.derivedPrograms.get(keyword);
  if (defined(cachedDerivedShader)) {
    destroyShader(this, cachedDerivedShader);
    cachedShader.derivedPrograms.delete(keyword);
    const index = cachedShader.derivedKeywords.indexOf(keyword);
    if (index > -1) {
      cachedShader.derivedKeywords.splice(index, 1);
    }
  }

  return this.createDerivedShaderProgram(shaderProgram, keyword, options);
};

ShaderCache.prototype.getDerivedShaderProgram = function (
  shaderProgram,
  keyword,
) {
  const cachedShader = shaderProgram._cachedShader;
  // A source cache key can contain many KiB. Do not concatenate/hash the whole
  // source family for every derived-command lookup in every rendering pass.
  const cachedDerivedShader = cachedShader.derivedPrograms.get(keyword);
  if (!defined(cachedDerivedShader)) {
    return undefined;
  }

  return cachedDerivedShader.shaderProgram;
};

ShaderCache.prototype.createDerivedShaderProgram = function (
  shaderProgram,
  keyword,
  options,
) {
  const cachedShader = shaderProgram._cachedShader;
  const derivedKeyword = keyword + cachedShader.keyword;

  let vertexShaderSource = options.vertexShaderSource;
  let fragmentShaderSource = options.fragmentShaderSource;
  const attributeLocations = options.attributeLocations;

  if (typeof vertexShaderSource === "string") {
    vertexShaderSource = new ShaderSource({
      sources: [vertexShaderSource],
    });
  }

  if (typeof fragmentShaderSource === "string") {
    fragmentShaderSource = new ShaderSource({
      sources: [fragmentShaderSource],
    });
  }

  // Cast/depth/pick retain alpha/clipping, but never consume forward irradiance.
  const depthOnly =
    shaderProgram._lumenDepthOnly ||
    ["depthOnly", "pick", "snap"].includes(keyword) ||
    keyword.startsWith("pickMetadata-") ||
    fragmentShaderSource.sources.some((source) =>
      /void (?:czm_shadow_cast_main|czm_non_pick_main|czm_pick_main|czm_non_snap_main)\b/.test(
        source,
      ),
    );
  if (depthOnly && shaderProgram._prepareOptIn) {
    fragmentShaderSource = fragmentShaderSource.clone();
    fragmentShaderSource.defines = fragmentShaderSource.defines.filter(
      (d) =>
        ![
          "LUMEN_RECEIVER_COMPOSITE",
          "LUMEN_FG_REASONS",
          "LUMEN_FG_RECONSTRUCTION",
          "LUMEN_DIAGNOSTICS",
        ].includes(d),
    );
  }

  const context = this._context;

  const vertexShaderText =
    vertexShaderSource.createCombinedVertexShader(context);
  const fragmentShaderText =
    fragmentShaderSource.createCombinedFragmentShader(context);

  const derivedShaderProgram = new ShaderProgram({
    gl: context._gl,
    context: context,
    asynchronousCompilation: shaderProgram._prepareOptIn,
    logShaderCompilation: context.logShaderCompilation,
    debugShaders: context.debugShaders,
    vertexShaderSource: vertexShaderSource,
    vertexShaderText: vertexShaderText,
    fragmentShaderSource: fragmentShaderSource,
    fragmentShaderText: fragmentShaderText,
    attributeLocations: attributeLocations,
  });

  derivedShaderProgram._lumenModelProgram = shaderProgram._lumenModelProgram;
  derivedShaderProgram._lumenDepthOnly = depthOnly;
  derivedShaderProgram._lumenFgProgram =
    !depthOnly &&
    !fragmentShaderSource.defines.includes("LUMEN_RECEIVER_PASS") &&
    fragmentShaderSource.defines.includes("LUMEN_RECEIVER_COMPOSITE");
  if (fragmentShaderSource.defines.includes("LUMEN_RECEIVER_PASS"))
    derivedShaderProgram._lumenModelProgram = false;
  if (shaderProgram._fallback && !depthOnly) {
    const base = fragmentShaderSource.clone();
    base.defines = base.defines.filter(
      (d) =>
        ![
          "LUMEN_RECEIVER_COMPOSITE",
          "LUMEN_FG_REASONS",
          "LUMEN_FG_RECONSTRUCTION",
        ].includes(d),
    );
    // Receiver outputs are not a forward fallback; they must wait for themselves.
    if (!base.defines.includes("LUMEN_RECEIVER_PASS")) {
      derivedShaderProgram._fallback = this.getShaderProgram({
        vertexShaderSource,
        fragmentShaderSource: base,
        attributeLocations,
        asynchronousCompilation: true,
      });
      derivedShaderProgram._fallback._lumenModelProgram = true;
    }
  }
  if (derivedShaderProgram._lumenModelProgram)
    context._trackLumenBaseShader(
      derivedShaderProgram._fallback ?? derivedShaderProgram,
    );

  const derivedCachedShader = {
    parent: cachedShader,
    cache: this,
    shaderProgram: derivedShaderProgram,
    keyword: derivedKeyword,
    derivedKeywords: [],
    derivedPrograms: new Map(),
    count: 0,
  };

  cachedShader.derivedKeywords.push(keyword);
  cachedShader.derivedPrograms.set(keyword, derivedCachedShader);
  derivedShaderProgram._cachedShader = derivedCachedShader;
  this._shaders[derivedKeyword] = derivedCachedShader;
  return derivedShaderProgram;
};

function destroyShader(cache, cachedShader) {
  for (const derivedCachedShader of cachedShader.derivedPrograms.values()) {
    destroyShader(cache, derivedCachedShader);
  }

  delete cache._shaders[cachedShader.keyword];
  cachedShader.shaderProgram.finalDestroy();
}

ShaderCache.prototype.destroyReleasedShaderPrograms = function () {
  const shadersToRelease = this._shadersToRelease;
  // Destruction may release a fallback. Retain that newly queued release for
  // the next frame instead of losing its final reference during this sweep.
  this._shadersToRelease = {};

  for (const keyword in shadersToRelease) {
    if (shadersToRelease.hasOwnProperty(keyword)) {
      const cachedShader = shadersToRelease[keyword];
      destroyShader(this, cachedShader);
      --this._numberOfShaders;
    }
  }
};

ShaderCache.prototype.releaseShaderProgram = function (shaderProgram) {
  if (defined(shaderProgram)) {
    const cachedShader = shaderProgram._cachedShader;
    if (cachedShader && --cachedShader.count === 0) {
      this._shadersToRelease[cachedShader.keyword] = cachedShader;
    }
  }
};

ShaderCache.prototype.isDestroyed = function () {
  return false;
};

ShaderCache.prototype.destroy = function () {
  const shaders = this._shaders;
  for (const keyword in shaders) {
    if (shaders.hasOwnProperty(keyword)) {
      shaders[keyword].shaderProgram.finalDestroy();
    }
  }
  return destroyObject(this);
};
export default ShaderCache;
