import { terrainFrag, terrainVert, lineFrag, lineVert } from "./shaders";
import { buildChunkMesh, type ChunkMeshData } from "./mesher";
import type { TerrainModel } from "../core/TerrainModel";
import type { OrbitCamera } from "./camera";
import type { Vec3 } from "../core/math";

interface ChunkGpu {
  cx: number;
  cy: number;
  solidVao: WebGLVertexArrayObject;
  indexCount: number;
  wireVao: WebGLVertexArrayObject;
  wireIndexCount: number;
  borderVao: WebGLVertexArrayObject;
  borderCount: number;
  buffers: WebGLBuffer[];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("着色器编译失败: " + log);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("着色器链接失败: " + gl.getProgramInfoLog(program));
  }
  return program;
}

/**
 * WebGL2 渲染器：管理区块 VAO、地形/线框两套 program、笔刷环动态网格。
 * 区块网格全部由同一份合成高度场构建，边界顶点共享 => 无裂缝。
 */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private terrainProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private chunks = new Map<string, ChunkGpu>();
  private brushVao: WebGLVertexArrayObject;
  private brushBuffer: WebGLBuffer;
  private brushPointCount = 0;

  showWireframe = false;
  showBorders = true;
  showBrush = true;
  private lightDir: Vec3 = [-0.45, 0.85, 0.35];

  constructor(private canvas: HTMLCanvasElement, private model: TerrainModel) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
    });
    if (!gl) throw new Error("当前浏览器不支持 WebGL2");
    this.gl = gl;
    this.terrainProgram = link(gl, terrainVert, terrainFrag);
    this.lineProgram = link(gl, lineVert, lineFrag);
    this.brushBuffer = gl.createBuffer()!;
    this.brushVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.brushVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.brushBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    // 地形为开放高度场，不启用背面剔除：保证各 WebGL 后端（含软件渲染）
    // 正面判定一致，且从下方观察时也不会整片消失。
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.1, 0.12, 0.16, 1);

    this.rebuildAll();
  }

  private chunkKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  rebuildAll(): void {
    for (let cy = 0; cy < this.model.chunksPerSide; cy++) {
      for (let cx = 0; cx < this.model.chunksPerSide; cx++) {
        this.rebuildChunk(cx, cy);
      }
    }
  }

  rebuildChunk(cx: number, cy: number): void {
    const data = buildChunkMesh(this.model, cx, cy);
    const key = this.chunkKey(cx, cy);
    const old = this.chunks.get(key);
    if (old) this.disposeChunk(old);
    this.chunks.set(key, this.uploadChunk(data));
  }

  rebuildChunks(coords: Array<[number, number]>): void {
    for (const [cx, cy] of coords) this.rebuildChunk(cx, cy);
  }

  private disposeChunk(chunk: ChunkGpu): void {
    const gl = this.gl;
    gl.deleteVertexArray(chunk.solidVao);
    gl.deleteVertexArray(chunk.wireVao);
    gl.deleteVertexArray(chunk.borderVao);
    for (const b of chunk.buffers) gl.deleteBuffer(b);
  }

  private uploadChunk(data: ChunkMeshData): ChunkGpu {
    const gl = this.gl;
    const buffers: WebGLBuffer[] = [];
    const makeBuffer = (target: number, src: ArrayBufferView): WebGLBuffer => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(target, buf);
      gl.bufferData(target, src, gl.DYNAMIC_DRAW);
      buffers.push(buf);
      return buf;
    };

    const posBuf = makeBuffer(gl.ARRAY_BUFFER, data.positions);
    const normalBuf = makeBuffer(gl.ARRAY_BUFFER, data.normals);
    const colorBuf = makeBuffer(gl.ARRAY_BUFFER, data.colors);
    const indexBuf = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, data.indices);
    const wireBuf = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, data.wireIndices);

    const bindAttribs = () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    };

    // 实体 VAO（三角形索引）
    const solidVao = gl.createVertexArray()!;
    gl.bindVertexArray(solidVao);
    bindAttribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);

    // 线框 VAO（线段索引，复用同一套顶点缓冲）
    const wireVao = gl.createVertexArray()!;
    gl.bindVertexArray(wireVao);
    bindAttribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireBuf);

    // 区块边界 VAO
    const borderVao = gl.createVertexArray()!;
    gl.bindVertexArray(borderVao);
    const borderBuf = makeBuffer(gl.ARRAY_BUFFER, data.borderPositions);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const borderIndexBuf = gl.createBuffer()!;
    buffers.push(borderIndexBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, borderIndexBuf);
    const borderCount = data.borderPositions.length / 3;
    const borderIdx = new Uint32Array(borderCount);
    for (let i = 0; i < borderCount; i++) borderIdx[i] = i;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, borderIdx, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    return {
      cx: data.cx,
      cy: data.cy,
      solidVao,
      indexCount: data.indices.length,
      wireVao,
      wireIndexCount: data.wireIndices.length,
      borderVao,
      borderCount,
      buffers,
    };
  }

  /** 更新笔刷环几何（世界空间圆盘线段，贴合高度场表面）。 */
  updateBrushRing(center: Vec3, radius: number): void {
    const gl = this.gl;
    const SEG = 72;
    const verts: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const wx = center[0] + Math.cos(a) * radius;
      const wz = center[2] + Math.sin(a) * radius;
      const wy = this.model.sampleHeightWorld(wx, wz) + 0.25;
      verts.push(wx, wy, wz);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.brushBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    this.brushPointCount = SEG + 1;
  }

  hideBrushRing(): void {
    this.brushPointCount = 0;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(camera: OrbitCamera): void {
    const gl = this.gl;
    camera.setViewport(this.canvas.width, this.canvas.height);
    camera.update();
    const vp = camera.viewProjection;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 地形实体
    gl.useProgram(this.terrainProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.terrainProgram, "uViewProj"), false, vp);
    gl.uniform3fv(
      gl.getUniformLocation(this.terrainProgram, "uLightDir"),
      this.lightDir
    );
    gl.uniform3fv(
      gl.getUniformLocation(this.terrainProgram, "uCameraPos"),
      camera.position
    );
    gl.uniform1f(
      gl.getUniformLocation(this.terrainProgram, "uWorldSize"),
      this.model.worldSize
    );
    for (const chunk of this.chunks.values()) {
      gl.bindVertexArray(chunk.solidVao);
      gl.drawElements(gl.TRIANGLES, chunk.indexCount, gl.UNSIGNED_INT, 0);
    }

    // 线框 / 边界 / 笔刷环
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, "uViewProj"), false, vp);

    if (this.showWireframe) {
      gl.uniform4f(gl.getUniformLocation(this.lineProgram, "uColor"), 0.75, 0.8, 0.9, 0.35);
      for (const chunk of this.chunks.values()) {
        gl.bindVertexArray(chunk.wireVao);
        gl.drawElements(gl.LINES, chunk.wireIndexCount, gl.UNSIGNED_INT, 0);
      }
    }

    if (this.showBorders) {
      gl.uniform4f(gl.getUniformLocation(this.lineProgram, "uColor"), 1.0, 0.78, 0.25, 0.95);
      for (const chunk of this.chunks.values()) {
        gl.bindVertexArray(chunk.borderVao);
        gl.drawElements(gl.LINES, chunk.borderCount, gl.UNSIGNED_INT, 0);
      }
    }

    if (this.showBrush && this.brushPointCount > 1) {
      gl.uniform4f(gl.getUniformLocation(this.lineProgram, "uColor"), 0.35, 0.85, 1.0, 1.0);
      gl.bindVertexArray(this.brushVao);
      gl.drawArrays(gl.LINE_STRIP, 0, this.brushPointCount);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    gl.deleteProgram(this.terrainProgram);
    gl.deleteProgram(this.lineProgram);
    gl.deleteBuffer(this.brushBuffer);
    gl.deleteVertexArray(this.brushVao);
  }
}
