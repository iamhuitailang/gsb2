import * as THREE from 'three';
import { TextureLayer } from '../core/texture-layer.js';

/** 安全读取 three 纹理像素（图像可能未解码完成） */
export async function readTextureToTextureLayerSafe(
  texture: THREE.Texture,
  targetSize: number,
): Promise<TextureLayer | null> {
  try {
    const image = texture.image as
      | HTMLImageElement
      | ImageBitmap
      | undefined;
    if (image instanceof HTMLImageElement && !image.complete) {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error('贴图加载失败')), {
          once: true,
        });
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    if (image instanceof HTMLImageElement || image instanceof ImageBitmap) {
      ctx.drawImage(image, 0, 0, targetSize, targetSize);
    } else {
      ctx.fillStyle = '#b4b4b4';
      ctx.fillRect(0, 0, targetSize, targetSize);
    }
    return TextureLayer.fromRGBA(
      targetSize,
      targetSize,
      ctx.getImageData(0, 0, targetSize, targetSize).data,
    );
  } catch (err) {
    console.warn('读取模型自带贴图失败，使用默认基础纹理', err);
    return null;
  }
}
