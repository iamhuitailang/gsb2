// 确定性 PRNG —— 同种子同帧号必然产生同序列,用于 Halton 抖动加扰与路径噪声。
// 场景几何/相机动画本身是帧号的解析函数(见 scene.js),不依赖随机数,
// PRNG 仅用于让"同一镜头"在不同 seed 下可复现地换一组路径参数。

// mulberry32: 4 周期 32 位状态,周期足够长,跨平台整数运算结果一致。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 字符串 seed -> uint32(FNV-1a)
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 基础 Halton 序列(index 从 0 开始),返回 [0,1)。
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

// 帧抖动序列:把 Halton(2,3) 映射到 (-1,1] 的亚像素 NDC 偏移。
// 标准居中映射 (h - 0.5) * 2:index 0 时 h=0 => 偏移 -1(采样在像素边缘),
// 这里把序列原点平移到像素中心:h' = h==0 ? 0.5 : h,使 index 0 => 零偏移,
// "重开后第一帧无抖动"天然成立;index 必须随"重开"归零,序列才可复现。
export function frameJitter(jitterIndex) {
  const h2 = jitterIndex === 0 ? 0.5 : halton(jitterIndex, 2);
  const h3 = jitterIndex === 0 ? 0.5 : halton(jitterIndex, 3);
  return {
    x: (h2 - 0.5) * 2,
    y: (h3 - 0.5) * 2,
  };
}
