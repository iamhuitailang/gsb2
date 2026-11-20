// 贴图加载：正常贴图走 Image 解码；缺失/解码失败统一落到带文字的棋盘格占位贴图

export interface TextureResult {
  texture: WebGLTexture;
  width: number;
  height: number;
  placeholder: boolean;
}

/** 生成 256x256 的棋盘格 + 中文提示占位贴图 */
export function createPlaceholderTexture(gl: WebGL2RenderingContext): TextureResult {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cell = 32;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#c94f4f' : '#f2d8d8';
      ctx.fillRect(x, y, cell, cell);
    }
  }

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(16, 72, size - 32, 112);
  ctx.strokeStyle = '#ffd9d9';
  ctx.lineWidth = 3;
  ctx.strokeRect(16, 72, size - 32, 112);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText('贴图缺失', size / 2, 112);
  ctx.font = '18px sans-serif';
  ctx.fillText('TEXTURE MISSING', size / 2, 150);

  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return { texture, width: size, height: size, placeholder: true };
}

export function loadTextureFromUrl(
  gl: WebGL2RenderingContext,
  url: string,
): Promise<TextureResult> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      resolve({ texture, width: image.width, height: image.height, placeholder: false });
    };
    image.onerror = () => resolve(createPlaceholderTexture(gl));
    image.src = url;
  });
}

/** 8 位十六进制颜色 #rrggbbaa / #rrggbb -> 归一化向量 */
export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  const num = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(num)) return [1, 1, 1];
  return [((num >> 16) & 255) / 255, (num >> 8 & 255) / 255, (num & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number): string =>
    Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
