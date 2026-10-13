import { Color, PixelDatatype, BoundingRectangle, defined } from "@cesium/core";
import FramebufferManager from "../Renderer/FramebufferManager.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import Pass from "../Renderer/Pass.js";
import {
  createWorkingFrustum,
  getGBufferRenderState,
  selectSourceCommand,
  restoreFramebufferState,
} from "./GBuffer.js";
const output =
  /layout\s*\(location\s*=\s*\d+\)\s*out\s+vec4\s+out_Frag(?:Color|Data_\d+)\s*;|\bout\s+vec4\s+out_Frag(?:Color|Data_\d+)\s*;/g;
/** Two float attachments: local surface P+ownership, true triangle Ng+ownership.
 * Normals which differ from Ns are unsupported. Replays only prepared opaque
 * commands; no second Scene update/render lifecycle. @private */
class LumenReceiverPass {
  constructor() {
    this.manager = new FramebufferManager({
      colorAttachmentsLength: 2,
      pixelDatatype: PixelDatatype.FLOAT,
      createColorAttachments: true,
      depthStencil: true,
      supportsDepthTexture: true,
      color: true,
    });
    this._renderStateCache = {};
    this.clear = new ClearCommand({
      color: Color.TRANSPARENT,
      depth: 1,
      stencil: 0,
    });
  }
  update(context, width, height) {
    this.manager.update(context, width, height, 1);
    this.framebuffer = this.manager.framebuffer;
    this.position = this.manager.getColorTexture(0);
    this.normal = this.manager.getColorTexture(1);
  }
  command(scene, command) {
    if (!command.shaderProgram || !command.renderState) return;
    const source = selectSourceCommand(scene, command),
      context = scene.context,
      cache = context.shaderCache,
      key = "lumenReceiver";
    let shader = cache.getDerivedShaderProgram(source.shaderProgram, key);
    if (!shader) {
      const fs = source.shaderProgram.fragmentShaderSource.clone();
      fs.defines.push("LUMEN_RECEIVER_PASS");
      fs.sources = fs.sources.map((s) =>
        ShaderSource.replaceMain(s, "czm_receiver_main")
          .replace(output, "")
          .replace(/\bout_FragColor\b|\bout_FragData_0\b/g, "czm_receiverColor")
          .replace(/\bout_FragData_[1-9]\b/g, "czm_receiverUnused"),
      );
      fs.sources.unshift(
        "#define CESIUM_REDIRECTED_COLOR_OUTPUT\nvec4 czm_receiverColor=vec4(1);vec4 czm_receiverUnused=vec4(0);vec4 lumen_receiverPosition=vec4(0);vec4 lumen_receiverNormal=vec4(0);\n",
      );
      fs.sources.push(
        "layout(location=0)out vec4 out_FragData_0;layout(location=1)out vec4 out_FragData_1;void main(){czm_receiver_main();if(czm_receiverColor.a==0.0)discard;out_FragData_0=lumen_receiverPosition;out_FragData_1=lumen_receiverNormal;}",
      );
      shader = cache.createDerivedShaderProgram(source.shaderProgram, key, {
        vertexShaderSource: source.shaderProgram.vertexShaderSource,
        fragmentShaderSource: fs,
        attributeLocations: source.shaderProgram._attributeLocations,
      });
    }
    source.derivedCommands ??= {};
    const derived =
      source.derivedCommands.lumenReceiver ??
      (source.derivedCommands.lumenReceiver = {});
    const draw = DrawCommand.shallowClone(source, derived.command);
    derived.command = draw;
    draw.shaderProgram = shader;
    draw.framebuffer = this.framebuffer;
    draw.renderState = getGBufferRenderState(this, source.renderState);
    return draw;
  }
  execute(scene, passState, list, width, height) {
    const context = scene.context,
      state = context.uniformState,
      oldFramebuffer = passState.framebuffer,
      binding = context._currentFramebuffer,
      oldViewport = passState.viewport,
      oldPass = state.pass,
      oldBlend = passState.blendingEnabled,
      oldScissor = passState.scissorTest;
    this.update(context, width, height);
    this.clear.framebuffer = this.framebuffer;
    let draws = 0;
    try {
      passState.framebuffer = this.framebuffer;
      passState.viewport = new BoundingRectangle(0, 0, width, height);
      passState.blendingEnabled = undefined;
      passState.scissorTest = undefined;
      this.clear.execute(context, passState);
      state.updateCamera(scene.camera);
      const frustum = createWorkingFrustum(scene.camera);
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i];
        frustum.near = i ? f.near * scene.opaqueFrustumNearOffset : f.near;
        frustum.far = f.far;
        state.updateFrustum(frustum);
        scene._depthClearCommand.execute(context, passState);
        if (context.stencilBuffer)
          scene._stencilClearCommand.execute(context, passState);
        for (const pass of [Pass.GLOBE, Pass.CESIUM_3D_TILE, Pass.OPAQUE]) {
          state.updatePass(pass);
          for (let j = 0; j < f.indices[pass]; j++) {
            const draw = this.command(scene, f.commands[pass][j]);
            if (draw) {
              draw.execute(context, passState);
              draws++;
            }
          }
        }
      }
    } finally {
      state.update(scene.frameState);
      state.updatePass(oldPass);
      passState.framebuffer = oldFramebuffer;
      passState.viewport = oldViewport;
      passState.blendingEnabled = oldBlend;
      passState.scissorTest = oldScissor;
      restoreFramebufferState(context, binding);
    }
    return draws;
  }
  release() {
    this.manager.destroy();
    this.position = this.normal = this.framebuffer = undefined;
  }
  destroy() {
    this.release();
  }
}
export default LumenReceiverPass;
