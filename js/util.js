/* 通用工具：确定性随机、值噪声、f32 舍入、CRC32。浏览器与 Node 共用。 */
(function (global) {
  const MPC = global.MPC || (global.MPC = {});

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // 基于种子排列的二维值噪声，输出 [0,1)
  function makeValueNoise2D(seed) {
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const grads = new Float32Array(256);
    for (let i = 0; i < 256; i++) grads[i] = rand();

    function hash(ix, iz) {
      return grads[perm[(perm[ix & 255] + (iz & 255)) & 255]];
    }
    return function noise(x, z) {
      const ix = Math.floor(x), iz = Math.floor(z);
      const fx = smoothstep(x - ix), fz = smoothstep(z - iz);
      const v00 = hash(ix, iz), v10 = hash(ix + 1, iz);
      const v01 = hash(ix, iz + 1), v11 = hash(ix + 1, iz + 1);
      return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fz);
    };
  }

  // 所有坐标生成后立即按 f32 舍入，保证导出/读回后量化结果逐位复现
  const f32 = (typeof Math.fround === 'function') ? Math.fround : (v) => v;

  // ---- CRC32 (IEEE 802.3) ----
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatNum(v, digits) {
    if (!isFinite(v)) return String(v);
    const d = digits == null ? 5 : digits;
    if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(3);
    return Number(v.toFixed(d)).toString();
  }

  MPC.util = { mulberry32, makeValueNoise2D, lerp, smoothstep, clamp, f32, crc32, formatBytes, formatNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = MPC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
