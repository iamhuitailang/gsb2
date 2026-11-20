import type { Mat4 } from '../math/mat4.js';
import { identity, multiply } from '../math/mat4.js';
import type { Vec3 } from '../math/vec3.js';
import { MESH_BUILDERS, type MeshData, type MeshName } from './meshes.js';

/** CPU-side TRS transform. */
export interface Transform {
  position: Vec3;
  /** Euler degrees, applied X then Y then Z. */
  rotation: Vec3;
  scale: Vec3;
}

export function transformMatrix(t: Transform): Mat4 {
  const rx = (t.rotation[0] * Math.PI) / 180;
  const ry = (t.rotation[1] * Math.PI) / 180;
  const rz = (t.rotation[2] * Math.PI) / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  // R = Rz * Ry * Rx (column-major).
  const m00 = cz * cy;
  const m01 = cz * sy * sx - sz * cx;
  const m02 = cz * sy * cx + sz * sx;
  const m10 = sz * cy;
  const m11 = sz * sy * sx + cz * cx;
  const m12 = sz * sy * cx - cz * sx;
  const m20 = -sy;
  const m21 = cy * sx;
  const m22 = cy * cx;

  const m = new Float32Array(16);
  m[0] = m00 * t.scale[0];
  m[1] = m10 * t.scale[0];
  m[2] = m20 * t.scale[0];
  m[4] = m01 * t.scale[1];
  m[5] = m11 * t.scale[1];
  m[6] = m21 * t.scale[1];
  m[8] = m02 * t.scale[2];
  m[9] = m12 * t.scale[2];
  m[10] = m22 * t.scale[2];
  m[12] = t.position[0];
  m[13] = t.position[1];
  m[14] = t.position[2];
  m[15] = 1;
  return m;
}

export function normalMatrix(model: Mat4): Float32Array {
  // Rotation-only normal matrix; uniform scale handled by normalization in shader.
  const m = new Float32Array(9);
  m[0] = model[0]; m[1] = model[1]; m[2] = model[2];
  m[3] = model[4]; m[4] = model[5]; m[5] = model[6];
  m[6] = model[8]; m[7] = model[9]; m[8] = model[10];
  // Normalize columns.
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(m[c * 3], m[c * 3 + 1], m[c * 3 + 2]) || 1;
    m[c * 3] /= len;
    m[c * 3 + 1] /= len;
    m[c * 3 + 2] /= len;
  }
  return m;
}

export interface GpuMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  dispose(): void;
}

export class MeshCache {
  private cache = new Map<MeshName, GpuMesh>();
  private data = new Map<MeshName, MeshData>();
  private gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  getData(name: MeshName): MeshData {
    let d = this.data.get(name);
    if (!d) {
      d = MESH_BUILDERS[name]();
      this.data.set(name, d);
    }
    return d;
  }

  get(name: MeshName): GpuMesh {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const gl = this.gl;
    const data = this.getData(name);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('无法创建 VAO');
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    const mesh: GpuMesh = {
      vao,
      indexCount: data.indices.length,
      dispose: () => {
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(vbo);
        gl.deleteBuffer(nbo);
        gl.deleteBuffer(ibo);
      },
    };
    this.cache.set(name, mesh);
    return mesh;
  }

  dispose(): void {
    for (const mesh of this.cache.values()) mesh.dispose();
    this.cache.clear();
  }
}

/** Simple dynamic line buffer with per-vertex colour. */
export class LineBatch {
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private capacity = 0;
  private vertexCount = 0;
  private pending: number[] = [];
  private gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('无法创建线段缓冲');
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  begin(): void {
    this.pending = [];
    this.vertexCount = 0;
  }

  line(a: Vec3, b: Vec3, color: readonly number[]): void {
    this.vertex(a, color);
    this.vertex(b, color);
  }

  /** Pushes a polyline as a series of segments. */
  polyline(points: Vec3[], color: readonly number[]): void {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1], points[i], color);
  }

  vertex(p: Vec3, color: readonly number[]): void {
    const required = (this.vertexCount + 1) * 6;
    if (required > this.capacity) this.grow(required);
    this.pending.push(p[0], p[1], p[2], color[0], color[1], color[2]);
    this.vertexCount += 1;
  }

  private grow(required: number): void {
    let newCap = Math.max(256, this.capacity);
    while (newCap < required) newCap *= 2;
    this.capacity = newCap;
  }

  /** Uploads accumulated vertices and draws them. */
  flush(mode: 'lines' | 'line-strip' = 'lines'): void {
    if (this.vertexCount === 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.pending), gl.DYNAMIC_DRAW);
    gl.drawArrays(mode === 'line-strip' ? gl.LINE_STRIP : gl.LINES, 0, this.vertexCount);
    this.pending = [];
    this.vertexCount = 0;
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.vbo);
  }
}

export function composeModel(parent: Mat4, local: Mat4): Mat4 {
  return multiply(parent, local);
}

export function translationMatrix(p: Vec3): Mat4 {
  return transformMatrix({ position: p, rotation: [0, 0, 0], scale: [1, 1, 1] });
}

export function identityMatrix(): Mat4 {
  return identity();
}
