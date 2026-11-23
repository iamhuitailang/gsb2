/*
 * paths.mjs —— 测试共享：public/js 下 UMD 模块的 require 句柄
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsDir = new URL('../../public/js/', import.meta.url);

export function loadJs(name) {
  return require(new URL(name, jsDir).pathname);
}
