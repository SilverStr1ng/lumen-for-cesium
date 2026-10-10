import { Cartesian2, Cartesian3, Matrix3 } from "@cesium/core";
import {
  ImageBasedLighting,
  ImageBasedLightingPipelineStage,
  ShaderBuilder,
  _shadersImageBasedLightingStageFS,
  _shadersLumenStageFS,
} from "../../../index.js";
import ShaderBuilderTester from "../../../../../Specs/ShaderBuilderTester.js";

describe("Scene/Model/ImageBasedLightingPipelineStage", function () {
  const mockFrameState = {
    context: {
      floatingPointTexture: true,
      colorBufferFloat: true,
      supportsTextureLod: true,
    },
  };

  it("updates Lumen uniforms without rebuilding and disables them during picking", function () {
    const lumen = {
      enabled: false,
      coverage: 1,
      _irradiance: new Cartesian3(1, 2, 3),
      debugMode: 0,
    };
    const frameState = {
      ...mockFrameState,
      lumen,
      mode: 3,
      passes: { render: true },
    };
    const model = {
      imageBasedLighting: new ImageBasedLighting(),
      environmentMapManager: {},
    };
    const resources = {
      shaderBuilder: new ShaderBuilder(),
      uniformMap: {},
      model,
    };
    ImageBasedLightingPipelineStage.process(resources, model, frameState);
    const uniforms = resources.uniformMap;
    expect(uniforms.u_lumenEnabled()).toBe(false);
    lumen.enabled = true;
    expect(uniforms.u_lumenEnabled()).toBe(true);
    expect(uniforms.u_lumenIrradiance()).toEqual(new Cartesian3(1, 2, 3));
    lumen.coverage = 0.25;
    expect(uniforms.u_lumenCoverage()).toBe(0.25);
    frameState.passes.render = false;
    expect(uniforms.u_lumenEnabled()).toBe(false);
    frameState.passes.render = true;
    frameState.mode = 2;
    expect(uniforms.u_lumenEnabled()).toBe(false);
  });

  it("configures the render resources for default image-based lighting", function () {
    const imageBasedLighting = new ImageBasedLighting();
    const mockModel = {
      imageBasedLighting: imageBasedLighting,
      environmentMapManager: {},
      _iblReferenceFrameMatrix: Matrix3.clone(Matrix3.IDENTITY),
    };

    const renderResources = {
      shaderBuilder: new ShaderBuilder(),
      uniformMap: {},
      model: mockModel,
    };
    const shaderBuilder = renderResources.shaderBuilder;

    ImageBasedLightingPipelineStage.process(
      renderResources,
      mockModel,
      mockFrameState,
    );

    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "USE_IBL_LIGHTING",
    ]);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform bool u_lumenEnabled;",
      "uniform vec3 u_lumenIrradiance;",
      "uniform float u_lumenCoverage;",
      "uniform int u_lumenDebugMode;",
      "uniform bool u_lumenWorldEnabled;",
      "uniform bool u_lumenLinearAtlas;",
      "uniform sampler2D u_lumenProbeIrradiance;",
      "uniform sampler2D u_lumenProbeDistances;",
      "uniform sampler2D u_lumenProbePositions;",
      "uniform mat4 u_lumenEyeToLocal;",
      "uniform vec3 u_lumenProbeOrigin;",
      "uniform vec3 u_lumenProbeCounts;",
      "uniform float u_lumenProbeSpacing;",
      "uniform float u_lumenNormalBias;",
      "uniform float u_lumenWorldGain;",
      "uniform vec2 model_iblFactor;",
      "uniform mat3 model_iblReferenceFrameMatrix;",
    ]);

    ShaderBuilderTester.expectFragmentLinesEqual(shaderBuilder, [
      _shadersLumenStageFS,
      _shadersImageBasedLightingStageFS,
    ]);

    const uniformMap = renderResources.uniformMap;
    expect(
      Cartesian2.equals(
        uniformMap.model_iblFactor(),
        imageBasedLighting.imageBasedLightingFactor,
      ),
    ).toBe(true);

    expect(
      Matrix3.equals(
        uniformMap.model_iblReferenceFrameMatrix(),
        mockModel._iblReferenceFrameMatrix,
      ),
    ).toBe(true);
  });

  // These are dummy values, not meant to represent valid spherical harmonic coefficients.
  const testCoefficients = [
    new Cartesian3(1, 1, 1),
    new Cartesian3(2, 2, 2),
    new Cartesian3(3, 3, 3),
    new Cartesian3(4, 4, 4),
    new Cartesian3(5, 5, 5),
    new Cartesian3(6, 6, 6),
    new Cartesian3(7, 7, 7),
    new Cartesian3(8, 8, 8),
    new Cartesian3(9, 9, 9),
  ];

  it("configures the render resources for spherical harmonics", function () {
    const imageBasedLighting = new ImageBasedLighting({
      sphericalHarmonicCoefficients: testCoefficients,
    });

    const mockModel = {
      imageBasedLighting: imageBasedLighting,
      environmentMapManager: {},
      _iblReferenceFrameMatrix: Matrix3.clone(Matrix3.IDENTITY),
    };

    const renderResources = {
      shaderBuilder: new ShaderBuilder(),
      uniformMap: {},
      model: mockModel,
    };
    const shaderBuilder = renderResources.shaderBuilder;

    ImageBasedLightingPipelineStage.process(
      renderResources,
      mockModel,
      mockFrameState,
    );

    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "USE_IBL_LIGHTING",
      "DIFFUSE_IBL",
      "CUSTOM_SPHERICAL_HARMONICS",
    ]);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform bool u_lumenEnabled;",
      "uniform vec3 u_lumenIrradiance;",
      "uniform float u_lumenCoverage;",
      "uniform int u_lumenDebugMode;",
      "uniform bool u_lumenWorldEnabled;",
      "uniform bool u_lumenLinearAtlas;",
      "uniform sampler2D u_lumenProbeIrradiance;",
      "uniform sampler2D u_lumenProbeDistances;",
      "uniform sampler2D u_lumenProbePositions;",
      "uniform mat4 u_lumenEyeToLocal;",
      "uniform vec3 u_lumenProbeOrigin;",
      "uniform vec3 u_lumenProbeCounts;",
      "uniform float u_lumenProbeSpacing;",
      "uniform float u_lumenNormalBias;",
      "uniform float u_lumenWorldGain;",
      "uniform vec2 model_iblFactor;",
      "uniform mat3 model_iblReferenceFrameMatrix;",
      "uniform vec3 model_sphericalHarmonicCoefficients[9];",
    ]);

    const uniformMap = renderResources.uniformMap;
    expect(
      Cartesian2.equals(
        uniformMap.model_iblFactor(),
        imageBasedLighting.imageBasedLightingFactor,
      ),
    ).toBe(true);

    expect(
      Matrix3.equals(
        uniformMap.model_iblReferenceFrameMatrix(),
        mockModel._iblReferenceFrameMatrix,
      ),
    ).toBe(true);

    expect(uniformMap.model_sphericalHarmonicCoefficients()).toBe(
      testCoefficients,
    );
  });

  it("configures the render resources for specular environment maps", function () {
    const mockCubeMap = {
      texture: {
        dimensions: {},
      },
      maximumMipmapLevel: 0,
      ready: true,
    };
    const imageBasedLighting = new ImageBasedLighting({
      specularEnvironmentMaps: "example.ktx2",
    });
    imageBasedLighting._specularEnvironmentCubeMap = mockCubeMap;

    const mockModel = {
      imageBasedLighting: imageBasedLighting,
      environmentMapManager: {},
      _iblReferenceFrameMatrix: Matrix3.clone(Matrix3.IDENTITY),
    };

    const renderResources = {
      shaderBuilder: new ShaderBuilder(),
      uniformMap: {},
      model: mockModel,
    };
    const shaderBuilder = renderResources.shaderBuilder;

    ImageBasedLightingPipelineStage.process(
      renderResources,
      mockModel,
      mockFrameState,
    );

    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "USE_IBL_LIGHTING",
      "SPECULAR_IBL",
      "CUSTOM_SPECULAR_IBL",
    ]);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform bool u_lumenEnabled;",
      "uniform vec3 u_lumenIrradiance;",
      "uniform float u_lumenCoverage;",
      "uniform int u_lumenDebugMode;",
      "uniform bool u_lumenWorldEnabled;",
      "uniform bool u_lumenLinearAtlas;",
      "uniform sampler2D u_lumenProbeIrradiance;",
      "uniform sampler2D u_lumenProbeDistances;",
      "uniform sampler2D u_lumenProbePositions;",
      "uniform mat4 u_lumenEyeToLocal;",
      "uniform vec3 u_lumenProbeOrigin;",
      "uniform vec3 u_lumenProbeCounts;",
      "uniform float u_lumenProbeSpacing;",
      "uniform float u_lumenNormalBias;",
      "uniform float u_lumenWorldGain;",
      "uniform vec2 model_iblFactor;",
      "uniform mat3 model_iblReferenceFrameMatrix;",
      "uniform samplerCube model_specularEnvironmentMaps;",
      "uniform float model_specularEnvironmentMapsMaximumLOD;",
    ]);

    const uniformMap = renderResources.uniformMap;
    expect(
      Cartesian2.equals(
        uniformMap.model_iblFactor(),
        imageBasedLighting.imageBasedLightingFactor,
      ),
    ).toBe(true);

    expect(
      Matrix3.equals(
        uniformMap.model_iblReferenceFrameMatrix(),
        mockModel._iblReferenceFrameMatrix,
      ),
    ).toBe(true);

    expect(uniformMap.model_specularEnvironmentMaps()).toBeDefined();
    expect(uniformMap.model_specularEnvironmentMapsMaximumLOD()).toBeDefined();
  });
});
