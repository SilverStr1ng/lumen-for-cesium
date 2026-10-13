import { Cartesian2, defined } from "@cesium/core";
const surfaceOwners = new WeakMap();
import ContextLimits from "../../Renderer/ContextLimits.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import { functions as fgGeometry } from "../LumenFinalGatherGeometry.js";
import LightingStageFS from "../../Shaders/Model/LightingStageFS.js";
import LightingModel from "./LightingModel.js";

/**
 * The lighting pipeline stage is responsible for taking a material and rendering
 * it with a lighting model such as physically based rendering (PBR) or unlit
 * shading
 *
 * @namespace LightingPipelineStage
 *
 * @private
 */
const LightingPipelineStage = {
  name: "LightingPipelineStage", // Helps with debugging
};

/**
 * Process a primitive. This modifies the following parts of the render
 * resources:
 * <ul>
 *   <li>modifies the shader to include the lighting stage</li>
 * </ul>
 * @param {PrimitiveRenderResources} renderResources The render resources for the primitive
 * @param {ModelComponents.Primitive} primitive The primitive to be rendered
 *
 * @private
 */
LightingPipelineStage.process = function (
  renderResources,
  primitive,
  frameState,
) {
  const { model, lightingOptions, shaderBuilder } = renderResources;

  if (defined(model.lightColor)) {
    shaderBuilder.addDefine(
      "USE_CUSTOM_LIGHT_COLOR",
      undefined,
      ShaderDestination.FRAGMENT,
    );

    shaderBuilder.addUniform(
      "vec3",
      "model_lightColorHdr",
      ShaderDestination.FRAGMENT,
    );

    const uniformMap = renderResources.uniformMap;
    uniformMap.model_lightColorHdr = function () {
      return model.lightColor;
    };
  }

  // The lighting model is always set by the material. However, custom shaders
  // can override this.
  const { lightingModel } = lightingOptions;

  // First adapter: opaque/alpha-mask standard triangle materials with normals.
  // Extensions requiring a different diffuse transport model stay on Cesium lighting.
  const defines = shaderBuilder._fragmentShaderParts.defineLines;
  if (
    lightingModel === LightingModel.PBR &&
    primitive.primitiveType === 4 &&
    defines.includes("HAS_NORMALS") &&
    !defines.includes("USE_CLEARCOAT") &&
    !defines.includes("USE_ANISOTROPY") &&
    !defined(model.customShader) &&
    primitive.material.alphaMode !== "BLEND"
  ) {
    shaderBuilder.addDefine(
      "LUMEN_MODEL_LIGHTING",
      undefined,
      ShaderDestination.FRAGMENT,
    );
    // World and explicit IBL samplers are already installed by the preceding
    // pipeline. Reserve seven FG samplers plus the automatic BRDF, global
    // environment cube and shadow samplers without counting World twice.
    const existingSamplers =
      shaderBuilder._fragmentShaderParts.uniformLines.filter((line) =>
        /uniform\s+sampler/.test(line),
      ).length;
    if (
      frameState?.context?.webgl2 &&
      ContextLimits.maximumTextureImageUnits >= 10 + existingSamplers
    ) {
      shaderBuilder.addDefine(
        "LUMEN_RECEIVER_COMPOSITE",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addDefine(
        "LUMEN_FG_REASONS",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addDefine(
        "LUMEN_FG_RECONSTRUCTION",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addFragmentLines(fgGeometry);
      let owners = surfaceOwners.get(model);
      if (!owners) {
        owners = { next: 1, map: new WeakMap() };
        surfaceOwners.set(model, owners);
      }
      const ownerKey = renderResources.runtimePrimitive ?? primitive;
      if (!owners.map.has(ownerKey)) {
        owners.map.set(ownerKey, owners.next++);
      }
      const id = owners.map.get(ownerKey),
        fg = () => frameState.lumen?.finalGather,
        source = () => {
          const world = frameState.lumen?.world;
          return world?.ready && !world.isDestroyed() ? world : undefined;
        };
      const uniforms = {
        u_lumenFgSurfaceId: ["float", () => id],
        u_lumenFgFallbackCode: ["float", () => fg()?.fallbackReason ?? 1],
        u_lumenReceiverSupported: [
          "bool",
          () => fg()?.supported(model, frameState) ?? false,
        ],
        u_lumenFgEnabled: [
          "bool",
          () => fg()?.enabledFor(model, frameState) ?? false,
        ],
        u_lumenFgRawMode: [
          "bool",
          () => fg()?.mode === "raw" && fg()?.enabledFor(model, frameState),
        ],
        u_lumenFgNodes: [
          "sampler2D",
          () => source()?._nodes ?? frameState.context.defaultTexture,
        ],
        u_lumenFgVertices: [
          "sampler2D",
          () => source()?._vertices ?? frameState.context.defaultTexture,
        ],
        u_lumenFgNodeCount: ["int", () => source()?.packet?.bvh?.nodes ?? 0],
        u_lumenFgBarrierBudget: [
          "int",
          () => Math.min(256, fg()?.traversalBudget ?? 256),
        ],
        u_lumenFgHistory: [
          "bool",
          () =>
            fg()?.sampling === "reconstructed" &&
            !!fg()?.reconstruction?.texture,
        ],
        u_lumenFgFiltered: [
          "sampler2D",
          () =>
            fg()?.reconstruction?.texture ?? frameState.context.defaultTexture,
        ],
        u_lumenFgTexture: [
          "sampler2D",
          () => fg()?.texture ?? frameState.context.defaultTexture,
        ],
        u_lumenFgNeighborhood: [
          "sampler2D",
          () =>
            fg()?.neighborhood?.texture ?? frameState.context.defaultTexture,
        ],
        u_lumenReceiverPosition: [
          "sampler2D",
          () => fg()?.receiver?.position ?? frameState.context.defaultTexture,
        ],
        u_lumenReceiverNormal: [
          "sampler2D",
          () => fg()?.receiver?.normal ?? frameState.context.defaultTexture,
        ],
        u_lumenReceiverSize: [
          "vec2",
          () => fg()?.receiverSize ?? Cartesian2.ONE,
        ],
        u_lumenFgSize: ["vec2", () => fg()?.resultSize ?? Cartesian2.ONE],
        u_lumenFgOffset: ["vec2", () => fg()?.offset ?? Cartesian2.ZERO],
        u_lumenFgSceneSize: ["vec2", () => fg()?.sceneSize ?? Cartesian2.ONE],
      };
      for (const [name, [type, value]] of Object.entries(uniforms)) {
        shaderBuilder.addUniform(type, name, ShaderDestination.FRAGMENT);
        renderResources.uniformMap[name] = value;
      }
    }
  }
  if (lightingModel === LightingModel.PBR) {
    shaderBuilder.addDefine(
      "LIGHTING_PBR",
      undefined,
      ShaderDestination.FRAGMENT,
    );
  } else {
    shaderBuilder.addDefine(
      "LIGHTING_UNLIT",
      undefined,
      ShaderDestination.FRAGMENT,
    );
  }

  shaderBuilder.addFragmentLines(LightingStageFS);
};

export default LightingPipelineStage;
