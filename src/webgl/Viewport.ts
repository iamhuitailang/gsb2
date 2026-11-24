import {
  type Mat4,
  type Vec3,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  v3,
} from '../core/math.ts';
import type { CameraState } from '../core/state.ts';
import { type PickResult, type Ray, type WorldFace, type WorldMesh, rayCast } from '../core/world.ts';
import { type NormalTextureData, uploadTexture } from '../core/textures.ts';
import type { HalfSide } from '../core/tangent.ts';
import { LINE_FS, LINE_VS, MESH_FS, MESH_VS } from './shaders.ts';

const EDGE_COLORS: Record<'fold' | 'mirror' | 'free', [number, number, number]> = {
  fold: [1.0, 0.62, 0.12],
  mirror: [0.95, 0.2, 0.85],
  free: [0.25, 0.25, 0.28],
};

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('无法创建 shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader 编译失败: ${log}`);
  }
  return sh;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('无法创建 program');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program 链接失败: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

interface AttribBuffer {
  buffer: WebGLBuffer;
  loc: number;
  size: number;
}

function attribBuffer(
  gl: WebGLRenderingContext,
  prog: WebGLProgram,
  name: string,
  size: number,
  data: Float32Array,
): AttribBuffer {
  const loc = gl.getAttribLocation(prog, name);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error(`无法创建缓冲 ${name}`);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  return { buffer, loc, size };
}

export interface ViewportOptions {
  half: HalfSide | 'all';
}

export class WebGLViewport {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private meshProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private meshBuf: AttribBuffer[] = [];
  private lineBuffer: WebGLBuffer | null = null;
  private lineColorBuffer: WebGLBuffer | null = null;
  private lineCount = 0;
  private triCount = 0;
  private texture: WebGLTexture | null = null;
  private half: HalfSide | 'all';
  private visibleFaceIds: number[] = [];

  constructor(canvas: HTMLCanvasElement, opts: ViewportOptions) {
    this.canvas = canvas;
    this.half = opts.half;
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('浏览器不支持 WebGL');
    this.gl = gl;
    this.meshProg = program(gl, MESH_VS, MESH_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.075, 0.082, 0.095, 1);
  }

  setTexture(tex: NormalTextureData): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = uploadTexture(this.gl, tex);
  }

  private cameraVectors(cam: CameraState): { eye: Vec3; viewDir: Vec3 } {
    const yaw = (cam.yawDeg * Math.PI) / 180;
    const pitch = (cam.pitchDeg * Math.PI) / 180;
    const eye: Vec3 = [
      cam.distance * Math.cos(pitch) * Math.sin(yaw),
      cam.distance * Math.sin(pitch),
      cam.distance * Math.cos(pitch) * Math.cos(yaw),
    ];
    return { eye, viewDir: v3.normalize(v3.neg(eye)) };
  }

  buildRay(cssX: number, cssY: number, cam: CameraState): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((cssX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((cssY - rect.top) / rect.height) * 2;
    const aspect = rect.width / rect.height;
    const fovy = (40 * Math.PI) / 180;
    const { eye } = this.cameraVectors(cam);
    const forward = v3.normalize(v3.neg(eye));
    const right = v3.normalize(v3.cross(forward, [0, 1, 0]));
    const up = v3.cross(right, forward);
    const tan = Math.tan(fovy / 2);
    const dir = v3.normalize(
      v3.add(
        v3.add(forward, v3.scale(right, nx * tan * aspect)),
        v3.scale(up, ny * tan),
      ),
    );
    return { origin: eye, dir };
  }

  pick(cssX: number, cssY: number, cam: CameraState, world: WorldMesh): PickResult | null {
    const ray = this.buildRay(cssX, cssY, cam);
    const faces = world.faces.filter((f) => this.visibleFaceIds.includes(f.id));
    return rayCast(ray, faces);
  }

  /** 上传当前世界网格（姿态/预设变化后调用） */
  uploadWorld(world: WorldMesh): void {
    const gl = this.gl;
    const faces = world.faces.filter((f) =>
      this.half === 'all' ? true : f.half === this.half,
    );
    this.visibleFaceIds = faces.map((f) => f.id);
    const n = faces.length * 3;
    const positions = new Float32Array(n * 3);
    const tangents = new Float32Array(n * 3);
    const bitangents = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const valid = new Float32Array(n);

    let i = 0;
    for (const f of faces) {
      for (let k = 0; k < 3; k++) {
        const o = i * 3;
        positions.set(f.positions[k], o);
        tangents.set(f.frame.T, o);
        bitangents.set(f.frame.B, o);
        normals.set(f.frame.N, o);
        uvs.set(f.uvs[k], i * 2);
        valid[i] = f.valid ? 1 : 0;
        i++;
      }
    }
    this.triCount = faces.length;

    const old = this.meshBuf;
    this.meshBuf = [
      attribBuffer(gl, this.meshProg, 'aPosition', 3, positions),
      attribBuffer(gl, this.meshProg, 'aT', 3, tangents),
      attribBuffer(gl, this.meshProg, 'aB', 3, bitangents),
      attribBuffer(gl, this.meshProg, 'aN', 3, normals),
      attribBuffer(gl, this.meshProg, 'aUV', 2, uvs),
      attribBuffer(gl, this.meshProg, 'aValid', 1, valid),
    ];
    for (const b of old) gl.deleteBuffer(b.buffer);
  }

  private buildLines(
    world: WorldMesh,
    selectionFaceId: number | null,
    gizmoFace: WorldFace | null,
    highlightSeams: boolean,
    wireframe: boolean,
  ): { pos: Float32Array; color: Float32Array } {
    const pts: number[] = [];
    const cols: number[] = [];
    const push = (a: Vec3, b: Vec3, c: [number, number, number]) => {
      pts.push(...a, ...b);
      cols.push(c[0], c[1], c[2], c[0], c[1], c[2]);
    };
    const visible = new Set(this.visibleFaceIds);
    for (const e of world.edges) {
      // 接缝/硬边的邻接面可能分属不同半区：任一邻接面在当前视口可见就绘制，
      // 否则镜像接缝（两半各持一个邻接面）会在所有视口都被误裁掉。
      if (!e.faceIds.some((id) => visible.has(id))) continue;
      if (e.kind === 'free' && !wireframe) continue;
      if ((e.kind === 'fold' || e.kind === 'mirror') && !highlightSeams && !wireframe) continue;
      let c: [number, number, number] = EDGE_COLORS[e.kind];
      if (e.kind === 'free' || !highlightSeams) c = [0.3, 0.3, 0.34];
      push(e.a, e.b, c);
    }
    if (selectionFaceId !== null) {
      const f = world.faces[selectionFaceId];
      if (f && visible.has(f.id)) {
        const yellow: [number, number, number] = [1, 0.85, 0.2];
        push(f.positions[0], f.positions[1], yellow);
        push(f.positions[1], f.positions[2], yellow);
        push(f.positions[2], f.positions[0], yellow);
      }
    }
    if (gizmoFace) {
      const c = v3.lerp(gizmoFace.positions[0], gizmoFace.positions[1], 0.45);
      const origin = v3.lerp(c, gizmoFace.positions[2], 0.12);
      const s = 0.55;
      push(origin, v3.add(origin, v3.scale(gizmoFace.frame.T, s)), [1, 0.25, 0.25]);
      push(origin, v3.add(origin, v3.scale(gizmoFace.frame.B, s)), [0.3, 1, 0.35]);
      push(origin, v3.add(origin, v3.scale(gizmoFace.frame.N, s)), [0.35, 0.55, 1]);
    }
    return { pos: new Float32Array(pts), color: new Float32Array(cols) };
  }

  render(args: {
    world: WorldMesh;
    cam: CameraState;
    lightDir: Vec3;
    flipG: 0 | 1;
    useTexture: boolean;
    halfTint: number;
    diffuse: number;
    specular: number;
    shininess: number;
    selectionFaceId: number | null;
    gizmoFace: WorldFace | null;
    highlightSeams: boolean;
    wireframe: boolean;
  }): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.triCount === 0) return;

    const { eye, viewDir } = this.cameraVectors(args.cam);
    const aspect = w / h;
    const proj = mat4Perspective((40 * Math.PI) / 180, aspect, 0.1, 100);
    const view = mat4LookAt(eye, [0, 0, 0], [0, 1, 0]);
    const vp = mat4Multiply(proj, view);

    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uViewProj'), false, vp as Float32Array);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uLightDir'), args.lightDir);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uViewDir'), viewDir);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uFlipG'), args.flipG);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uUseTex'), args.useTexture ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uDiffuse'), args.diffuse);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSpecular'), args.specular);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uShininess'), args.shininess);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSelected'), 0);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uHalfTint'), args.halfTint);
    if (this.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uNormalMap'), 0);
    }
    for (const b of this.meshBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
      gl.enableVertexAttribArray(b.loc);
      gl.vertexAttribPointer(b.loc, b.size, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, this.triCount * 3);

    // 选中面再叠一次金色混合
    if (args.selectionFaceId !== null && this.visibleFaceIds.includes(args.selectionFaceId)) {
      gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSelected'), 1);
      const idx = this.visibleFaceIds.indexOf(args.selectionFaceId);
      gl.drawArrays(gl.TRIANGLES, idx * 3, 3);
    }

    const lines = this.buildLines(
      args.world,
      args.selectionFaceId,
      args.gizmoFace,
      args.highlightSeams,
      args.wireframe,
    );
    this.lineCount = lines.pos.length / 3;
    if (this.lineCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, vp as Float32Array);
      if (!this.lineBuffer) this.lineBuffer = gl.createBuffer();
      if (!this.lineColorBuffer) this.lineColorBuffer = gl.createBuffer();
      const posLoc = gl.getAttribLocation(this.lineProg, 'aPosition');
      const colLoc = gl.getAttribLocation(this.lineProg, 'aColor');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lines.pos, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lines.color, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(colLoc);
      gl.vertexAttribPointer(colLoc, 3, gl.FLOAT, false, 0, 0);
      gl.lineWidth(2);
      // 接缝/折痕线与表面共面，关闭深度测试避免被三角形遮挡（线在最后绘制，叠加在上层）
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
      gl.enable(gl.DEPTH_TEST);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of this.meshBuf) gl.deleteBuffer(b.buffer);
    if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
    if (this.lineColorBuffer) gl.deleteBuffer(this.lineColorBuffer);
    if (this.texture) gl.deleteTexture(this.texture);
  }
}

export function viewProjection(cam: CameraState, aspect: number): Mat4 {
  const { eye } = ((): { eye: Vec3 } => {
    const yaw = (cam.yawDeg * Math.PI) / 180;
    const pitch = (cam.pitchDeg * Math.PI) / 180;
    return {
      eye: [
        cam.distance * Math.cos(pitch) * Math.sin(yaw),
        cam.distance * Math.sin(pitch),
        cam.distance * Math.cos(pitch) * Math.cos(yaw),
      ] as Vec3,
    };
  })();
  return mat4Multiply(
    mat4Perspective((40 * Math.PI) / 180, aspect, 0.1, 100),
    mat4LookAt(eye, [0, 0, 0], [0, 1, 0]),
  );
}
