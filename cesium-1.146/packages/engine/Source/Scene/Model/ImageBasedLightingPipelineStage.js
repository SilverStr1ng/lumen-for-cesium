import {
  Cartesian2,
  Cartesian3,
  Matrix4,
  combine,
  defined,
} from "@cesium/core";
import ImageBasedLightingStageFS from "../../Shaders/Model/ImageBasedLightingStageFS.js";
import LumenStageFS from "../../Shaders/Model/LumenStageFS.js";
import ShaderDestination from "../../Renderer/ShaderDestination.js";
import SpecularEnvironmentCubeMap from "../SpecularEnvironmentCubeMap.js";

const ImageBasedLightingPipelineStage = {
  name: "ImageBasedLightingPipelineStage", // Helps with debugging
};

const scratchCartesian = new Cartesian2();

/**
 * Add shader code, uniforms, and defines related to image based lighting
 * @param {ModelRenderResources} renderResources
 * @param {Model} model
 * @param {FrameState} frameState
 * @private
 */
ImageBasedLightingPipelineStage.process = function (
  renderResources,
  model,
  frameState,
) {
  const imageBasedLighting = model.imageBasedLighting;
  const environmentMapManager = model.environmentMapManager;
  const shaderBuilder = renderResources.shaderBuilder;
  // Uniforms are present even while disabled, so toggling requires no model rebuild.
  shaderBuilder.addUniform(
    "bool",
    "u_lumenEnabled",
    ShaderDestination.FRAGMENT,
  );
  shaderBuilder.addUniform(
    "vec3",
    "u_lumenIrradiance",
    ShaderDestination.FRAGMENT,
  );
  shaderBuilder.addUniform(
    "float",
    "u_lumenCoverage",
    ShaderDestination.FRAGMENT,
  );
  shaderBuilder.addUniform(
    "int",
    "u_lumenDebugMode",
    ShaderDestination.FRAGMENT,
  );
  const lumen = frameState.lumen;
  const lumenUniformMap = renderResources.uniformMap;
  lumenUniformMap.u_lumenEnabled = () =>
    Boolean(
      lumen?.enabled && frameState.passes.render && frameState.mode === 3,
    );
  lumenUniformMap.u_lumenIrradiance = () =>
    lumen?.world ? Cartesian3.ZERO : (lumen?._irradiance ?? Cartesian3.ZERO);
  lumenUniformMap.u_lumenCoverage = () =>
    lumen?.world && !lumen.world.ready ? 0 : (lumen?.coverage ?? 0);
  lumenUniformMap.u_lumenDebugMode = () => lumen?.debugMode ?? 0;
  if (frameState.context?.webgl2) {
    shaderBuilder.addDefine(
      "LUMEN_WORLD_SUPPORTED",
      undefined,
      ShaderDestination.FRAGMENT,
    );
  }
  const worldUniforms = {
    u_lumenWorldEnabled: ["bool", () => Boolean(lumen?.world?.ready)],
    u_lumenLinearAtlas: ["bool", () => Boolean(lumen?.world?.linearAtlas)],
    u_lumenProbeIrradiance: [
      "sampler2D",
      () =>
        lumen?.world?.irradianceTexture ?? frameState.context.defaultTexture,
    ],
    u_lumenProbeDistances: [
      "sampler2D",
      () => lumen?.world?.distanceTexture ?? frameState.context.defaultTexture,
    ],
    u_lumenProbePositions: [
      "sampler2D",
      () => lumen?.world?.positionTexture ?? frameState.context.defaultTexture,
    ],
    u_lumenEyeToLocal: [
      "mat4",
      () => lumen?.world?.eyeToLocal ?? Matrix4.IDENTITY,
    ],
    u_lumenProbeOrigin: ["vec3", () => lumen?.world?.origin ?? Cartesian3.ZERO],
    u_lumenProbeCounts: ["vec3", () => lumen?.world?.counts ?? Cartesian3.ZERO],
    u_lumenProbeSpacing: ["float", () => lumen?.world?.spacing ?? 1],
    u_lumenNormalBias: ["float", () => lumen?.world?.normalBias ?? 0],
    u_lumenWorldGain: ["float", () => lumen?.world?.gain ?? 1],
  };
  for (const [name, [type, value]] of Object.entries(worldUniforms)) {
    shaderBuilder.addUniform(type, name, ShaderDestination.FRAGMENT);
    lumenUniformMap[name] = value;
  }
  shaderBuilder.addFragmentLines(LumenStageFS);

  // If environment maps or spherical harmonics are not specifically provided, use procedural lighting.
  let specularEnvironmentMapAtlas;
  if (!defined(imageBasedLighting.specularEnvironmentMaps)) {
    specularEnvironmentMapAtlas = environmentMapManager.radianceCubeMap;
  }
  const sphericalHarmonicCoefficients =
    imageBasedLighting.sphericalHarmonicCoefficients ??
    environmentMapManager.sphericalHarmonicCoefficients;

  shaderBuilder.addDefine(
    "USE_IBL_LIGHTING",
    undefined,
    ShaderDestination.FRAGMENT,
  );
  shaderBuilder.addUniform(
    "vec2",
    "model_iblFactor",
    ShaderDestination.FRAGMENT,
  );

  if (SpecularEnvironmentCubeMap.isSupported(frameState.context)) {
    const addMatrix =
      imageBasedLighting.useSphericalHarmonics ||
      imageBasedLighting.useSpecularEnvironmentMaps ||
      imageBasedLighting.enabled;
    if (addMatrix) {
      shaderBuilder.addUniform(
        "mat3",
        "model_iblReferenceFrameMatrix",
        ShaderDestination.FRAGMENT,
      );
    }

    if (defined(specularEnvironmentMapAtlas)) {
      shaderBuilder.addDefine(
        "COMPUTE_POSITION_WC_ATMOSPHERE",
        undefined,
        ShaderDestination.BOTH,
      );
    }

    if (
      defined(sphericalHarmonicCoefficients) &&
      defined(sphericalHarmonicCoefficients[0])
    ) {
      shaderBuilder.addDefine(
        "DIFFUSE_IBL",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addDefine(
        "CUSTOM_SPHERICAL_HARMONICS",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addUniform(
        "vec3",
        "model_sphericalHarmonicCoefficients[9]",
        ShaderDestination.FRAGMENT,
      );
    } else if (imageBasedLighting.useDefaultSphericalHarmonics) {
      shaderBuilder.addDefine(
        "DIFFUSE_IBL",
        undefined,
        ShaderDestination.FRAGMENT,
      );
    }

    if (
      (defined(imageBasedLighting.specularEnvironmentCubeMap) &&
        imageBasedLighting.specularEnvironmentCubeMap.ready) ||
      defined(specularEnvironmentMapAtlas)
    ) {
      shaderBuilder.addDefine(
        "SPECULAR_IBL",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addDefine(
        "CUSTOM_SPECULAR_IBL",
        undefined,
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addUniform(
        "samplerCube",
        "model_specularEnvironmentMaps",
        ShaderDestination.FRAGMENT,
      );
      shaderBuilder.addUniform(
        "float",
        "model_specularEnvironmentMapsMaximumLOD",
        ShaderDestination.FRAGMENT,
      );
    } else if (model.useDefaultSpecularMaps) {
      shaderBuilder.addDefine(
        "SPECULAR_IBL",
        undefined,
        ShaderDestination.FRAGMENT,
      );
    }
  }

  shaderBuilder.addFragmentLines(ImageBasedLightingStageFS);

  const uniformMap = {
    model_iblFactor: function () {
      return Cartesian2.multiplyByScalar(
        imageBasedLighting.imageBasedLightingFactor,
        environmentMapManager?.intensity || 1.0,
        scratchCartesian,
      );
    },
    model_iblReferenceFrameMatrix: function () {
      return model._iblReferenceFrameMatrix;
    },
    model_sphericalHarmonicCoefficients: function () {
      return sphericalHarmonicCoefficients;
    },
    model_specularEnvironmentMaps: function () {
      return imageBasedLighting.specularEnvironmentCubeMap.texture;
    },
    model_specularEnvironmentMapsMaximumLOD: function () {
      return imageBasedLighting.specularEnvironmentCubeMap.maximumMipmapLevel;
    },
  };

  if (defined(specularEnvironmentMapAtlas)) {
    uniformMap.model_specularEnvironmentMaps = function () {
      return specularEnvironmentMapAtlas;
    };
    uniformMap.model_specularEnvironmentMapsMaximumLOD = function () {
      return environmentMapManager.maximumMipmapLevel;
    };
  }

  renderResources.uniformMap = combine(uniformMap, renderResources.uniformMap);
};

export default ImageBasedLightingPipelineStage;
