/* app.js — 界面与 WebGL 渲染。依赖 core.js (MeshCore)。 */
(function () {
'use strict';
const C = MeshCore;
const $ = id => document.getElementById(id);

/* ---------- 约定预设 ---------- */
const PRESETS = {
  gltf:    { label: 'Y-up · +Z前 · 右手 (glTF/Three.js)', up: '+Y', fwd: '+Z', handed: 'RH' },
  opengl:  { label: 'Y-up · -Z前 · 右手 (OpenGL 视角)',   up: '+Y', fwd: '-Z', handed: 'RH' },
  unity:   { label: 'Y-up · +Z前 · 左手 (Unity/DirectX)', up: '+Y', fwd: '+Z', handed: 'LH' },
  blender: { label: 'Z-up · -Y前 · 右手 (Blender)',       up: '+Z', fwd: '-Y', handed: 'RH' },
  max:     { label: 'Z-up · +Y前 · 右手 (3ds Max/CAD)',   up: '+Z', fwd: '+Y', handed: 'RH' },
  custom:  { label: '自定义…' },
};
const AXIS_NAMES = Object.keys(C.AXES);
const PALETTE = [[0.8,0.6,0.3],[0.4,0.6,0.9],[0.5,0.8,0.5],[0.9,0.5,0.7],[0.7,0.7,0.4],[0.5,0.75,0.8]];

/* ---------- 状态 ---------- */
const state = {
  mesh: null, dst: null, T: null,
  diag: null, dstDiag: null,
  pivot: { mode: 'center', vertex: 0 },
  rot: [0, 0, 0],
  hl: false,
  lastExportText: null,
};
const cam = { theta: -0.7, phi: 0.5, zoom: 1, pan: [0, 0] };

/* ---------- 小工具 ---------- */
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = 'none'; }, ms || 3200);
}
const fmt = (x, d) => isFinite(x) ? Number(x.toPrecision(d || 5)) : '—';
const fmtV = (v, d) => v ? '(' + v.map(x => fmt(x, d)).join(', ') + ')' : '—';

function getConv(side) { // side: 'src' | 'dst'
  const p = $(side + 'Preset').value;
  if (p !== 'custom') return { up: PRESETS[p].up, fwd: PRESETS[p].fwd, handed: PRESETS[p].handed };
  return { up: $(side + 'Up').value, fwd: $(side + 'Fwd').value, handed: $(side + 'Hand').value };
}
function convText(c) {
  return '上' + c.up + ' · 前' + c.fwd + ' · ' + (c.handed === 'LH' ? '左手' : '右手');
}

/* ---------- 变换流水线 ---------- */
function computePivot() {
  const bb = C.bbox(state.mesh);
  if (!bb) return [0, 0, 0];
  if (state.pivot.mode === 'vertex') {
    const v = state.mesh.positions[state.pivot.vertex];
    if (v && v.every(isFinite)) return v.slice();
  }
  if (state.pivot.mode === 'bottom') {
    const up = C.AXES[getConv('src').up];
    const k = up.findIndex(x => x !== 0);
    const p = bb.center.slice();
    p[k] = up[k] > 0 ? bb.min[k] : bb.max[k];
    return p;
  }
  return bb.center.slice();
}

function recompute() {
  if (!state.mesh) { updateInfo(); return; }
  const srcConv = getConv('src'), dstConv = getConv('dst');
  let T;
  try {
    T = C.buildTransform({
      srcUnit: $('srcUnit').value, dstUnit: $('dstUnit').value,
      srcConv, dstConv, rot: state.rot, pivot: computePivot(),
    });
  } catch (e) { toast('约定无效: ' + e.message); return; }
  state.T = T;
  state.dst = C.applyTransform(state.mesh, T);
  state.diag = C.diagnostics(state.mesh);
  state.dstDiag = C.diagnostics(state.dst);
  rebuildMeshBuffers();
  updateInfo();
  updateDiagTable();
  $('mirrorInfo').innerHTML = T.mirrored
    ? '<span class="bad">⚠ 镜像变换(det=' + fmt(T.det, 2) + '):已自动翻转三角形绕序,并启用双面光照,表面不会消失或发黑。</span>'
    : '<span class="ok">非镜像变换(det=' + fmt(T.det, 2) + '),绕序保持不变。</span>';
}

/* ---------- WebGL ---------- */
const canvas = $('gl');
const gl = canvas.getContext('webgl', { antialias: true });
if (!gl) { toast('当前环境不支持 WebGL'); }

function makeShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function makeProg(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, makeShader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, makeShader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const meshProg = makeProg(
  'attribute vec3 aPos;attribute vec3 aNor;attribute vec3 aCol;uniform mat4 uVP;' +
  'varying vec3 vNor;varying vec3 vCol;' +
  'void main(){vNor=aNor;vCol=aCol;gl_Position=uVP*vec4(aPos,1.0);}',
  'precision mediump float;varying vec3 vNor;varying vec3 vCol;uniform vec3 uLight;' +
  'void main(){vec3 n=normalize(vNor);if(!gl_FrontFacing)n=-n;' +           // 双面光照:背面不黑
  'float d=max(dot(n,normalize(uLight)),0.0);' +
  'gl_FragColor=vec4(vCol*(0.35+0.65*d),1.0);}');
const lineProg = makeProg(
  'attribute vec3 aPos;attribute vec3 aCol;uniform mat4 uVP;varying vec3 vCol;' +
  'void main(){vCol=aCol;gl_Position=uVP*vec4(aPos,1.0);}',
  'precision mediump float;varying vec3 vCol;void main(){gl_FragColor=vec4(vCol,1.0);}');

const meshLoc = {
  aPos: gl.getAttribLocation(meshProg, 'aPos'), aNor: gl.getAttribLocation(meshProg, 'aNor'),
  aCol: gl.getAttribLocation(meshProg, 'aCol'),
  uVP: gl.getUniformLocation(meshProg, 'uVP'), uLight: gl.getUniformLocation(meshProg, 'uLight'),
};
const lineLoc = {
  aPos: gl.getAttribLocation(lineProg, 'aPos'), aCol: gl.getAttribLocation(lineProg, 'aCol'),
  uVP: gl.getUniformLocation(lineProg, 'uVP'),
};

/* 每个视图的网格缓冲:0=源(原始坐标),1=目标(变换后) */
const meshBufs = [null, null];
function buildRenderData(mesh, diag, hl) {
  const n = mesh.faces.length;
  const pos = new Float32Array(n * 9), nor = new Float32Array(n * 9), col = new Float32Array(n * 9);
  const bb = C.bbox(mesh);
  const diagLen = bb ? Math.max(C.vlen(bb.size), 1e-30) : 1;
  const areaEps = 1e-12 * diagLen * diagLen;
  mesh.faces.forEach((f, fi) => {
    const P = f.map(i => mesh.positions[i].map(x => isFinite(x) ? x : 0)); // 渲染时异常坐标归零
    let nrm = C.vnorm(C.cross(C.sub(P[1], P[0]), C.sub(P[2], P[0])));
    if (!nrm.every(isFinite)) nrm = [0, 1, 0];
    const pi = mesh.facePart[fi];
    const area = 0.5 * C.vlen(C.cross(C.sub(P[1], P[0]), C.sub(P[2], P[0])));
    const partHasNan = diag && diag[pi] && diag[pi].nan > 0;
    for (let k = 0; k < 3; k++) {
      pos.set(P[k], fi * 9 + k * 3);
      nor.set(nrm, fi * 9 + k * 3);
      let c = mesh.colors ? mesh.colors[f[k]] : PALETTE[pi % PALETTE.length];
      if (hl && !(area > areaEps)) c = [1, 0, 0];            // 零面积面 → 红
      else if (hl && partHasNan) c = [1, 0, 1];              // 含异常坐标部件 → 品红
      col.set(c, fi * 9 + k * 3);
    }
  });
  return { pos, nor, col, count: n * 3 };
}
function uploadMesh(slot, mesh, diag) {
  if (meshBufs[slot]) {
    gl.deleteBuffer(meshBufs[slot].pos); gl.deleteBuffer(meshBufs[slot].nor); gl.deleteBuffer(meshBufs[slot].col);
  }
  if (!mesh) { meshBufs[slot] = null; return; }
  const d = buildRenderData(mesh, diag, state.hl);
  const mk = arr => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b; };
  meshBufs[slot] = { pos: mk(d.pos), nor: mk(d.nor), col: mk(d.col), count: d.count };
}
function rebuildMeshBuffers() {
  uploadMesh(0, state.mesh, state.diag);
  uploadMesh(1, state.dst, state.dstDiag);
}

const lineBuf = gl.createBuffer();

/* mat4(列主序) */
function perspective(fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2);
  return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
}
function lookAt(e, c, up) {
  const z = C.vnorm(C.sub(e, c));
  const x = C.vnorm(C.cross(up, z));
  const y = C.cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -C.dot(x, e), -C.dot(y, e), -C.dot(z, e), 1]);
}
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function project(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [cx, cy, cw];
}

/* 视图几何:返回 {x,y,w,h}(CSS 像素,y 向下) */
function viewRect(i, cssW, cssH) { return { x: i * cssW / 2, y: 0, w: cssW / 2, h: cssH }; }

function viewFit(i) {
  const mesh = i === 0 ? state.mesh : state.dst;
  const bb = mesh ? C.bbox(mesh) : null;
  if (!bb) return { center: [0, 0, 0], radius: 2 };
  const r = Math.max(C.vlen(bb.size) / 2, 1e-6);
  return { center: bb.center, radius: r };
}

const lastVP = [null, null]; // 每视图最新 VP 矩阵,供拾取/标签投影

function cameraFor(i, cssW, cssH) {
  const fit = viewFit(i);
  const rect = viewRect(i, cssW, cssH);
  const dir = [Math.cos(cam.phi) * Math.sin(cam.theta), Math.sin(cam.phi), Math.cos(cam.phi) * Math.cos(cam.theta)];
  const dist = fit.radius * 3 * cam.zoom;
  const eye = [fit.center[0] + dir[0] * dist, fit.center[1] + dir[1] * dist, fit.center[2] + dir[2] * dist];
  // 平移:沿相机右/上方向
  const fwd = C.vnorm(C.sub(fit.center, eye));
  let up = [0, 1, 0];
  if (Math.abs(C.dot(fwd, up)) > 0.99) up = [0, 0, 1];
  const right = C.vnorm(C.cross(fwd, up));
  const upv = C.cross(right, fwd);
  const panS = fit.radius * 1.6;
  const center = [
    fit.center[0] + right[0] * cam.pan[0] * panS + upv[0] * cam.pan[1] * panS,
    fit.center[1] + right[1] * cam.pan[0] * panS + upv[1] * cam.pan[1] * panS,
    fit.center[2] + right[2] * cam.pan[0] * panS + upv[2] * cam.pan[1] * panS,
  ];
  const eye2 = [eye[0] + center[0] - fit.center[0], eye[1] + center[1] - fit.center[1], eye[2] + center[2] - fit.center[2]];
  const proj = perspective(Math.PI / 4, rect.w / rect.h, dist / 100, dist * 20);
  const view = lookAt(eye2, center, up);
  return { vp: mul4(proj, view), fit, rect };
}

/* 构造一帧的线段(网格地面、坐标轴、方向箭头、包围盒、基准点) */
function buildLines(i, fit) {
  const L = [];
  const seg = (a, b, c) => { L.push(a[0], a[1], a[2], ...c, b[0], b[1], b[2], ...c); };
  const r = fit.radius;
  const up = i === 0 ? C.AXES[getConv('src').up] : [0, 1, 0];
  const fwd = i === 0 ? C.AXES[getConv('src').fwd] : [0, 0, 1];
  const upIdx = up.findIndex(x => x !== 0);
  const t1 = [0, 0, 0], t2 = [0, 0, 0];
  t1[(upIdx + 1) % 3] = 1; t2[(upIdx + 2) % 3] = 1;
  // 地面网格:过包围盒底部、垂直于"上"轴
  const mesh = i === 0 ? state.mesh : state.dst;
  const bb = mesh ? C.bbox(mesh) : null;
  const origin = [0, 0, 0];
  if (bb) {
    for (let k = 0; k < 3; k++) origin[k] = bb.center[k];
    origin[upIdx] = up[upIdx] > 0 ? bb.min[upIdx] : bb.max[upIdx];
  }
  const step = Math.pow(10, Math.floor(Math.log10(r))) || 1;
  const gc = [0.32, 0.34, 0.38], gc2 = [0.42, 0.44, 0.5];
  for (let k = -4; k <= 4; k++) {
    const c = k === 0 ? gc2 : gc;
    const o = k * step;
    seg([origin[0] + t1[0] * o - t2[0] * 4 * step, origin[1] + t1[1] * o - t2[1] * 4 * step, origin[2] + t1[2] * o - t2[2] * 4 * step],
        [origin[0] + t1[0] * o + t2[0] * 4 * step, origin[1] + t1[1] * o + t2[1] * 4 * step, origin[2] + t1[2] * o + t2[2] * 4 * step], c);
    seg([origin[0] + t2[0] * o - t1[0] * 4 * step, origin[1] + t2[1] * o - t1[1] * 4 * step, origin[2] + t2[2] * o - t1[2] * 4 * step],
        [origin[0] + t2[0] * o + t1[0] * 4 * step, origin[1] + t2[1] * o + t1[1] * 4 * step, origin[2] + t2[2] * o + t1[2] * 4 * step], c);
  }
  // 坐标轴 RGB = XYZ
  const AL = r * 1.2;
  const axisCols = [[0.9, 0.25, 0.25], [0.3, 0.85, 0.3], [0.35, 0.5, 1]];
  for (let k = 0; k < 3; k++) {
    const e = [0, 0, 0]; e[k] = AL;
    seg([0, 0, 0], e, axisCols[k]);
  }
  // 方向箭头:白=上,黄=前
  const UL = r * 1.5;
  seg([0, 0, 0], [up[0] * UL, up[1] * UL, up[2] * UL], [0.95, 0.95, 0.95]);
  seg([0, 0, 0], [fwd[0] * UL, fwd[1] * UL, fwd[2] * UL], [1, 0.85, 0.1]);
  // 包围盒
  if (bb) {
    const c = [0.75, 0.75, 0.8];
    const [mn, mx] = [bb.min, bb.max];
    const cor = [];
    for (const a of [mn[0], mx[0]]) for (const b of [mn[1], mx[1]]) for (const d of [mn[2], mx[2]]) cor.push([a, b, d]);
    const E = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];
    for (const [a, b] of E) seg(cor[a], cor[b], c);
  }
  // 基准点(黄色十字)
  if (state.mesh && state.T) {
    const p = i === 0 ? computePivot()
      : (() => { const w = C.m3apply(state.T.A, computePivot()); return [w[0] + state.T.t[0], w[1] + state.T.t[1], w[2] + state.T.t[2]]; })();
    const s = r * 0.08, yc = [1, 1, 0.2];
    for (let k = 0; k < 3; k++) {
      const a = p.slice(), b = p.slice();
      a[k] -= s; b[k] += s;
      seg(a, b, yc);
    }
  }
  return new Float32Array(L);
}

/* 标签(投影到屏幕的轴名与方向标记) */
const labelPool = [];
function updateLabels(i, camInfo, cssW) {
  const fit = camInfo.fit, r = fit.radius;
  const up = i === 0 ? C.AXES[getConv('src').up] : [0, 1, 0];
  const fwd = i === 0 ? C.AXES[getConv('src').fwd] : [0, 0, 1];
  const AL = r * 1.2, UL = r * 1.5;
  const items = [
    { p: [AL, 0, 0], t: 'X', c: '#ff6b6b' },
    { p: [0, AL, 0], t: 'Y', c: '#7bd88a' },
    { p: [0, 0, AL], t: 'Z', c: '#7aa2ff' },
    { p: [up[0] * UL, up[1] * UL, up[2] * UL], t: '上', c: '#ffffff' },
    { p: [fwd[0] * UL, fwd[1] * UL, fwd[2] * UL], t: '前', c: '#ffd94d' },
  ];
  const rect = camInfo.rect;
  for (const it of items) {
    const [cx, cy, cw] = project(camInfo.vp, it.p);
    let div = labelPool.find(d => !d._used);
    if (!div) { div = document.createElement('div'); $('labels').appendChild(div); labelPool.push(div); }
    div._used = true;
    if (cw <= 0) { div.style.display = 'none'; continue; }
    div.style.display = 'block';
    div.style.left = (rect.x + (cx / cw + 1) / 2 * rect.w) + 'px';
    div.style.top = (rect.y + (1 - cy / cw) / 2 * rect.h) + 'px';
    div.style.color = it.c;
    div.textContent = it.t;
  }
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  labelPool.forEach(d => { d._used = false; d.style.display = 'none'; });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0.117, 0.129, 0.149, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE); // 永不剔除背面:镜像下表面也不会消失

  for (let i = 0; i < 2; i++) {
    const rect = viewRect(i, cssW, cssH);
    const camInfo = cameraFor(i, cssW, cssH);
    lastVP[i] = camInfo.vp;
    const x = Math.round(rect.x * dpr), y = Math.round(rect.y * dpr);
    const w = Math.round(rect.w * dpr), h = Math.round(rect.h * dpr);
    gl.viewport(x, y, w, h);
    gl.scissor(x, y, w, h);
    gl.clearColor(i === 0 ? 0.13 : 0.115, i === 0 ? 0.14 : 0.13, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mb = meshBufs[i];
    if (mb) {
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(meshLoc.uVP, false, camInfo.vp);
      gl.uniform3f(meshLoc.uLight, 0.5, 0.8, 0.6);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.pos);
      gl.enableVertexAttribArray(meshLoc.aPos);
      gl.vertexAttribPointer(meshLoc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.nor);
      gl.enableVertexAttribArray(meshLoc.aNor);
      gl.vertexAttribPointer(meshLoc.aNor, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.col);
      gl.enableVertexAttribArray(meshLoc.aCol);
      gl.vertexAttribPointer(meshLoc.aCol, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, mb.count);
    }

    const lines = buildLines(i, camInfo.fit);
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(lineLoc.uVP, false, camInfo.vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(lineLoc.aPos);
    gl.vertexAttribPointer(lineLoc.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(lineLoc.aCol);
    gl.vertexAttribPointer(lineLoc.aCol, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.LINES, 0, lines.length / 6);

    updateLabels(i, camInfo, cssW);
  }
  gl.disable(gl.SCISSOR_TEST);
  requestAnimationFrame(render);
}

/* ---------- 信息 / 诊断面板 ---------- */
function updateInfo() {
  const su = $('srcUnit').value, du = $('dstUnit').value;
  const scale = C.UNITS[su] / C.UNITS[du];
  $('scaleInfo').textContent = '换算比例: ×' + fmt(scale, 6) + ' (1 ' + C.UNIT_NAMES[su] + ' = ' + fmt(scale, 6) + ' ' + C.UNIT_NAMES[du] + ')';
  if (!state.mesh) {
    $('infoL').textContent = '未载入模型';
    $('infoR').textContent = '';
    $('meshInfo').textContent = '未载入模型 — 可将 OBJ / STL / PLY 文件拖放到右侧视图';
    return;
  }
  const bbS = C.bbox(state.mesh), bbD = C.bbox(state.dst);
  const m = state.mesh;
  $('meshInfo').textContent = '已载入: ' + m.parts.length + ' 个部件 · ' +
    m.positions.length + ' 顶点 · ' + m.faces.length + ' 三角面';
  $('infoL').textContent =
    '尺寸(X×Y×Z): ' + fmtV(bbS && bbS.size) + ' ' + C.UNIT_NAMES[su] + '\n' +
    '中心: ' + fmtV(bbS && bbS.center) + '\n' +
    '约定: ' + convText(getConv('src')) + ' (原始坐标)';
  $('infoR').textContent =
    '尺寸(X×Y×Z): ' + fmtV(bbD && bbD.size) + ' ' + C.UNIT_NAMES[du] + '\n' +
    '中心: ' + fmtV(bbD && bbD.center) + '\n' +
    '约定: ' + convText(getConv('dst')) + (state.T && state.T.mirrored ? ' · 镜像(已翻转绕序)' : '');
}

function updateDiagTable() {
  const tbl = $('diagTable'), warn = $('warn');
  if (!state.diag) { tbl.innerHTML = ''; warn.textContent = ''; return; }
  let html = '<tr><th>部件</th><th>顶点</th><th>面</th><th>尺寸(X×Y×Z)</th><th>零面积面</th><th>异常坐标</th></tr>';
  const warns = [];
  state.diag.forEach(d => {
    const badZ = d.zeroArea > 0, badN = d.nan > 0;
    html += '<tr><td>' + d.name + '</td><td>' + d.verts + '</td><td>' + d.faces + '</td><td>' +
      (d.size ? d.size.map(x => fmt(x, 4)).join(' × ') : '—') + '</td><td' + (badZ ? ' class="bad"' : '') + '>' + d.zeroArea +
      '</td><td' + (badN ? ' class="bad"' : '') + '>' + d.nan + '</td></tr>';
    if (badZ) warns.push('⚠ 部件「' + d.name + '」含 ' + d.zeroArea + ' 个零面积/退化面');
    if (badN) warns.push('⚠ 部件「' + d.name + '」含 ' + d.nan + ' 个异常坐标(NaN/Inf)顶点');
  });
  tbl.innerHTML = html;
  warn.innerHTML = warns.length ? warns.join('\n') : '<span class="ok">✓ 未发现异常坐标或零面积面</span>';
}

/* ---------- 文件载入 ---------- */
function loadMesh(mesh, name) {
  state.mesh = mesh;
  state.pivot = { mode: 'center', vertex: 0 };
  document.querySelector('input[name=pivot][value=center]').checked = true;
  $('pivotVert').textContent = '#-';
  cam.pan = [0, 0]; cam.zoom = 1;
  recompute();
  toast('已载入 ' + name + ': ' + mesh.parts.length + ' 个部件');
}

function parseFile(buf, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'obj') return C.parseOBJ(new TextDecoder().decode(buf));
  if (ext === 'stl') return C.parseSTL(buf);
  if (ext === 'ply') return C.parsePLY(new TextDecoder().decode(buf));
  throw new Error('不支持的格式: .' + ext + '(支持 OBJ/STL/PLY)');
}

function handleFile(file, cb) {
  const rd = new FileReader();
  rd.onload = () => {
    try { cb(parseFile(rd.result, file.name), file.name); }
    catch (e) { toast('载入失败: ' + e.message); }
  };
  rd.readAsArrayBuffer(file);
}

/* ---------- 导出与验证 ---------- */
function download(name, content, mime) {
  const blob = content instanceof ArrayBuffer ? new Blob([content], { type: 'application/octet-stream' })
    : new Blob([content], { type: mime || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function statsOf(mesh) {
  const bb = C.bbox(mesh);
  return {
    parts: mesh.parts.length,
    size: bb ? bb.size : null,
    min: bb ? bb.min : null,
    max: bb ? bb.max : null,
    centroid: C.centroid(mesh),
  };
}

function compareStats(expect, got) {
  const lines = [];
  const tol = 1e-4;
  const eq = (a, b) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  const okP = expect.parts === got.parts;
  lines.push((okP ? '✓' : '✗') + ' 部件数量: 期望 ' + expect.parts + ',实际 ' + got.parts);
  let okS = true, okO = true, okC = true;
  for (let k = 0; k < 3; k++) {
    if (!expect.size || !got.size || !eq(expect.size[k], got.size[k])) okS = false;
    if (!expect.min || !got.min || !eq(expect.min[k], got.min[k]) || !eq(expect.max[k], got.max[k])) okO = false;
    if (!eq(expect.centroid[k], got.centroid[k])) okC = false;
  }
  lines.push((okS ? '✓' : '✗') + ' 尺寸(X×Y×Z): 期望 ' + fmtV(expect.size) + ',实际 ' + fmtV(got.size));
  lines.push((okO ? '✓' : '✗') + ' 朝向(包围盒范围): ' + (okO ? '一致' : '不一致,期望 ' + fmtV(expect.min) + ' ~ ' + fmtV(expect.max) + ',实际 ' + fmtV(got.min) + ' ~ ' + fmtV(got.max)));
  lines.push((okC ? '✓' : '✗') + ' 质心: 期望 ' + fmtV(expect.centroid) + ',实际 ' + fmtV(got.centroid));
  const allOk = okP && okS && okO && okC;
  return { text: lines.join('\n'), allOk };
}

function verifyMesh(mesh, sourceDesc) {
  if (!state.dst) { toast('请先载入模型'); return; }
  const res = compareStats(statsOf(state.dst), statsOf(mesh));
  $('verifyOut').innerHTML = '<span class="' + (res.allOk ? 'ok' : 'bad') + '">' +
    (res.allOk ? '✓ 验证通过' : '✗ 验证未通过') + '(' + sourceDesc + ')</span>\n' + res.text;
}

/* ---------- 设置保存 / 恢复 ---------- */
const SETTINGS_KEY = 'meshConverterSettings';
function collectSettings() {
  return {
    v: 1,
    srcUnit: $('srcUnit').value, dstUnit: $('dstUnit').value,
    srcPreset: $('srcPreset').value, dstPreset: $('dstPreset').value,
    srcCustom: { up: $('srcUp').value, fwd: $('srcFwd').value, handed: $('srcHand').value },
    dstCustom: { up: $('dstUp').value, fwd: $('dstFwd').value, handed: $('dstHand').value },
    pivot: state.pivot, rot: state.rot,
  };
}
function applySettings(s) {
  if (!s) return;
  if (s.srcUnit) $('srcUnit').value = s.srcUnit;
  if (s.dstUnit) $('dstUnit').value = s.dstUnit;
  if (s.srcPreset) $('srcPreset').value = s.srcPreset;
  if (s.dstPreset) $('dstPreset').value = s.dstPreset;
  if (s.srcCustom) { $('srcUp').value = s.srcCustom.up; $('srcFwd').value = s.srcCustom.fwd; $('srcHand').value = s.srcCustom.handed; }
  if (s.dstCustom) { $('dstUp').value = s.dstCustom.up; $('dstFwd').value = s.dstCustom.fwd; $('dstHand').value = s.dstCustom.handed; }
  if (s.rot) { state.rot = s.rot.slice(0, 3); $('rx').value = s.rot[0]; $('ry').value = s.rot[1]; $('rz').value = s.rot[2]; }
  if (s.pivot) {
    state.pivot = { mode: s.pivot.mode || 'center', vertex: s.pivot.vertex | 0 };
    const r = document.querySelector('input[name=pivot][value="' + state.pivot.mode + '"]');
    if (r) r.checked = true;
    $('pivotVert').textContent = state.pivot.mode === 'vertex' ? '#' + state.pivot.vertex : '#-';
  }
  syncCustomVisibility();
  recompute();
}
function syncCustomVisibility() {
  $('srcCustom').style.display = $('srcPreset').value === 'custom' ? 'block' : 'none';
  $('dstCustom').style.display = $('dstPreset').value === 'custom' ? 'block' : 'none';
}

/* ---------- 交互:相机与顶点拾取 ---------- */
let drag = null;
canvas.addEventListener('mousedown', e => {
  drag = { x: e.clientX, y: e.clientY, btn: e.button, moved: 0 };
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.btn === 0 && !drag.shiftKey) {
    cam.theta += dx * 0.008;
    cam.phi = Math.max(-1.5, Math.min(1.5, cam.phi + dy * 0.008));
  } else { // 右键或 Shift+左键:平移
    cam.pan[0] -= dx * 0.0016;
    cam.pan[1] += dy * 0.0016;
  }
});
window.addEventListener('mouseup', e => {
  if (drag && drag.moved < 4 && drag.btn === 0) pickVertex(e);
  drag = null;
});
canvas.addEventListener('wheel', e => {
  cam.zoom = Math.max(0.05, Math.min(40, cam.zoom * Math.exp(e.deltaY * 0.001)));
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function pickVertex(e) {
  if (!state.mesh) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const view = x < cssW / 2 ? 0 : 1;
  const vp = lastVP[view];
  if (!vp) return;
  const vr = viewRect(view, cssW, cssH);
  const mesh = view === 0 ? state.mesh : state.dst;
  let best = -1, bestD = 14; // 像素阈值
  mesh.positions.forEach((p, i) => {
    if (!p.every(isFinite)) return;
    const [cx, cy, cw] = project(vp, p);
    if (cw <= 0) return;
    const sx = vr.x + (cx / cw + 1) / 2 * vr.w;
    const sy = vr.y + (1 - cy / cw) / 2 * vr.h;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    state.pivot = { mode: 'vertex', vertex: best };
    document.querySelector('input[name=pivot][value=vertex]').checked = true;
    $('pivotVert').textContent = '#' + best;
    recompute();
    toast('基准点设为顶点 #' + best + ',旋转将绕该点进行');
  }
}

/* ---------- 初始化 UI ---------- */
function fillSelect(id, items, val) {
  const el = $(id);
  el.innerHTML = items.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');
  el.value = val;
}
function initUI() {
  fillSelect('srcUnit', Object.entries(C.UNITS).map(([k]) => [k, C.UNIT_NAMES[k] + ' (' + k + ')']), 'cm');
  fillSelect('dstUnit', Object.entries(C.UNITS).map(([k]) => [k, C.UNIT_NAMES[k] + ' (' + k + ')']), 'm');
  const presetItems = Object.entries(PRESETS).map(([k, p]) => [k, p.label]);
  fillSelect('srcPreset', presetItems, 'max');
  fillSelect('dstPreset', presetItems, 'unity');
  const axisItems = AXIS_NAMES.map(a => [a, a]);
  fillSelect('srcUp', axisItems, '+Z'); fillSelect('srcFwd', axisItems, '+Y');
  fillSelect('dstUp', axisItems, '+Y'); fillSelect('dstFwd', axisItems, '+Z');
  syncCustomVisibility();

  $('file').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0], loadMesh); });
  $('demo').addEventListener('click', () => {
    // 演示:单位与左右手同时转换 —— 厘米→米、Z-up→Y-up、右手→左手(镜像)
    applySettings({ srcUnit: 'cm', dstUnit: 'm', srcPreset: 'max', dstPreset: 'unity', rot: [0, 0, 0], pivot: { mode: 'center', vertex: 0 } });
    loadMesh(C.makeDemoMesh(), '演示模型');
    toast('演示模型:Z-up→Y-up、厘米→米、右手→左手(镜像)同时转换。注意红色 +X 标记换边、绿色锥朝上、蓝色为独立部件。', 6000);
  });

  ['srcUnit', 'dstUnit', 'srcPreset', 'dstPreset', 'srcUp', 'srcFwd', 'srcHand', 'dstUp', 'dstFwd', 'dstHand']
    .forEach(id => $(id).addEventListener('change', () => { syncCustomVisibility(); recompute(); }));

  document.querySelectorAll('input[name=pivot]').forEach(r => r.addEventListener('change', e => {
    state.pivot.mode = e.target.value;
    recompute();
  }));
  ['rx', 'ry', 'rz'].forEach((id, k) => $(id).addEventListener('input', () => {
    state.rot[k] = parseFloat($(id).value) || 0;
    recompute();
  }));
  $('rotReset').addEventListener('click', () => {
    state.rot = [0, 0, 0];
    $('rx').value = $('ry').value = $('rz').value = 0;
    recompute();
  });
  $('hlBad').addEventListener('change', e => { state.hl = e.target.checked; rebuildMeshBuffers(); });

  $('expObj').addEventListener('click', () => {
    if (!state.dst) return toast('请先载入模型');
    const text = C.toOBJ(state.dst);
    state.lastExportText = text;
    download('converted_' + $('dstUnit').value + '.obj', text);
  });
  $('expStl').addEventListener('click', () => {
    if (!state.dst) return toast('请先载入模型');
    download('converted_' + $('dstUnit').value + '.stl', C.toSTL(state.dst));
  });
  $('expVerify').addEventListener('click', () => {
    if (!state.dst) return toast('请先载入模型');
    const text = C.toOBJ(state.dst);
    state.lastExportText = text;
    download('converted_' + $('dstUnit').value + '.obj', text);
    try {
      verifyMesh(C.parseOBJ(text), '导出文件重新导入');
    } catch (e) { toast('验证失败: ' + e.message); }
  });
  $('verifyFile').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0], m => verifyMesh(m, e.target.files[0].name));
  });

  $('saveSet').addEventListener('click', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(collectSettings()));
    toast('设置已保存到本机,下一批模型打开页面时自动恢复');
  });
  $('dlSet').addEventListener('click', () => download('mesh-converter-settings.json', JSON.stringify(collectSettings(), null, 2), 'application/json'));
  $('loadSet').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { applySettings(JSON.parse(rd.result)); toast('设置已载入'); }
      catch (err) { toast('设置文件无效: ' + err.message); }
    };
    rd.readAsText(f);
  });

  // 拖放载入
  const main = $('main');
  main.addEventListener('dragover', e => e.preventDefault());
  main.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], loadMesh);
  });

  // 启动时恢复本机设置
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (s) applySettings(JSON.parse(s));
  } catch (e) { /* 忽略损坏的存档 */ }
  updateInfo();
}

initUI();
requestAnimationFrame(render);
})();
