import type { TextureEntry } from '../types';

/** 生成棋盘格 dataURL（内置默认纹理，完全离线） */
export function checkerDataUrl(cells = 8, size = 256): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f5' : '#3f3f46';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.strokeStyle = '#a1a1aa';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  return canvas.toDataURL('image/png');
}

/** 确定性伪随机噪点纹理（固定种子，保证同参数同画面） */
export function noiseDataUrl(size = 256): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  let seed = 1337;
  const rand = () => {
    // LCG
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand() * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 彩色渐变 + 网格，方便观察 UV 方向 */
export function gradientDataUrl(size = 256): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const r = Math.round(u * 255);
      const g = Math.round(v * 255);
      const b = Math.round((1 - u) * 128 + 64);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

export const BUILTIN_TEXTURES: { label: string; name: string; dataUrl: string }[] = [
  { label: '棋盘格', name: 'checker', dataUrl: checkerDataUrl() },
  { label: '噪点（确定性）', name: 'noise', dataUrl: noiseDataUrl() },
  { label: 'UV 渐变', name: 'gradient', dataUrl: gradientDataUrl() },
];

/** 上传 dataURL 为 WebGL 纹理；图片解码是异步的，完成后通过回调通知 */
export function uploadDataUrl(
  gl: WebGLRenderingContext,
  dataUrl: string,
  onReady: (texture: WebGLTexture, width: number, height: number) => void,
): WebGLTexture | null {
  if (!dataUrl) return null;
  const texture = gl.createTexture();
  if (!texture) return null;
  // 先放 1x1 占位，避免解码完成前采样到未完成纹理
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([128, 128, 128, 255]),
  );
  setDefaultParams(gl);

  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    setDefaultParams(gl);
    onReady(texture, img.naturalWidth, img.naturalHeight);
  };
  img.src = dataUrl;
  return texture;
}

function setDefaultParams(gl: WebGLRenderingContext) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
}

/** 读取用户选择的图片文件，限制最大边长后转成 dataURL */
export function fileToDataUrl(file: File, maxSize = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function disposeTexture(gl: WebGLRenderingContext, entry: TextureEntry) {
  if (entry.texture) gl.deleteTexture(entry.texture);
  entry.texture = null;
}
