import {
  Cartesian3,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  BoundingRectangle,
  Color,
} from "@cesium/core";
import Texture from "../Renderer/Texture.js";
import Framebuffer from "../Renderer/Framebuffer.js";
import PassState from "../Renderer/PassState.js";
import RenderState from "../Renderer/RenderState.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import Sampler from "../Renderer/Sampler.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import { restoreFramebufferState } from "./GBuffer.js";
import destroyLumenResource from "./destroyLumenResource.js";
import {
  temporal,
  connections,
  spatial,
} from "./LumenFinalGatherReconstructionShaders.js";
const nearest = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
});
/** Owns linear E, moments and static local guides. It cannot access a solver atlas. @private */
class LumenFinalGatherReconstruction {
  constructor(controller) {
    this.controller = controller;
    this.context = controller.scene.context;
    this._textures = [];
    this._framebuffers = [];
    this._commands = {};
    this._previousVP = new Matrix4();
    this._previousEye = new Cartesian3();
    this._previousDirection = new Cartesian3();
    this._valid = false;
    this._index = 0;
    this.memoryBytes = 0;
    this.frames = 0;
    this.targetFrames = 32;
    this.filtered = true;
  }
  static estimate(width, height) {
    return width * height * 100;
  }
  _texture(width, height, datatype) {
    const t = new Texture({
      context: this.context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: datatype,
      sampler: nearest,
      flipY: false,
    });
    this._textures.push(t);
    return t;
  }
  update(width, height) {
    if (this.width === width && this.height === height) {
      return;
    }
    this.release();
    this.width = width;
    this.height = height;
    const binding = this.context._currentFramebuffer;
    try {
      this.history = [0, 1].map(() => {
        const e = this._texture(width, height, PixelDatatype.HALF_FLOAT),
          m = this._texture(width, height, PixelDatatype.HALF_FLOAT),
          p = this._texture(width, height, PixelDatatype.FLOAT),
          n = this._texture(width, height, PixelDatatype.HALF_FLOAT);
        const framebuffer = new Framebuffer({
          context: this.context,
          colorTextures: [e, m, p, n],
          destroyAttachments: false,
        });
        this._framebuffers.push(framebuffer);
        if (framebuffer.status !== this.context._gl.FRAMEBUFFER_COMPLETE) {
          throw Error("FG history framebuffer incomplete");
        }
        new ClearCommand({ color: Color.TRANSPARENT, framebuffer }).execute(
          this.context,
        );
        return { e, m, p, n, framebuffer };
      });

      this.connections = this._texture(
        width,
        height,
        PixelDatatype.UNSIGNED_BYTE,
      );
      this.connectionFramebuffer = new Framebuffer({
        context: this.context,
        colorTextures: [this.connections],
        destroyAttachments: false,
      });
      this._framebuffers.push(this.connectionFramebuffer);
      this.filterTargets = [0, 1].map(() => {
        const texture = this._texture(width, height, PixelDatatype.HALF_FLOAT);
        const framebuffer = new Framebuffer({
          context: this.context,
          colorTextures: [texture],
          destroyAttachments: false,
        });
        this._framebuffers.push(framebuffer);
        return { texture, framebuffer };
      });
      for (const f of this._framebuffers) {
        if (f.status !== this.context._gl.FRAMEBUFFER_COMPLETE) {
          throw Error("FG reconstruction framebuffer incomplete");
        }
      }
      this.memoryBytes = LumenFinalGatherReconstruction.estimate(width, height);
    } catch (e) {
      this.release();
      throw e;
    } finally {
      restoreFramebufferState(this.context, binding);
    }
  }
  invalidate(reason) {
    this._valid = false;
    this.frames = 0;
    this.reason = reason;
    this._lastEpoch = undefined;
  }
  execute({
    key,
    raw,
    receiver,
    neighborhood,
    vp,
    localToEye,
    epoch,
    eye,
    direction,
  }) {
    if (key !== this._key) {
      this.invalidate("source/round/sampling epoch");
      this._key = key;
    }
    if (
      this._valid &&
      (Cartesian3.distance(eye, this._previousEye) > 2.0 ||
        Cartesian3.dot(direction, this._previousDirection) < 0.707)
    ) {
      this.invalidate("camera cut");
    }
    this._state = {
      raw,
      receiver,
      neighborhood,
      localToEye,
      newInformation: epoch !== this._lastEpoch,
    };
    if (!this._commands.temporal) {
      const uniforms = {
        u_lumenFgNodes: () => this.controller._inputUniforms.u_nodes(),
        u_lumenFgVertices: () => this.controller._inputUniforms.u_vertices(),
        u_lumenFgNodeCount: () => this.controller._inputUniforms.u_nodesCount(),
        u_lumenFgBarrierBudget: () =>
          Math.min(256, this.controller.traversalBudget),
        u_rRaw: () => this._state.raw,
        u_rPosition: () => this._state.receiver.position,
        u_rNormal: () => this._state.receiver.normal,
        u_rNeighborhood: () => this._state.neighborhood,
        u_rHistoryE: () => this.history[this._index].e,
        u_rHistoryM: () => this.history[this._index].m,
        u_rHistoryP: () => this.history[this._index].p,
        u_rHistoryN: () => this.history[this._index].n,
        u_rPreviousVP: () => this._previousVP,
        u_rLocalToEye: () => this._state.localToEye,
        u_rOffset: () => this.controller.offset,
        u_rHistoryValid: () => this._valid,
        u_rNewInformation: () => this._state.newInformation,
        u_rMaxFrames: () => this.targetFrames,
      };

      this._commands.connections = this.context.createViewportQuadCommand(
        connections,
        { uniformMap: uniforms, owner: this },
      );
      const filterUniforms = {
        ...uniforms,
        u_rInput: () => this._filterInput,
        u_rMoments: () => this.moments,
        u_rConnections: () => this.connections,
        u_rStep: () => this._step,
      };
      this._commands.spatial = this.context.createViewportQuadCommand(spatial, {
        uniformMap: filterUniforms,
        owner: this,
      });
      this._commands.temporal = this.context.createViewportQuadCommand(
        temporal,
        { uniformMap: uniforms, owner: this },
      );
    }
    this.controller._measure("connections", () =>
      this._draw(this._commands.connections, this.connectionFramebuffer),
    );
    const next = 1 - this._index;
    this.controller._measure("temporal", () =>
      this._draw(this._commands.temporal, this.history[next].framebuffer),
    );
    this._index = next;
    this.texture = this.history[next].e;
    this.moments = this.history[next].m;
    this._filterInput = this.texture;
    for (let i = 0; i < 2; i++) {
      this._step = i + 1;
      this.controller._measure(`filter${  this._step}`, () =>
        this._draw(this._commands.spatial, this.filterTargets[i].framebuffer),
      );
      this._filterInput = this.filterTargets[i].texture;
    }
    this.texture = this._filterInput;
    if (this._state.newInformation) {
      this.frames++;
    }
    this._lastEpoch = epoch;
    this._valid = true;
    Matrix4.clone(vp, this._previousVP);
    Cartesian3.clone(eye, this._previousEye);
    Cartesian3.clone(direction, this._previousDirection);
    return this.texture;
  }
  _draw(command, framebuffer) {
    command.framebuffer = framebuffer;
    command.renderState = RenderState.fromCache({
      viewport: new BoundingRectangle(0, 0, this.width, this.height),
    });
    const pass = new PassState(this.context);
    pass.framebuffer = framebuffer;
    pass.viewport = new BoundingRectangle(0, 0, this.width, this.height);
    command.execute(this.context, pass);
    this.controller.metrics.draws++;
  }
  release() {
    this.texture = this.moments = undefined;
    this.width = this.height = undefined;
    this.history = undefined;
    this._state = undefined;
    this.connections =
      this.connectionFramebuffer =
      this.filterTargets =
        undefined;
    for (const f of this._framebuffers) {
      if (!f.isDestroyed()) {
        f.destroy();
      }
    }
    for (const t of this._textures) {
      if (!t.isDestroyed()) {
        t.destroy();
      }
    }
    for (const c of Object.values(this._commands)) {
      if (!c.shaderProgram.isDestroyed()) {
        c.shaderProgram.destroy();
      }
    }
    this._textures = [];
    this._framebuffers = [];
    this._commands = {};
    this.memoryBytes = 0;
    this.invalidate("resources released");
  }
  isDestroyed() {
    return this._destroyed === true;
  }
  destroy() {
    if (this.isDestroyed()) {
      return;
    }
    this.release();
    this._destroyed = true;
    this.controller = this.context = undefined;
    return destroyLumenResource(this);
  }
}
export default LumenFinalGatherReconstruction;
