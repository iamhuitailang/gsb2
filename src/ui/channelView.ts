import { type ChannelView, type NormalTextureData, sampleRaw } from '../core/textures.ts';
import type { GreenConvention } from '../core/tangent.ts';

/**
 * 把原始法线纹理的某个通道画到 2D canvas 上，并在选中 UV 处画十字。
 * RGB 模式按“当前生效约定”解释（DirectX 时预览翻绿后的样子），
 * 单通道模式始终显示原始字节，另在信息栏给出数值。
 */
export function drawChannelCanvas(
  canvas: HTMLCanvasElement,
  tex: NormalTextureData,
  view: ChannelView,
  convention: GreenConvention,
  crossUV: [number, number] | null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const out = ctx.createImageData(tex.width, tex.height);
  for (let i = 0; i < tex.width * tex.height; i++) {
    const o = i * 4;
    const r = tex.rgba[o];
    const g = tex.rgba[o + 1];
    const b = tex.rgba[o + 2];
    const a = tex.rgba[o + 3];
    let rr = 0;
    let gg = 0;
    let bb = 0;
    switch (view) {
      case 'rgb':
        rr = r;
        gg = convention === 'opengl' ? g : 255 - g;
        bb = b;
        break;
      case 'r':
        rr = gg = bb = r;
        break;
      case 'g':
        rr = gg = bb = g;
        break;
      case 'b':
        rr = gg = bb = b;
        break;
      case 'a':
        rr = gg = bb = a;
        break;
      case 'height': {
        const h = tex.heightField[i];
        const gray = Math.round(Math.max(0, Math.min(1, h * 0.25 + 0.5)) * 255);
        rr = gg = bb = gray;
        break;
      }
    }
    out.data[o] = rr;
    out.data[o + 1] = gg;
    out.data[o + 2] = bb;
    out.data[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  if (crossUV) {
    const x = crossUV[0] * canvas.width;
    const y = (1 - crossUV[1]) * canvas.height;
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 7, y);
    ctx.lineTo(x + 7, y);
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x, y + 7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
  }
}

export function channelLabel(view: ChannelView): string {
  switch (view) {
    case 'rgb':
      return 'RGB 合成（按生效约定）';
    case 'r':
      return 'R 通道原始字节（X 扰动）';
    case 'g':
      return 'G 通道原始字节（Y 扰动）';
    case 'b':
      return 'B 通道原始字节（Z 基底面）';
    case 'a':
      return 'A 通道原始字节';
    case 'height':
      return '高度场（生成源数据）';
  }
}

export function texelInfo(
  tex: NormalTextureData,
  uv: [number, number],
  convention: GreenConvention,
): string {
  const [r, g, b, a] = sampleRaw(tex, uv[0], uv[1]);
  const nx = (r / 127.5 - 1).toFixed(3);
  const gyRaw = (g / 127.5 - 1).toFixed(3);
  const gyEff = convention === 'opengl' ? gyRaw : (-g / 127.5 + 1).toFixed(3);
  const nz = (b / 127.5 - 1).toFixed(3);
  return [
    `UV (${uv[0].toFixed(4)}, ${uv[1].toFixed(4)})`,
    `原始字节 RGBA = ${r}, ${g}, ${b}, ${a}`,
    `切线空间 X=${nx}  Y(原始)=${gyRaw}  Z=${nz}`,
    `生效 Y(${convention === 'opengl' ? 'OpenGL' : 'DirectX 翻绿'})=${gyEff}`,
  ].join('\n');
}
