/* 三维路线辅助线对照页
 * - 屏幕空间等宽折线（实例化渲染，顶点着色器内扩宽）
 * - 近裁面裁剪，防止线段穿过镜头时冒出尖刺
 * - 尖接(miter+限制) / 平接(bevel) / 圆接(round 圆盘)
 * - 虚线按世界距离或屏幕距离计数
 */
'use strict';

// ---------------------------------------------------------------- 状态
const state = {
  points: [],
  width: 6,            // CSS px
  color: '#ff7a1a',
  alpha: 1.0,
  join: 'miter',       // miter | bevel | round
  miterLimit: 4,       // 尖角长度限制（半宽倍数）
  dashOn: true,
  dashMode: 'world',   // world | screen
  dashLen: 0.6,
  gapLen: 0.35,
  scaleMode: 'device', // 1 | device | 2 | 0.5
  camera: { yaw: 0.8, pitch: 0.42, dist: 13, target: [0, 1, 0] },
  fov: 50,
};

const PRESETS = {
  // ① 跨可见边界：长路线贴着相机掠过，orbit 时线段会穿过近裁面
  cross: {
    points: [[-7, 1.3, 4.5], [-1.5, 1.5, 1.6], [0.6, 1.2, -0.6], [-0.8, 1.6, -3.5], [1.5, 1.4, -7]],
    camera: { yaw: 0.15, pitch: 0.18, dist: 5.5, target: [0, 1.3, -0.5] },
    join: 'miter', dashOn: true,
  },
  // ② 急折角：近 180° 掉头、重合点、极短线段
  sharp: {
    points: [
      [-3.2, 1, 0], [-1.2, 1, 0], [-0.6, 1, 0.03], [-1.2, 1, 0.06],   // 掉头
      [0.2, 1, 0.6], [0.205, 1, 0.6],                                 // 极短线段
      [1.2, 1, -0.1], [1.2, 1, -0.1],                                 // 重合点
      [2.2, 1, 0.55], [3.1, 1, -0.25],
    ],
    camera: { yaw: 1.1, pitch: 0.5, dist: 8, target: [0, 1, 0.1] },
    join: 'miter', dashOn: false,
  },
  // ③ 绕物体：在方块之间穿行，部分段落被遮挡
  orbit: {
    points: [
      [-4, 0.6, 3], [-1.6, 1.8, 1.2], [0.4, 0.5, -0.4], [2.2, 2.0, 0.6],
      [3.4, 0.8, 2.4], [1.2, 1.4, 3.6], [-1.8, 0.7, 2.6], [-3.6, 1.5, -1.2], [-1, 1.1, -2.6],
    ],
    camera: { yaw: 0.7, pitch: 0.45, dist: 12, target: [0, 1, 0.5] },
    join: 'round', dashOn: true,
  },
};

// 场景方块（前后关系参照物）
const BOXES = [
  { c: [0.2, 0.75, -1.2], s: [1.5, 1.5, 1.5], color: [0.45, 0.62, 0.85] },
  { c: [2.4, 0.6, 1.4], s: [1.2, 1.2, 1.2], color: [0.85, 0.65, 0.4] },
  { c: [-2.2, 0.9, 0.8], s: [1.4, 1.8, 1.4], color: [0.55, 0.78, 0.55] },
];

// ---------------------------------------------------------------- 小矩阵库（列主序）
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, ctr, up) {
  let zx = eye[0] - ctr[0], zy = eye[1] - ctr[1], zz = eye[2] - ctr[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ];
}
function mul4(a, b) { // a*b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  ];
}
function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}

// ---------------------------------------------------------------- WebGL 初始化
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
if (!gl) { document.getElementById('hud').textContent = '需要 WebGL2 支持'; throw new Error('no webgl2'); }

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// ---------------------------------------------------------------- 着色器
// 公共：近裁面裁剪（z >= -w 内），把落在近裁面外的点 a 沿 a→b 拉回到裁面上
const CLIP_GLSL = `
vec4 clipNear(vec4 a, vec4 b) {
  float da = a.z + a.w;
  float db = b.z + b.w;
  float t = da / (da - db);
  return mix(a, b, clamp(t, 0.0, 1.0));
}
vec2 toScreen(vec4 c, vec2 res) { return c.xy / c.w * 0.5 * res; }
`;

// —— 线段（每实例一段，含斜接/平接几何）——
const segVS = `#version 300 es
precision highp float;
in float aT;     // 0=段起点 1=段终点
in float aSide;  // -1 / +1
in float aBevel; // 0: quad 顶点; 1/2/3: 平接补角三角形
in vec3 aPrev; in vec3 aStart; in vec3 aEnd; in vec3 aNext;
in vec2 aCum;    // x: 世界累计距离(段起点)  y: 屏幕累计距离(段起点, 每帧更新)
uniform mat4 uMVP;
uniform vec2 uRes;
uniform float uHw;          // 半宽（设备 px）
uniform float uMiterLimit;
uniform int uJoin;          // 0 miter 1 bevel 2 round
uniform int uDashMode;      // 0 world 1 screen
out float vDistW;   // 世界距离：透视插值（与世界坐标线性）
out vec3 vPack;     // 屏幕距离手动屏幕线性插值: x=distS*w, y=side*w, z=w
${CLIP_GLSL}
void main() {
  vec4 cS = uMVP * vec4(aStart, 1.0);
  vec4 cE = uMVP * vec4(aEnd, 1.0);
  bool dead = (cS.z < -cS.w) && (cE.z < -cE.w);
  if (cS.z < -cS.w) cS = clipNear(cS, cE);
  if (cE.z < -cE.w) cE = clipNear(cE, cS);
  vec4 cP = uMVP * vec4(aPrev, 1.0);
  vec4 cN = uMVP * vec4(aNext, 1.0);
  if (cP.z < -cP.w) cP = clipNear(cP, cS);
  if (cN.z < -cN.w) cN = clipNear(cN, cE);

  vec2 sS = toScreen(cS, uRes), sE = toScreen(cE, uRes);
  vec2 sP = toScreen(cP, uRes), sN = toScreen(cN, uRes);

  vec2 dir = sE - sS; float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 dirP = sS - sP; float lP = length(dirP);
  dirP = lP > 1e-4 ? dirP / lP : dir;                 // 重合点/极短线段兜底
  vec2 perpP = vec2(-dirP.y, dirP.x);
  vec2 dirN = sN - sE; float lN = length(dirN);
  dirN = lN > 1e-4 ? dirN / lN : dir;
  vec2 perpN = vec2(-dirN.y, dirN.x);

  // 起/终点斜接向量，长度限制在 uMiterLimit 倍半宽内（掉头时和向量≈0，自动退化不爆刺）
  vec2 mS = perpP + perp; float lmS = length(mS);
  mS = lmS > 1e-4 ? mS / lmS : perp;
  float mLenS = min(uHw / max(dot(mS, perp), 1e-4), uHw * uMiterLimit);
  vec2 mE = perp + perpN; float lmE = length(mE);
  mE = lmE > 1e-4 ? mE / lmE : perp;
  float mLenE = min(uHw / max(dot(mE, perpN), 1e-4), uHw * uMiterLimit);

  vec2 pos; vec4 anchor; float t = aT;
  if (aBevel > 0.5) {
    // 平接补角三角形：接缝中心 + 前后两段外侧角点
    float cr = dirP.x * dir.y - dirP.y * dir.x;
    float outer = cr >= 0.0 ? 1.0 : -1.0;
    if (aBevel < 1.5) pos = sS;
    else if (aBevel < 2.5) pos = sS + perpP * uHw * outer;
    else pos = sS + perp * uHw * outer;
    anchor = cS;
    if (uJoin != 1 || lP < 1e-4) pos = sS;  // 非平接模式或首段：退化为零面积
  } else if (uJoin == 0) {
    vec2 base = t < 0.5 ? sS : sE;
    pos = base + (t < 0.5 ? mS * mLenS : mE * mLenE) * aSide;
    anchor = t < 0.5 ? cS : cE;
  } else {
    vec2 base = t < 0.5 ? sS : sE;
    pos = base + perp * uHw * aSide;
    anchor = t < 0.5 ? cS : cE;
  }

  vDistW = aCum.x + t * length(aEnd - aStart);
  float distS = aCum.y + t * length(sE - sS);
  float w = anchor.w;
  vPack = vec3(distS * w, aSide * w, w);

  if (dead) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 ndc = pos / (0.5 * uRes);
  gl_Position = vec4(ndc * anchor.w, anchor.z, anchor.w);  // 保留原始深度
}`;

const lineFS = `#version 300 es
precision highp float;
in float vDistW;
in vec3 vPack;   // x=distS*w, y=side*w, z=w
uniform vec4 uColor;
uniform int uDashOn;
uniform int uDashMode;
uniform vec2 uDash;   // 实段长, 间隔长（当前计数单位）
out vec4 outColor;
void main() {
  float side = vPack.y / vPack.z;    // 屏幕空间线性插值还原
  float alpha = 1.0;
  float fw = fwidth(side);
  alpha *= 1.0 - smoothstep(1.0 - fw * 1.5, 1.0, abs(side));  // 边缘抗锯齿
  if (uDashOn == 1) {
    float dist = uDashMode == 0 ? vDistW : vPack.x / vPack.z;
    float period = uDash.x + uDash.y;
    float m = mod(dist, period);
    float aa = max(fwidth(dist), 1e-4);
    alpha *= 1.0 - smoothstep(uDash.x - aa, uDash.x + aa, m);
  }
  if (alpha < 0.004) discard;
  outColor = vec4(uColor.rgb, uColor.a * alpha);
}`;

// —— 圆接/圆帽：每个接缝一个屏幕空间圆盘 ——
const discVS = `#version 300 es
precision highp float;
in vec2 aUnit;   // (0,0)=圆心, 单位圆上点=边缘
in vec3 aPrev; in vec3 aCur; in vec3 aNext;
in vec2 aCum;
uniform mat4 uMVP;
uniform vec2 uRes;
uniform float uHw;
out float vDistW;
out vec3 vPack;   // x=distS*w, y=r*w, z=w
${CLIP_GLSL}
void main() {
  vec4 cC = uMVP * vec4(aCur, 1.0);
  bool dead = cC.z < -cC.w;
  vec4 cP = uMVP * vec4(aPrev, 1.0);
  vec4 cN = uMVP * vec4(aNext, 1.0);
  if (!dead) {
    if (cP.z < -cP.w) cP = clipNear(cP, cC);
    if (cN.z < -cN.w) cN = clipNear(cN, cC);
  }
  vec2 sC = toScreen(cC, uRes), sP = toScreen(cP, uRes), sN = toScreen(cN, uRes);
  vec2 tangent = sN - sP; float lt = length(tangent);
  tangent = lt > 1e-4 ? tangent / lt : vec2(1.0, 0.0);

  vec2 offset = aUnit * uHw;
  vec2 pos = sC + offset;
  float along = dot(offset, tangent);   // 相对接缝中心沿线的偏移(px)
  float wLen = length(aNext - aPrev);
  float ratio = lt > 1e-4 ? wLen / lt : 0.0;   // px → 世界单位近似换算
  vDistW = aCum.x + along * ratio;
  vPack = vec3((aCum.y + along) * cC.w, length(aUnit) * cC.w, cC.w);
  if (dead) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 ndc = pos / (0.5 * uRes);
  gl_Position = vec4(ndc * cC.w, cC.z, cC.w);
}`;

const discFS = `#version 300 es
precision highp float;
in float vDistW;
in vec3 vPack;   // x=distS*w, y=r*w, z=w
uniform vec4 uColor;
uniform int uDashOn;
uniform int uDashMode;
uniform vec2 uDash;
out vec4 outColor;
void main() {
  float r = vPack.y / vPack.z;
  float alpha = 1.0;
  float fw = fwidth(r);
  alpha *= 1.0 - smoothstep(1.0 - fw * 1.5, 1.0, r);
  if (uDashOn == 1) {
    float dist = uDashMode == 0 ? vDistW : vPack.x / vPack.z;
    float period = uDash.x + uDash.y;
    float m = mod(dist, period);
    float aa = max(fwidth(dist), 1e-4);
    alpha *= 1.0 - smoothstep(uDash.x - aa, uDash.x + aa, m);
  }
  if (alpha < 0.004) discard;
  outColor = vec4(uColor.rgb, uColor.a * alpha);
}`;

// —— 方块 ——
const boxVS = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNormal;
uniform mat4 uMVP;
out vec3 vN;
void main() { vN = aNormal; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const boxFS = `#version 300 es
precision highp float;
in vec3 vN;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec3 L = normalize(vec3(0.5, 0.9, 0.4));
  float d = 0.35 + 0.65 * max(dot(normalize(vN), L), 0.0);
  outColor = vec4(uColor * d, 1.0);
}`;

// —— 地面网格 ——
const gridVS = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
const gridFS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const segProg = program(segVS, lineFS);
const discProg = program(discVS, discFS);
const boxProg = program(boxVS, boxFS);
const gridProg = program(gridVS, gridFS);

// ---------------------------------------------------------------- 静态几何
// 线段单位几何：6 顶点 quad + 3 顶点平接补角三角形
const segVert = new Float32Array([
  // t, side, bevel
  0, 1, 0,  0, -1, 0,  1, 1, 0,
  1, 1, 0,  0, -1, 0,  1, -1, 0,
  0, 0, 1,  0, 0, 2,  0, 0, 3,
]);
// 圆盘单位几何（三角扇 → 三角形列表）
const DISC_N = 28;
const discVert = (() => {
  const a = [];
  for (let i = 0; i < DISC_N; i++) {
    const t0 = (i / DISC_N) * Math.PI * 2, t1 = ((i + 1) / DISC_N) * Math.PI * 2;
    a.push(0, 0, Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1));
  }
  return new Float32Array(a);
})();

// 方块（含法线）
function buildBoxes() {
  const pos = [], nrm = [], idx = [];
  const faces = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  const verts = [], indices = [];
  for (const b of BOXES) {
    const base = verts.length / 6;
    for (const [n, quad] of faces) {
      const fb = verts.length / 6;
      for (const q of quad) {
        verts.push(
          b.c[0] + q[0] * b.s[0] / 2, b.c[1] + q[1] * b.s[1] / 2, b.c[2] + q[2] * b.s[2] / 2,
          n[0], n[1], n[2]);
      }
      indices.push(fb, fb + 1, fb + 2, fb, fb + 2, fb + 3);
    }
  }
  return { verts: new Float32Array(verts), indices: new Uint16Array(indices) };
}
const boxData = buildBoxes();

// 地面网格
const gridVerts = (() => {
  const a = [], R = 10;
  for (let i = -R; i <= R; i++) {
    a.push(i, 0, -R, i, 0, R, -R, 0, i, R, 0, i);
  }
  return new Float32Array(a);
})();

// ---------------------------------------------------------------- VAO / Buffer
function makeVao(prog, setup) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  setup(prog);
  gl.bindVertexArray(null);
  return vao;
}
function attr(prog, name, size, stride, offset, divisor = 0) {
  const loc = gl.getAttribLocation(prog.p, name);
  if (loc < 0) return;
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  if (divisor) gl.vertexAttribDivisor(loc, divisor);
}

// 线段
const segVao = gl.createVertexArray();
gl.bindVertexArray(segVao);
const segVertBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, segVertBuf);
gl.bufferData(gl.ARRAY_BUFFER, segVert, gl.STATIC_DRAW);
attr(segProg, 'aT', 1, 12, 0); attr(segProg, 'aSide', 1, 12, 4); attr(segProg, 'aBevel', 1, 12, 8);
const segInstBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, segInstBuf);
attr(segProg, 'aPrev', 3, 56, 0, 1); attr(segProg, 'aStart', 3, 56, 12, 1);
attr(segProg, 'aEnd', 3, 56, 24, 1); attr(segProg, 'aNext', 3, 56, 36, 1);
attr(segProg, 'aCum', 2, 56, 48, 1);
gl.bindVertexArray(null);

// 圆盘
const discVao = gl.createVertexArray();
gl.bindVertexArray(discVao);
const discVertBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, discVertBuf);
gl.bufferData(gl.ARRAY_BUFFER, discVert, gl.STATIC_DRAW);
attr(discProg, 'aUnit', 2, 8, 0);
const discInstBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, discInstBuf);
attr(discProg, 'aPrev', 3, 44, 0, 1); attr(discProg, 'aCur', 3, 44, 12, 1);
attr(discProg, 'aNext', 3, 44, 24, 1); attr(discProg, 'aCum', 2, 44, 36, 1);
gl.bindVertexArray(null);

// 方块
const boxVao = gl.createVertexArray();
gl.bindVertexArray(boxVao);
const boxVb = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, boxVb);
gl.bufferData(gl.ARRAY_BUFFER, boxData.verts, gl.STATIC_DRAW);
attr(boxProg, 'aPos', 3, 24, 0); attr(boxProg, 'aNormal', 3, 24, 12);
const boxIb = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIb);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, boxData.indices, gl.STATIC_DRAW);
gl.bindVertexArray(null);

// 网格
const gridVao = gl.createVertexArray();
gl.bindVertexArray(gridVao);
const gridVb = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, gridVb);
gl.bufferData(gl.ARRAY_BUFFER, gridVerts, gl.STATIC_DRAW);
attr(gridProg, 'aPos', 3, 12, 0);
gl.bindVertexArray(null);

// ---------------------------------------------------------------- 相机与交互
function eyePos() {
  const c = state.camera;
  const cp = Math.cos(c.pitch);
  return [
    c.target[0] + c.dist * cp * Math.sin(c.yaw),
    c.target[1] + c.dist * Math.sin(c.pitch),
    c.target[2] + c.dist * cp * Math.cos(c.yaw),
  ];
}
function viewProj() {
  const proj = perspective(state.fov * Math.PI / 180, canvas.width / canvas.height, 0.1, 200);
  const view = lookAt(eyePos(), state.camera.target, [0, 1, 0]);
  return mul4(proj, view);
}

let drag = null;
canvas.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const c = state.camera;
  if (drag.pan) {
    const eye = eyePos();
    const f = [c.target[0] - eye[0], c.target[1] - eye[1], c.target[2] - eye[2]];
    const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
    const r = [f[2], 0, -f[0]]; const rl = Math.hypot(...r) || 1; r[0] /= rl; r[2] /= rl;
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const k = c.dist * 0.0016;
    for (let i = 0; i < 3; i++) c.target[i] += (-dx * r[i] + dy * u[i]) * k;
  } else {
    c.yaw -= dx * 0.006;
    c.pitch = Math.min(1.5, Math.max(-1.5, c.pitch + dy * 0.006));
  }
});
canvas.addEventListener('pointerup', () => drag = null);
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  state.camera.dist = Math.min(80, Math.max(0.3, state.camera.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

// ---------------------------------------------------------------- 每帧数据：累计距离
// CPU 端复现着色器的近裁面裁剪，计算屏幕空间累计长度（供屏幕距离虚线）
function clipNearCPU(a, b) {
  const da = a[2] + a[3], db = b[2] + b[3];
  const t = Math.min(1, Math.max(0, da / (da - db)));
  return [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t);
}
function computeCum(mvp) {
  const pts = state.points;
  const n = pts.length;
  const cumW = new Float32Array(n), cumS = new Float32Array(n);
  const clips = pts.map(p => xform(mvp, [p[0], p[1], p[2], 1]));
  const W = canvas.width, H = canvas.height;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    cumW[i + 1] = cumW[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let cA = clips[i], cB = clips[i + 1];
    const behindA = cA[2] < -cA[3], behindB = cB[2] < -cB[3];
    let sLen = 0;
    if (!(behindA && behindB)) {
      if (behindA) cA = clipNearCPU(cA, cB);
      if (behindB) cB = clipNearCPU(cB, cA);
      const ax = cA[0] / cA[3] * 0.5 * W, ay = cA[1] / cA[3] * 0.5 * H;
      const bx = cB[0] / cB[3] * 0.5 * W, by = cB[1] / cB[3] * 0.5 * H;
      sLen = Math.hypot(bx - ax, by - ay);
    }
    cumS[i + 1] = cumS[i] + sLen;
  }
  return { cumW, cumS };
}

function uploadInstances(cum) {
  const pts = state.points, n = pts.length;
  // 线段实例
  const seg = new Float32Array(Math.max(0, n - 1) * 14);
  for (let i = 0; i < n - 1; i++) {
    const p = pts[Math.max(0, i - 1)], s = pts[i], e = pts[i + 1], nx = pts[Math.min(n - 1, i + 2)];
    seg.set([...p, ...s, ...e, ...nx, cum.cumW[i], cum.cumS[i]], i * 14);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, segInstBuf);
  gl.bufferData(gl.ARRAY_BUFFER, seg, gl.DYNAMIC_DRAW);
  // 接缝圆盘实例（每个路径点一个，端点处 prev/next 退化为自身 → 圆帽）
  const dj = new Float32Array(n * 11);
  for (let i = 0; i < n; i++) {
    const p = pts[Math.max(0, i - 1)], c = pts[i], nx = pts[Math.min(n - 1, i + 1)];
    dj.set([...p, ...c, ...nx, cum.cumW[i], cum.cumS[i]], i * 11);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, discInstBuf);
  gl.bufferData(gl.ARRAY_BUFFER, dj, gl.DYNAMIC_DRAW);
  return { segCount: n - 1, jointCount: n };
}

// ---------------------------------------------------------------- 渲染
const JOIN_ID = { miter: 0, bevel: 1, round: 2 };
function currentScale() {
  if (state.scaleMode === 'device') return window.devicePixelRatio || 1;
  return parseFloat(state.scaleMode);
}
function resize() {
  const s = currentScale();
  const w = Math.max(1, Math.round(canvas.clientWidth * s));
  const h = Math.max(1, Math.round(canvas.clientHeight * s));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function render() {
  resize();
  const scale = currentScale();
  const mvp = viewProj();
  const cum = computeCum(mvp);
  const { segCount, jointCount } = uploadInstances(cum);
  const hw = state.width * scale / 2;   // 半宽（设备 px）
  const rgb = hexToRgb(state.color);
  const dashUnits = state.dashMode === 'screen' ? scale : 1;  // 屏幕模式输入按 CSS px
  const dash = [state.dashLen * dashUnits, state.gapLen * dashUnits];

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.11, 0.12, 0.14, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  // 网格
  gl.useProgram(gridProg.p);
  gl.uniformMatrix4fv(gridProg.u.uMVP, false, mvp);
  gl.uniform4f(gridProg.u.uColor, 0.45, 0.48, 0.52, 0.25);
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(gridVao);
  gl.drawArrays(gl.LINES, 0, gridVerts.length / 3);

  // 方块（写深度）
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.useProgram(boxProg.p);
  gl.uniformMatrix4fv(boxProg.u.uMVP, false, mvp);
  gl.bindVertexArray(boxVao);
  // 每个方块单独上色：索引按 36 个一组
  for (let i = 0; i < BOXES.length; i++) {
    gl.uniform3fv(boxProg.u.uColor, BOXES[i].color);
    gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, i * 36 * 2);
  }

  // 路线（测深度但不写，避免自遮挡条纹）
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const join = JOIN_ID[state.join];

  gl.useProgram(segProg.p);
  gl.uniformMatrix4fv(segProg.u.uMVP, false, mvp);
  gl.uniform2f(segProg.u.uRes, canvas.width, canvas.height);
  gl.uniform1f(segProg.u.uHw, hw);
  gl.uniform1f(segProg.u.uMiterLimit, state.miterLimit);
  gl.uniform1i(segProg.u.uJoin, join);
  gl.uniform1i(segProg.u.uDashMode, state.dashMode === 'world' ? 0 : 1);
  gl.uniform4f(segProg.u.uColor, rgb[0], rgb[1], rgb[2], state.alpha);
  gl.uniform1i(segProg.u.uDashOn, state.dashOn ? 1 : 0);
  gl.uniform2f(segProg.u.uDash, dash[0], dash[1]);
  gl.bindVertexArray(segVao);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 9, segCount);

  if (join === 2) {  // 圆接：补接缝圆盘 + 圆帽
    gl.useProgram(discProg.p);
    gl.uniformMatrix4fv(discProg.u.uMVP, false, mvp);
    gl.uniform2f(discProg.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(discProg.u.uHw, hw);
    gl.uniform1i(discProg.u.uDashMode, state.dashMode === 'world' ? 0 : 1);
    gl.uniform4f(discProg.u.uColor, rgb[0], rgb[1], rgb[2], state.alpha);
    gl.uniform1i(discProg.u.uDashOn, state.dashOn ? 1 : 0);
    gl.uniform2f(discProg.u.uDash, dash[0], dash[1]);
    gl.bindVertexArray(discVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, discVert.length / 2, jointCount);
  }

  gl.bindVertexArray(null);
  gl.depthMask(true);

  updateHud(scale, hw);
}

// ---------------------------------------------------------------- HUD
const hud = document.getElementById('hud');
function updateHud(scale, hw) {
  hud.textContent =
    `画布 ${canvas.clientWidth}×${canvas.clientHeight} CSS px → ${canvas.width}×${canvas.height} 设备 px (×${scale})\n` +
    `线宽 ${state.width} CSS px = ${(hw * 2).toFixed(1)} 设备 px · 拐角 ${state.join} · 虚线 ${state.dashOn ? (state.dashMode === 'world' ? '世界距离' : '屏幕距离') : '关'}\n` +
    `相机 dist=${state.camera.dist.toFixed(2)} yaw=${state.camera.yaw.toFixed(2)} pitch=${state.camera.pitch.toFixed(2)}`;
}

// ---------------------------------------------------------------- UI
const $ = id => document.getElementById(id);
function bind(id, key, fmt = v => +v, show) {
  const el = $(id);
  el.value = state[key];
  if (show) show();
  el.addEventListener('input', () => { state[key] = fmt(el.value); if (show) show(); });
}
function bindCheck(id, key) {
  const el = $(id);
  el.checked = state[key];
  el.addEventListener('change', () => state[key] = el.checked);
}
// 虚线滑杆量程随计数方式切换：世界单位 0.05–3，屏幕 CSS px 1–100
function adjustDashSliders() {
  const screen = state.dashMode === 'screen';
  const cfg = screen
    ? { min: 1, max: 100, step: 1, defLen: 24, defGap: 16, unit: '(CSS px)' }
    : { min: 0.05, max: 3, step: 0.05, defLen: 0.6, defGap: 0.35, unit: '(世界单位)' };
  for (const [id, key, def] of [['dashLen', 'dashLen', cfg.defLen], ['gapLen', 'gapLen', cfg.defGap]]) {
    const el = $(id);
    el.min = cfg.min; el.max = cfg.max; el.step = cfg.step;
    if (state[key] < cfg.min || state[key] > cfg.max) state[key] = def;
    el.value = state[key];
    $(id + 'V').textContent = state[key];
  }
  $('dashUnit').textContent = cfg.unit;
}

function syncControls() {
  $('width').value = state.width; $('widthV').textContent = state.width;
  $('color').value = state.color;
  $('alpha').value = state.alpha; $('alphaV').textContent = state.alpha;
  $('join').value = state.join;
  $('miterLimit').value = state.miterLimit; $('miterLimitV').textContent = state.miterLimit;
  $('dashOn').checked = state.dashOn;
  $('dashMode').value = state.dashMode;
  $('scaleMode').value = state.scaleMode;
  adjustDashSliders();
}

bind('width', 'width', v => +v, () => $('widthV').textContent = $('width').value);
bind('color', 'color', v => v);
bind('alpha', 'alpha', v => +v, () => $('alphaV').textContent = $('alpha').value);
bind('join', 'join', v => v);
bind('miterLimit', 'miterLimit', v => +v, () => $('miterLimitV').textContent = $('miterLimit').value);
bindCheck('dashOn', 'dashOn');
bind('dashMode', 'dashMode', v => v, adjustDashSliders);
bind('dashLen', 'dashLen', v => +v, () => $('dashLenV').textContent = $('dashLen').value);
bind('gapLen', 'gapLen', v => +v, () => $('gapLenV').textContent = $('gapLen').value);
bind('scaleMode', 'scaleMode', v => v);

// 点表格
function rebuildTable() {
  const tb = document.querySelector('#pts tbody');
  tb.innerHTML = '';
  state.points.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i}</td>` + [0, 1, 2].map(a =>
      `<td><input type="number" step="0.1" data-i="${i}" data-a="${a}" value="${(+p[a]).toFixed(2)}"></td>`).join('') +
      `<td><button class="del" data-del="${i}">×</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (isFinite(v)) state.points[+inp.dataset.i][+inp.dataset.a] = v;
  }));
  tb.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (state.points.length > 2) { state.points.splice(+b.dataset.del, 1); rebuildTable(); }
  }));
}
$('addPt').addEventListener('click', () => {
  const last = state.points[state.points.length - 1];
  state.points.push([last[0] + 1, last[1], last[2] + 0.5]);
  rebuildTable();
});

// 预设
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
  const p = PRESETS[btn.dataset.preset];
  state.points = p.points.map(q => [...q]);
  Object.assign(state.camera, p.camera);
  if (p.join) state.join = p.join;
  state.dashOn = p.dashOn;
  syncControls();
  rebuildTable();
}));

// 保存 / 打开
function serialize() {
  return JSON.stringify({
    points: state.points, width: state.width, color: state.color, alpha: state.alpha,
    join: state.join, miterLimit: state.miterLimit,
    dashOn: state.dashOn, dashMode: state.dashMode, dashLen: state.dashLen, gapLen: state.gapLen,
    scaleMode: state.scaleMode, camera: state.camera,
  }, null, 1);
}
function applyState(o) {
  if (Array.isArray(o.points) && o.points.length >= 2) state.points = o.points.map(p => p.slice(0, 3).map(Number));
  for (const k of ['width', 'color', 'alpha', 'join', 'miterLimit', 'dashOn', 'dashMode', 'dashLen', 'gapLen', 'scaleMode'])
    if (k in o) state[k] = o[k];
  if (o.camera) Object.assign(state.camera, o.camera);
  syncControls();
  rebuildTable();
}
$('saveLocal').addEventListener('click', () => {
  localStorage.setItem('route-line-demo', serialize());
  $('saveHint').textContent = '已保存到 localStorage（' + new Date().toLocaleTimeString() + '）';
});
$('loadLocal').addEventListener('click', () => {
  const s = localStorage.getItem('route-line-demo');
  if (s) { applyState(JSON.parse(s)); $('saveHint').textContent = '已打开保存的镜头与路线'; }
  else $('saveHint').textContent = '还没有保存过';
});
$('exportJson').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serialize()], { type: 'application/json' }));
  a.download = 'route-line.json'; a.click();
  URL.revokeObjectURL(a.href);
});
$('importJson').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then(t => { applyState(JSON.parse(t)); $('saveHint').textContent = '已导入 ' + f.name; });
  e.target.value = '';
});
$('exportPng').addEventListener('click', () => {
  render();  // 先渲染再取帧，保证内容是最新的
  canvas.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `route-${canvas.width}x${canvas.height}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

// ---------------------------------------------------------------- 启动
applyState({ points: PRESETS.cross.points, camera: PRESETS.cross.camera, join: 'miter', dashOn: true });
// 支持 #preset=sharp&join=round&dashMode=screen 之类的链接参数（便于对照与分享）
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('preset') && PRESETS[hash.get('preset')]) {
  const p = PRESETS[hash.get('preset')];
  state.points = p.points.map(q => [...q]);
  Object.assign(state.camera, p.camera);
}
for (const k of ['join', 'dashMode', 'scaleMode']) if (hash.get(k)) state[k] = hash.get(k);
if (hash.get('dashOn')) state.dashOn = hash.get('dashOn') === '1';
if (hash.get('width')) state.width = +hash.get('width');
for (const k of ['yaw', 'pitch', 'dist']) if (hash.get(k)) state.camera[k] = +hash.get(k);
syncControls();
rebuildTable();
(function loop() { render(); requestAnimationFrame(loop); })();
