import {
  Color,
  PixelDatatype,
  OrthographicFrustum,
  OrthographicOffCenterFrustum,
  PerspectiveFrustum,
  PerspectiveOffCenterFrustum,
  WebGLConstants,
  clone,
  defined,
  destroyObject,
} from "@cesium/core";
import ContextLimits from "../Renderer/ContextLimits.js";

import ClearCommand from "../Renderer/ClearCommand.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import FramebufferManager from "../Renderer/FramebufferManager.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import SceneMode from "./SceneMode.js";

const scratchPerspectiveFrustum = new PerspectiveFrustum();
const scratchPerspectiveOffCenterFrustum = new PerspectiveOffCenterFrustum();
const scratchOrthographicFrustum = new OrthographicFrustum();
const scratchOrthographicOffCenterFrustum = new OrthographicOffCenterFrustum();

const outputDeclarationRegex =
  /layout\s*\(location\s*=\s*\d+\)\s*out\s+vec4\s+out_Frag(?:Color|Data_\d+)\s*;|\bout\s+vec4\s+out_Frag(?:Color|Data_\d+)\s*;/g;
const gBufferPasses = [Pass.GLOBE, Pass.CESIUM_3D_TILE, Pass.OPAQUE];

function createWorkingFrustum(camera) {
  const { frustum } = camera;
  if (defined(frustum.fov)) {
    return frustum.clone(scratchPerspectiveFrustum);
  }
  if (defined(frustum.infiniteProjectionMatrix)) {
    return frustum.clone(scratchPerspectiveOffCenterFrustum);
  }
  if (defined(frustum.width)) {
    return frustum.clone(scratchOrthographicFrustum);
  }
  return frustum.clone(scratchOrthographicOffCenterFrustum);
}

function getGBufferRenderState(gBuffer, renderState) {
  const cache = gBuffer._renderStateCache;
  const cachedState = cache[renderState.id];
  if (defined(cachedState)) {
    return cachedState;
  }

  const state = clone(RenderState.getState(renderState), true);
  state.blending.enabled = false;
  state.depthMask = true;
  state.colorMask = {
    red: true,
    green: true,
    blue: true,
    alpha: true,
  };

  const derivedState = RenderState.fromCache(state);
  cache[renderState.id] = derivedState;
  return derivedState;
}

function getGBufferShaderProgram(context, shaderProgram) {
  const keyword = "gBuffer";
  const { shaderCache } = context;
  const cachedShader = shaderCache.getDerivedShaderProgram(
    shaderProgram,
    keyword,
  );
  if (defined(cachedShader)) {
    return cachedShader;
  }

  const fragmentShaderSource = shaderProgram.fragmentShaderSource.clone();
  const auxiliaryOutputs = new Set();
  fragmentShaderSource.defines.push("LUMEN_GBUFFER");

  fragmentShaderSource.sources = fragmentShaderSource.sources.map(
    function (source) {
      let transformedSource = ShaderSource.replaceMain(
        source,
        "czm_gbuffer_main",
      );
      transformedSource = transformedSource.replace(outputDeclarationRegex, "");
      transformedSource = transformedSource.replace(
        /\bout_FragColor\b/g,
        "czm_gbufferColor",
      );
      transformedSource = transformedSource.replace(
        /\bout_FragData_0\b/g,
        "czm_gbufferColor",
      );
      transformedSource = transformedSource.replace(
        /\bout_FragData_(\d+)\b/g,
        function (match, index) {
          if (index !== "0") {
            auxiliaryOutputs.add(index);
            return `czm_gbufferUnused_${index}`;
          }
          return "czm_gbufferColor";
        },
      );
      return transformedSource;
    },
  );

  const auxiliaryDeclarations = [];
  auxiliaryOutputs.forEach(function (index) {
    auxiliaryDeclarations.push(`vec4 czm_gbufferUnused_${index};`);
  });

  const prelude = [];
  if (!context.webgl2) {
    prelude.push("#extension GL_OES_standard_derivatives : enable");
  }
  prelude.push("#define CESIUM_REDIRECTED_COLOR_OUTPUT");
  prelude.push("vec4 czm_gbufferColor = vec4(1.0);");
  prelude.push(...auxiliaryDeclarations);

  fragmentShaderSource.sources.unshift(`${prelude.join("\n")}\n`);
  fragmentShaderSource.sources.push(`
layout (location = 0) out vec4 out_FragData_0;
layout (location = 1) out vec4 out_FragData_1;
layout (location = 2) out vec4 out_FragData_2;
layout (location = 3) out vec4 out_FragData_3;
void main()
{
    // Preserve alpha masks, clipping, visibility and log-depth writes.
    czm_gbuffer_main();
    if (czm_gbufferColor.a == 0.0) discard;
    #ifdef LUMEN_MODEL_LIGHTING
    out_FragData_0 = lumen_albedo;
    out_FragData_1 = lumen_normalRoughness;
    out_FragData_2 = lumen_positionDepth;
    out_FragData_3 = lumen_emissive;
    #else
    // Unsupported opaque objects still occlude the supported inputs.
    out_FragData_0 = vec4(0.0);
    out_FragData_1 = vec4(0.0);
    out_FragData_2 = vec4(0.0);
    out_FragData_3 = vec4(0.0);
    #endif
}
`);

  return shaderCache.createDerivedShaderProgram(shaderProgram, keyword, {
    vertexShaderSource: shaderProgram.vertexShaderSource,
    fragmentShaderSource: fragmentShaderSource,
    attributeLocations: shaderProgram._attributeLocations,
  });
}

function selectSourceCommand(scene, command) {
  scene.updateDerivedCommands(command);

  let sourceCommand = command;
  let derivedCommands = sourceCommand.derivedCommands;

  if (
    scene.frameState.useLogDepth &&
    defined(derivedCommands) &&
    defined(derivedCommands.logDepth)
  ) {
    sourceCommand = derivedCommands.logDepth.command;
    derivedCommands = sourceCommand.derivedCommands;
  }

  if (scene._hdr && defined(derivedCommands) && defined(derivedCommands.hdr)) {
    sourceCommand = derivedCommands.hdr.command;
  }

  return sourceCommand;
}

function getGBufferCommand(gBuffer, scene, command) {
  if (!defined(command.shaderProgram) || !defined(command.renderState)) {
    return undefined;
  }

  const sourceCommand = selectSourceCommand(scene, command);
  let derivedCommands = sourceCommand.derivedCommands;
  if (!defined(derivedCommands)) {
    derivedCommands = {};
    sourceCommand.derivedCommands = derivedCommands;
  }

  let gBufferDerived = derivedCommands.gBuffer;
  if (!defined(gBufferDerived)) {
    gBufferDerived = {};
    derivedCommands.gBuffer = gBufferDerived;
  }

  const shader = gBufferDerived.command?.shaderProgram;
  const renderState = gBufferDerived.command?.renderState;

  gBufferDerived.command = DrawCommand.shallowClone(
    sourceCommand,
    gBufferDerived.command,
  );
  gBufferDerived.command.framebuffer = gBuffer.framebuffer;

  if (
    !defined(shader) ||
    gBufferDerived.shaderProgramId !== sourceCommand.shaderProgram.id
  ) {
    gBufferDerived.command.shaderProgram = getGBufferShaderProgram(
      scene.context,
      sourceCommand.shaderProgram,
    );
    gBufferDerived.shaderProgramId = sourceCommand.shaderProgram.id;
  } else {
    gBufferDerived.command.shaderProgram = shader;
  }

  if (
    !defined(renderState) ||
    gBufferDerived.renderStateId !== sourceCommand.renderState.id
  ) {
    gBufferDerived.command.renderState = getGBufferRenderState(
      gBuffer,
      sourceCommand.renderState,
    );
    gBufferDerived.renderStateId = sourceCommand.renderState.id;
  } else {
    gBufferDerived.command.renderState = renderState;
  }

  return gBufferDerived.command;
}

function executePass(gBuffer, scene, passState, frustumCommands, passId) {
  const { context } = scene;
  context.uniformState.updatePass(passId);

  const commands = frustumCommands.commands[passId];
  const commandCount = frustumCommands.indices[passId];
  for (let i = 0; i < commandCount; ++i) {
    const gBufferCommand = getGBufferCommand(gBuffer, scene, commands[i]);
    if (defined(gBufferCommand)) {
      gBufferCommand.execute(context, passState);
      gBuffer.drawCommands++;
    }
  }
}

function restoreFramebufferState(context, framebuffer) {
  const gl = context._gl;
  // A resize can destroy a framebuffer still referenced by the context cache.
  // Resolve-framebuffers will bind its new targets; never rebind the old handle.
  if (defined(framebuffer) && framebuffer.isDestroyed()) {
    framebuffer = undefined;
  }
  context._currentFramebuffer = framebuffer;

  if (defined(framebuffer)) {
    framebuffer._bind();
    if (context.drawBuffers) {
      context.glDrawBuffers(framebuffer._getActiveColorAttachments());
    }
    return;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (context.drawBuffers) {
    context.glDrawBuffers([WebGLConstants.BACK]);
  }
}

/**
 * Material GBuffer ported from SilverStr1ng/cesium bf2eaae.
 * Linear diffuse reflectance + validity; signed eye normal + roughness;
 * eye position + positive axial depth in metres; linear emissive + validity.
 * @alias GBuffer
 * @constructor
 */
function GBuffer() {
  this.enabled = false;
  this.maximumMemoryBytes = 256 * 1024 * 1024;
  this.memoryBytes = 0;
  this.status = "disabled";
  this.drawCommands = 0;
  this.frustums = 0;

  this._framebufferManager = new FramebufferManager({
    colorAttachmentsLength: 4,
    pixelDatatype: PixelDatatype.FLOAT,
    createColorAttachments: true,
    depthStencil: true,
    supportsDepthTexture: true,
    color: true,
  });

  this._framebuffer = undefined;
  this._albedoTexture = undefined;
  this._normalTexture = undefined;
  this._positionTexture = undefined;
  this._emissiveTexture = undefined;
  this._depthStencilTexture = undefined;
  this._renderStateCache = {};
  this._supported = undefined;
  this._frustumCommandsList = undefined;

  this._clearCommand = new ClearCommand({
    color: new Color(0.0, 0.0, 0.0, 0.0),
    depth: 1.0,
    stencil: 0,
    owner: this,
  });
}

Object.defineProperties(GBuffer.prototype, {
  framebuffer: {
    get: function () {
      return this._framebuffer;
    },
  },
  albedoTexture: {
    get: function () {
      return this._albedoTexture;
    },
  },
  normalTexture: {
    get: function () {
      return this._normalTexture;
    },
  },
  positionTexture: {
    get: function () {
      return this._positionTexture;
    },
  },
  emissiveTexture: {
    get: function () {
      return this._emissiveTexture;
    },
  },
  depthStencilTexture: {
    get: function () {
      return this._depthStencilTexture;
    },
  },
  supported: {
    get: function () {
      return this._supported;
    },
  },
});

GBuffer.prototype.update = function (context, viewport) {
  this._framebufferManager.update(context, viewport.width, viewport.height, 1);
  this._framebuffer = this._framebufferManager.framebuffer;
  this._albedoTexture = this._framebufferManager.getColorTexture(0);
  this._normalTexture = this._framebufferManager.getColorTexture(1);
  this._positionTexture = this._framebufferManager.getColorTexture(2);
  this._emissiveTexture = this._framebufferManager.getColorTexture(3);
  this._depthStencilTexture = this._framebufferManager.getDepthStencilTexture();
  this._clearCommand.framebuffer = this._framebuffer;
  this.memoryBytes = viewport.width * viewport.height * 68;
  if (this._validatedFramebuffer !== this._framebuffer) {
    const binding = context._currentFramebuffer;
    const status = this._framebufferManager.status;
    // Framebuffer.status bypasses Context's binding cache.
    restoreFramebufferState(context, binding);
    if (status !== WebGLConstants.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        "Lumen GBuffer floating-point framebuffer is incomplete.",
      );
    }
    this._validatedFramebuffer = this._framebuffer;
  }
};

GBuffer.prototype.capture = function (frustumCommandsList) {
  this._frustumCommandsList = defined(frustumCommandsList)
    ? frustumCommandsList.slice()
    : undefined;
};

GBuffer.prototype.execute = function (scene, passState) {
  this._supported =
    scene.context.webgl2 &&
    scene.context.colorBufferFloat &&
    ContextLimits.maximumColorAttachments >= 4 &&
    ContextLimits.maximumDrawBuffers >= 4;
  this.drawCommands = 0;
  this.frustums = 0;
  const bytes = passState.viewport.width * passState.viewport.height * 68;
  if (
    !this.enabled ||
    !this._supported ||
    scene.mode !== SceneMode.SCENE3D ||
    bytes > this.maximumMemoryBytes
  ) {
    this.status = !this.enabled
      ? "disabled"
      : !this._supported
        ? "unsupported"
        : scene.mode !== SceneMode.SCENE3D
          ? "3D only"
          : "memory budget exceeded";
    this._frustumCommandsList = undefined;
    this.release();
    return;
  }
  const { context, camera, frameState } = scene;
  const frustumCommandsList = this._frustumCommandsList ?? [];

  this.update(context, passState.viewport);

  const { uniformState } = context;
  const originalCameraHeight = camera.position.z;
  const originalFramebuffer = passState.framebuffer;
  const boundFramebuffer = context._currentFramebuffer;
  const originalBlending = passState.blendingEnabled;
  const originalScissor = passState.scissorTest;
  const originalPass = uniformState.pass;
  try {
    passState.framebuffer = this._framebuffer;
    passState.blendingEnabled = undefined;
    passState.scissorTest = undefined;

    this._clearCommand.execute(context, passState);

    uniformState.updateCamera(camera);

    const frustum = createWorkingFrustum(camera);
    frustum.near = camera.frustum.near;
    frustum.far = camera.frustum.far;

    const numFrustums = frustumCommandsList.length;
    this.frustums = numFrustums;
    for (let i = 0; i < numFrustums; ++i) {
      const index = numFrustums - i - 1;
      const frustumCommands = frustumCommandsList[index];

      if (scene.mode === SceneMode.SCENE2D) {
        camera.position.z = originalCameraHeight - frustumCommands.near + 1.0;
        frustum.far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
        frustum.near = 1.0;
        uniformState.update(frameState);
        uniformState.updateFrustum(frustum);
      } else {
        frustum.near =
          index !== 0
            ? frustumCommands.near * scene.opaqueFrustumNearOffset
            : frustumCommands.near;
        frustum.far = frustumCommands.far;
        uniformState.updateFrustum(frustum);
      }

      scene._depthClearCommand.execute(context, passState);
      if (context.stencilBuffer) {
        scene._stencilClearCommand.execute(context, passState);
      }

      for (let j = 0; j < gBufferPasses.length; ++j) {
        executePass(this, scene, passState, frustumCommands, gBufferPasses[j]);
      }
    }

    this.status = "ready";
  } finally {
    camera.position.z = originalCameraHeight;
    uniformState.update(frameState);
    uniformState.updatePass(originalPass);
    passState.framebuffer = originalFramebuffer;
    passState.blendingEnabled = originalBlending;
    passState.scissorTest = originalScissor;
    restoreFramebufferState(context, boundFramebuffer);
    this._frustumCommandsList = undefined;
  }
};

// The manager recreates its attachments on the next update after release.
GBuffer.prototype.release = function () {
  this._framebufferManager.destroy();
  this._framebuffer = this._albedoTexture = this._normalTexture = undefined;
  this._positionTexture =
    this._emissiveTexture =
    this._depthStencilTexture =
      undefined;
  this.memoryBytes = 0;
};

GBuffer.prototype.isDestroyed = function () {
  return false;
};

GBuffer.prototype.destroy = function () {
  this._framebufferManager =
    this._framebufferManager && this._framebufferManager.destroy();
  this._clearCommand = undefined;
  return destroyObject(this);
};

export default GBuffer;
