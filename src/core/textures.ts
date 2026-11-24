import type { GreenConvention } from './tangent.ts';

export interface NormalTextureData {
  width: number;
  height: number;
  /** RGBA8，按 OpenGL 约定存储（平面处为 [128,128,255,255]） */
  rgba: Uint8ClampedArray;
  /** 生成时的高度场，通道检查面板可以看 */
  heightField: Float32Array;
}

export type TextureKind = 'flat' | 'directional';
export type ChannelView = 'rgb' | 'r' | 'g' | 'b' | 'a' | 'height';

export const TEXTURE_SIZE = 256;
const HEIGHT_SCALE = 3.2;

function heightAt(kind: TextureKind, x: number, y: number): number {
  if (kind === 'flat') return 0;
  // 定向凹凸：水平走向的棱（沿 u 延伸，沿 v 起伏）+ 一个圆鼓包 + 一条斜槽。
  // 沿 v 的强定向特征，正好能在镜像半暴露 B 翻向导致的亮/暗翻转。
  const bands =
    0.85 * Math.sin(y * Math.PI * 6) + 0.4 * Math.sin(y * Math.PI * 13);
  const dx = x - 0.32;
  const dy = y - 0.38;
  const bump = 1.1 * Math.exp(-(dx * dx + dy * dy) * 28);
  const groove = -0.7 * Math.exp(-Math.pow(x + y - 1.25, 2) * 40);
  return bands + bump + groove;
}

export function generateTexture(kind: TextureKind, size = TEXTURE_SIZE): NormalTextureData {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const heightField = new Float32Array(size * size);
  const h = (u: number, v: number) => heightAt(kind, u, v);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      const i = py * size + px;
      heightField[i] = h(u, v);
      // 有限差分求高度场法线（OpenGL 约定：+Y 向上，即 v 增大方向）
      const du = 1 / size;
      const dv = 1 / size;
      const dHdu = (h(u + du, v) - h(u - du, v)) / (2 * du);
      const dHdv = (h(u, v + dv) - h(u, v - dv)) / (2 * dv);
      let nx = -dHdu * HEIGHT_SCALE;
      let ny = -dHdv * HEIGHT_SCALE;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = i * 4;
      rgba[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgba[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgba[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      rgba[o + 3] = 255;
    }
  }
  return { width: size, height: size, rgba, heightField };
}

/** 取某个 UV 处的原始字节（NEAREST 采样，与着色器一致） */
export function sampleRaw(tex: NormalTextureData, u: number, v: number): [number, number, number, number] {
  const px = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
  const py = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
  const o = (py * tex.width + px) * 4;
  return [tex.rgba[o], tex.rgba[o + 1], tex.rgba[o + 2], tex.rgba[o + 3]];
}

/** 原始字节 -> 切线空间浮点向量（不应用约定翻转） */
export function rawToTangentVector(rgba: [number, number, number, number]): [number, number, number] {
  return [rgba[0] / 127.5 - 1, rgba[1] / 127.5 - 1, rgba[2] / 127.5 - 1];
}

/** 应用当前生效的绿通道约定 */
export function applyConvention(
  vec: [number, number, number],
  convention: GreenConvention,
): [number, number, number] {
  if (convention === 'opengl') return vec;
  return [vec[0], -vec[1], vec[2]];
}

export function uploadTexture(gl: WebGLRenderingContext, tex: NormalTextureData): WebGLTexture {
  const handle = gl.createTexture();
  if (!handle) throw new Error('无法创建 WebGL 纹理');
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    tex.width,
    tex.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    tex.rgba as unknown as Uint8Array,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return handle;
}
