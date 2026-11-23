import { OrbitCamera, worldToScreen } from './camera';
import { createBoxMesh, type PackedMesh } from './geometry';
import {
  MAIN_FS,
  MAIN_VS,
  LINE_FS,
  LINE_VS,
  PICK_FS,
  PICK_VS,
} from './shaders';
import { InstanceStore } from './store';
import type { DrawItem, PickNeighborCell, PickResult } from './types';
import {
  matFromTRS,
  matInvert,
  quatFromEulerDeg,
  transformPoint,
  type Mat4,
  type Vec3,
} from './math';

export const CHUNK_CAPACITY = 32; // 每次 drawElementsInstanced 最多 32 实例
const INITIAL_BUFFER_CAPACITY = 64;
const FLOATS_PER_INSTANCE = 21; // mat4(16) + color/sel(4) + pickId(1)

export interface RenderStats {
  drawnCount: number;
  instancedCalls: number;
  logicalBatches: number;
  bufferCapacity: number;
  reallocCount: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('shader 编译失败: ' + log);
  }
  return shader;
}

interface ProgramBundle {
  program: WebGLProgram;
  uViewProj: WebGLUniformLocation | null;
  uBaseInstance: WebGLUniformLocation | null;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): ProgramBundle {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('program 链接失败: ' + gl.getProgramInfoLog(program));
  }
  return {
    program,
    uViewProj: gl.getUniformLocation(program, 'uViewProj'),
    uBaseInstance: gl.getUniformLocation(program, 'uBaseInstance'),
  };
}

export class WebGL2Renderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private main: ProgramBundle;
  private line: ProgramBundle;
  private pickProg: ProgramBundle;
  private uCamPos: WebGLUniformLocation | null;
  private uLineColor: WebGLUniformLocation | null;
  private uFloatColor: WebGLUniformLocation | null;

  private mesh: PackedMesh;
  private meshVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private instanceBuffer: WebGLBuffer;
  private bufferCapacity = INITIAL_BUFFER_CAPACITY;
  private reallocCount = 0;

  private pickFbo: WebGLFramebuffer;
  private idTex: WebGLTexture;
  private posTex: WebGLTexture;
  private normalTex: WebGLTexture;
  private depthRB: WebGLRenderbuffer;
  private fboW = 0;
  private fboH = 0;
  private hasFloatColor: boolean;

  private width = 1;
  private height = 1;
  dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('当前环境不支持 WebGL2');
    this.gl = gl;

    this.hasFloatColor = !!gl.getExtension('EXT_color_buffer_float');
    this.main = link(gl, MAIN_VS, MAIN_FS);
    this.line = link(gl, LINE_VS, LINE_FS);
    this.pickProg = link(gl, PICK_VS, PICK_FS);
    this.uCamPos = gl.getUniformLocation(this.main.program, 'uCamPos');
    this.uLineColor = gl.getUniformLocation(this.line.program, 'uLineColor');
    this.uFloatColor = gl.getUniformLocation(
      this.pickProg.program,
      'uFloatColor',
    );

    this.mesh = createBoxMesh();
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.bufferCapacity * FLOATS_PER_INSTANCE * 4,
      gl.DYNAMIC_DRAW,
    );

    // 三角形 VAO 与线框 VAO 共享同一份实例缓冲
    this.meshVao = this.buildVao(this.mesh.triIndices);
    this.lineVao = this.buildVao(this.mesh.lineIndices);

    // 离屏点选 FBO
    this.pickFbo = gl.createFramebuffer()!;
    this.idTex = gl.createTexture()!;
    this.posTex = gl.createTexture()!;
    this.normalTex = gl.createTexture()!;
    this.depthRB = gl.createRenderbuffer()!;
    this.resizePickTargets(1, 1);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.055, 0.07, 0.1, 1);
  }

  private buildVao(indices: Uint16Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nrmBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // 实例属性：绑定共享 instanceBuffer，divisor = 1
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_INSTANCE * 4;
    const mat4Attrs: Array<[number, number]> = [
      [2, 0],
      [3, 4],
      [4, 8],
      [5, 12],
    ];
    for (const [loc, offsetFloats] of mat4Attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(
        loc,
        4,
        gl.FLOAT,
        false,
        stride,
        offsetFloats * 4,
      );
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, stride, 16 * 4);
    gl.vertexAttribDivisor(6, 1);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, 20 * 4);
    gl.vertexAttribDivisor(7, 1);

    gl.bindVertexArray(null);
    return vao;
  }

  /** backing store 按 DPR × CSS 尺寸分配，保证物理像素点选一致 */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.resizePickTargets(w, h);
    }
  }

  private resizePickTargets(w: number, h: number): void {
    const gl = this.gl;
    this.fboW = w;
    this.fboH = h;

    gl.bindTexture(gl.TEXTURE_2D, this.idTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    this.texParams();

    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    // RGBA32F + FLOAT 回读在各实现（含 SwiftShader）上最稳；
    // 无浮点扩展时降级 RGBA8，世界坐标在着色器里编码到 0~1
    const internal = this.hasFloatColor ? gl.RGBA32F : gl.RGBA8;
    const type = this.hasFloatColor ? gl.FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    this.texParams();

    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    this.texParams();

    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.idTex, 0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.posTex, 0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.normalTex, 0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRB,
    );
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
    ]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('点选 FBO 不完整: 0x' + status.toString(16));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private texParams(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** 把当前绘制列表打包进实例缓冲（容量不足时倍增重分配） */
  private uploadInstances(
    drawList: DrawItem[],
    store: InstanceStore,
    selectedId: number | null,
  ): void {
    const gl = this.gl;
    if (drawList.length > this.bufferCapacity) {
      while (this.bufferCapacity < drawList.length) {
        this.bufferCapacity *= 2;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.bufferCapacity * FLOATS_PER_INSTANCE * 4,
        gl.DYNAMIC_DRAW,
      );
      this.reallocCount++;
    }
    const data = new Float32Array(drawList.length * FLOATS_PER_INSTANCE);
    drawList.forEach((item, i) => {
      const inst = store.get(item.id)!;
      const model = matFromTRS(
        inst.position,
        quatFromEulerDeg(inst.rotationDeg),
        inst.scale,
      );
      const o = i * FLOATS_PER_INSTANCE;
      data.set(model, o);
      data[o + 16] = inst.color[0];
      data[o + 17] = inst.color[1];
      data[o + 18] = inst.color[2];
      data[o + 19] = item.id === selectedId ? 1 : 0;
      data[o + 20] = item.id;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  /**
   * 分块实例化绘制。
   * 每个分块把起始槽位写进 uBaseInstance，shader 用 uBaseInstance + gl_InstanceID
   * 手动索引实例属性，规避 WebGL2 baseInstance 在 ANGLE 下不可靠的问题。
   */
  private drawChunks(
    bundle: ProgramBundle,
    count: number,
    indexCount: number,
    mode: number,
  ): number {
    const gl = this.gl;
    let calls = 0;
    for (let start = 0; start < count; start += CHUNK_CAPACITY) {
      const n = Math.min(CHUNK_CAPACITY, count - start);
      gl.uniform1i(bundle.uBaseInstance, start);
      gl.drawElementsInstanced(mode, indexCount, gl.UNSIGNED_SHORT, 0, n);
      calls++;
    }
    return calls;
  }

  render(
    store: InstanceStore,
    drawList: DrawItem[],
    camera: OrbitCamera,
    selectedId: number | null,
  ): RenderStats {
    const gl = this.gl;
    this.uploadInstances(drawList, store, selectedId);
    const viewProj = camera.viewProj();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);

    // 主 pass：实体
    gl.useProgram(this.main.program);
    gl.uniformMatrix4fv(this.main.uViewProj, false, viewProj);
    gl.uniform3fv(this.uCamPos, camera.eye());
    gl.bindVertexArray(this.meshVao);
    const triCalls = this.drawChunks(
      this.main,
      drawList.length,
      this.mesh.triIndices.length,
      gl.TRIANGLES,
    );

    // 高亮 pass：选中实例单独画线框（随模型矩阵，镜像/非均匀缩放自然贴合）
    let lineCalls = 0;
    if (selectedId != null) {
      const slot = drawList.findIndex((d) => d.id === selectedId);
      if (slot >= 0) {
        gl.useProgram(this.line.program);
        gl.uniformMatrix4fv(this.line.uViewProj, false, viewProj);
        gl.uniform1i(this.line.uBaseInstance, slot);
        gl.uniform3f(this.uLineColor, 1.0, 0.82, 0.35);
        gl.bindVertexArray(this.lineVao);
        gl.drawElementsInstanced(
          gl.LINES,
          this.mesh.lineIndices.length,
          gl.UNSIGNED_SHORT,
          0,
          1,
        );
        lineCalls = 1;
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);

    const batchSet = new Set(drawList.map((d) => d.batchId));
    return {
      drawnCount: drawList.length,
      instancedCalls: triCalls + lineCalls,
      logicalBatches: batchSet.size,
      bufferCapacity: this.bufferCapacity,
      reallocCount: this.reallocCount,
    };
  }

  /**
   * 在离屏 FBO 重绘一帧并回读像素：
   * 深度缓冲保证返回最前面的可见实例（遮挡/互相穿过同样成立）。
   */
  pick(
    store: InstanceStore,
    drawList: DrawItem[],
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    withNeighborhood: boolean,
    frozen: boolean,
  ): PickResult {
    const gl = this.gl;
    this.uploadInstances(drawList, store, null);
    const viewProj = camera.viewProj();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE); // 镜像物体的内表面也要能被点中
    gl.useProgram(this.pickProg.program);
    gl.uniformMatrix4fv(this.pickProg.uViewProj, false, viewProj);
    gl.uniform1i(this.uFloatColor, this.hasFloatColor ? 1 : 0);
    gl.bindVertexArray(this.meshVao);
    for (let start = 0; start < drawList.length; start += CHUNK_CAPACITY) {
      const n = Math.min(CHUNK_CAPACITY, drawList.length - start);
      gl.uniform1i(this.pickProg.uBaseInstance, start);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        this.mesh.triIndices.length,
        gl.UNSIGNED_SHORT,
        0,
        n,
      );
    }

    const physX = this.clamp(
      Math.round(cssX * this.dpr),
      0,
      this.fboW - 1,
    );
    // WebGL 原点在左下，CSS 原点在左上
    const glY = this.clamp(
      this.fboH - 1 - Math.round(cssY * this.dpr),
      0,
      this.fboH - 1,
    );

    const center = this.readPickPixel(physX, glY, store);
    const neighborhood: PickNeighborCell[] = [];
    if (withNeighborhood) {
      for (let dy = 2; dy >= -2; dy--) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = this.clamp(physX + dx, 0, this.fboW - 1);
          const py = this.clamp(glY + dy, 0, this.fboH - 1);
          neighborhood.push({ dx, dy, id: this.readIdOnly(px, py) });
        }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.055, 0.07, 0.1, 1);
    gl.enable(gl.CULL_FACE);

    return {
      time: Date.now(),
      cssX,
      cssY,
      physX,
      physY: this.fboH - 1 - glY,
      hitId: center.id,
      face: center.face,
      world: center.world,
      local: center.local,
      depth: center.depth,
      neighborhood,
      frozen,
    };
  }

  private clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  private readIdOnly(x: number, y: number): number {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[0] * 65536 + px[1] * 256 + px[2];
  }

  private readPickPixel(
    x: number,
    y: number,
    store: InstanceStore,
  ): {
    id: number;
    face: string;
    world: [number, number, number] | null;
    local: [number, number, number] | null;
    depth: number;
  } {
    const gl = this.gl;
    const idPx = new Uint8Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, idPx);
    const id = idPx[0] * 65536 + idPx[1] * 256 + idPx[2];
    if (id === 0) {
      return { id: 0, face: '—', world: null, local: null, depth: 0 };
    }

    // 世界坐标 + 深度
    let world: Vec3;
    let depth: number;
    if (this.hasFloatColor) {
      const fp = new Float32Array(4);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, fp);
      world = [fp[0], fp[1], fp[2]];
      depth = fp[3];
    } else {
      const up = new Uint8Array(4);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, up);
      // 无浮点附件时的降级：世界坐标由着色器映射到 [0,1]，这里还原到 ±50
      world = [
        (up[0] / 255) * 100 - 50,
        (up[1] / 255) * 100 - 50,
        (up[2] / 255) * 100 - 50,
      ];
      depth = up[3] / 255;
    }

    // 局部法线 -> 命中面
    const nPx = new Uint8Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, nPx);
    const n: Vec3 = [
      (nPx[0] / 255) * 2 - 1,
      (nPx[1] / 255) * 2 - 1,
      (nPx[2] / 255) * 2 - 1,
    ];
    const face = this.normalToFace(n);

    // 局部命中点：用实例逆矩阵把世界点变换回局部空间（翻转/镜像后仍贴合）
    const inst = store.get(id);
    let local: [number, number, number] | null = null;
    if (inst) {
      const model: Mat4 = matFromTRS(
        inst.position,
        quatFromEulerDeg(inst.rotationDeg),
        inst.scale,
      );
      const inv = matInvert(model);
      const lp = transformPoint(inv, world);
      local = [lp[0], lp[1], lp[2]];
    }
    return {
      id,
      face,
      world: [world[0], world[1], world[2]],
      local,
      depth,
    };
  }

  private normalToFace(n: Vec3): string {
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    if (ax >= ay && ax >= az) return n[0] > 0 ? '+X' : '-X';
    if (ay >= ax && ay >= az) return n[1] > 0 ? '+Y' : '-Y';
    return n[2] > 0 ? '+Z' : '-Z';
  }

  /** 标签投影：世界点 -> CSS 像素（供 DOM 编号标签使用） */
  projectLabel(p: Vec3, camera: OrbitCamera): {
    x: number;
    y: number;
    visible: boolean;
  } {
    return worldToScreen(camera.viewProj(), p, this.width, this.height);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}
