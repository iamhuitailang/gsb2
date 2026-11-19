import type { RasterImage } from '../core/types.ts';

const cache = new WeakMap<RasterImage, HTMLCanvasElement>();

/** Convert a float raster into a canvas, cached per image object identity. */
export function rasterToCanvas(image: RasterImage): HTMLCanvasElement {
  const cached = cache.get(image);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const output = new Uint8ClampedArray(image.width * image.height * 4);
    const data = image.data;
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i] ?? 0;
      output[i] = Math.round((value < 0 ? 0 : value > 1 ? 1 : value) * 255);
    }
    ctx.putImageData(new ImageData(output, image.width, image.height), 0, 0);
  }
  cache.set(image, canvas);
  return canvas;
}
