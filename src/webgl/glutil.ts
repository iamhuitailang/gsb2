import type { Mat4 } from '../math/mat4.js';

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attributes: Map<string, number>;
}

export class ShaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaderError';
  }
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new ShaderError('无法创建着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown error';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new ShaderError(`${kind} shader compile failed:\n${log}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramInfo {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new ShaderError('无法创建着色器程序');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'unknown error';
    gl.deleteProgram(program);
    throw new ShaderError(`program link failed:\n${log}`);
  }

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  const attributes = new Map<string, number>();
  for (let i = 0; i < attributeCount; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (info) attributes.set(info.name, gl.getAttribLocation(program, info.name));
  }
  return {
    program,
    uniforms,
    attributes,
    // Cache lookups lazily through helper below.
  } as ProgramInfo;
}

export function uniform(gl: WebGL2RenderingContext, info: ProgramInfo, name: string): WebGLUniformLocation | null {
  if (!info.uniforms.has(name)) {
    info.uniforms.set(name, gl.getUniformLocation(info.program, name));
  }
  return info.uniforms.get(name) ?? null;
}

export function setMat4(gl: WebGL2RenderingContext, info: ProgramInfo, name: string, m: Mat4): void {
  const loc = uniform(gl, info, name);
  if (loc) gl.uniformMatrix4fv(loc, false, m);
}

export function setMat3(gl: WebGL2RenderingContext, info: ProgramInfo, name: string, m: Float32Array): void {
  const loc = uniform(gl, info, name);
  if (loc) gl.uniformMatrix3fv(loc, false, m);
}

export function setVec3(gl: WebGL2RenderingContext, info: ProgramInfo, name: string, v: readonly number[]): void {
  const loc = uniform(gl, info, name);
  if (loc) gl.uniform3f(loc, v[0], v[1], v[2]);
}

export function setFloat(gl: WebGL2RenderingContext, info: ProgramInfo, name: string, value: number): void {
  const loc = uniform(gl, info, name);
  if (loc) gl.uniform1f(loc, value);
}

/** Convert a #rrggbb or #rgb string to linear-ish 0..1 RGB (sRGB kept as-is). */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const value = Number.parseInt(h, 16);
  if (!Number.isFinite(value)) return [0.6, 0.7, 0.8];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function rgbToCss(rgb: readonly number[], alpha = 1): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])}, ${alpha})`;
}
