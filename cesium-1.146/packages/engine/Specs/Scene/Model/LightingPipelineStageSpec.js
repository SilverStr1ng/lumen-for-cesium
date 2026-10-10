import { Cartesian3 } from "@cesium/core";
import {
  _shadersLightingStageFS,
  LightingModel,
  LightingPipelineStage,
  ModelLightingOptions,
  ShaderBuilder,
} from "../../../index.js";
import ShaderBuilderTester from "../../../../../Specs/ShaderBuilderTester.js";

describe("Scene/Model/LightingPipelineStage", function () {
  const mockPrimitive = {};
  const mockModel = {};

  const optionsUnlit = new ModelLightingOptions();
  optionsUnlit.lightingModel = LightingModel.UNLIT;

  it("supports light color", function () {
    const mockModelWithLightColor = {
      lightColor: new Cartesian3(1, 0, 0),
    };
    const shaderBuilder = new ShaderBuilder();
    const renderResources = {
      model: mockModelWithLightColor,
      shaderBuilder: shaderBuilder,
      lightingOptions: optionsUnlit,
      uniformMap: {},
    };
    LightingPipelineStage.process(renderResources, mockPrimitive);

    ShaderBuilderTester.expectHasVertexDefines(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "USE_CUSTOM_LIGHT_COLOR",
      "LIGHTING_UNLIT",
    ]);

    ShaderBuilderTester.expectHasVertexUniforms(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, [
      "uniform vec3 model_lightColorHdr;",
    ]);

    ShaderBuilderTester.expectFragmentLinesEqual(shaderBuilder, [
      _shadersLightingStageFS,
    ]);

    expect(renderResources.uniformMap.model_lightColorHdr).toBeDefined();
  });

  it("supports unlit lighting", function () {
    const shaderBuilder = new ShaderBuilder();
    const renderResources = {
      model: mockModel,
      shaderBuilder: shaderBuilder,
      lightingOptions: optionsUnlit,
    };
    LightingPipelineStage.process(renderResources, mockPrimitive);

    ShaderBuilderTester.expectHasVertexDefines(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "LIGHTING_UNLIT",
    ]);

    ShaderBuilderTester.expectHasVertexUniforms(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, []);

    ShaderBuilderTester.expectFragmentLinesEqual(shaderBuilder, [
      _shadersLightingStageFS,
    ]);
  });

  it("supports PBR lighting", function () {
    const optionsPbr = new ModelLightingOptions();
    optionsPbr.lightingModel = LightingModel.PBR;

    const shaderBuilder = new ShaderBuilder();
    const renderResources = {
      model: mockModel,
      shaderBuilder: shaderBuilder,
      lightingOptions: optionsPbr,
    };
    LightingPipelineStage.process(renderResources, mockPrimitive);

    ShaderBuilderTester.expectHasVertexDefines(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentDefines(shaderBuilder, [
      "LIGHTING_PBR",
    ]);

    ShaderBuilderTester.expectHasVertexUniforms(shaderBuilder, []);
    ShaderBuilderTester.expectHasFragmentUniforms(shaderBuilder, []);

    ShaderBuilderTester.expectFragmentLinesEqual(shaderBuilder, [
      _shadersLightingStageFS,
    ]);
  });

  it("exports supported opaque and alpha-mask PBR triangles with normals", function () {
    const options = new ModelLightingOptions();
    options.lightingModel = LightingModel.PBR;
    for (const alphaMode of ["OPAQUE", "MASK"]) {
      const shaderBuilder = new ShaderBuilder();
      shaderBuilder.addDefine("HAS_NORMALS");
      LightingPipelineStage.process(
        { model: {}, lightingOptions: options, shaderBuilder },
        { primitiveType: 4, material: { alphaMode } },
      );
      expect(shaderBuilder._fragmentShaderParts.defineLines).toContain(
        "LUMEN_MODEL_LIGHTING",
      );
    }
  });

  it("keeps unsupported material paths on the original lighting", function () {
    const options = new ModelLightingOptions();
    options.lightingModel = LightingModel.PBR;
    for (const unsupported of [
      "BLEND",
      "USE_CLEARCOAT",
      "USE_ANISOTROPY",
      "CUSTOM_SHADER",
      "NO_NORMALS",
    ]) {
      const shaderBuilder = new ShaderBuilder();
      if (unsupported !== "NO_NORMALS") {shaderBuilder.addDefine("HAS_NORMALS");}
      if (unsupported.startsWith("USE_")) {shaderBuilder.addDefine(unsupported);}
      LightingPipelineStage.process(
        {
          model: unsupported === "CUSTOM_SHADER" ? { customShader: {} } : {},
          lightingOptions: options,
          shaderBuilder,
        },
        {
          primitiveType: 4,
          material: { alphaMode: unsupported === "BLEND" ? "BLEND" : "OPAQUE" },
        },
      );
      expect(shaderBuilder._fragmentShaderParts.defineLines).not.toContain(
        "LUMEN_MODEL_LIGHTING",
      );
    }
  });
});
