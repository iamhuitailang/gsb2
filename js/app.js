/* app.js — 页面交互、WebGL 渲染与拾取 */
'use strict';

// ---------------- 状态 ----------------
const state = {
  name: '',
  meshOriginal: null,
  analysisOriginal: null,
  flipsByComp: new Map(),   // compId -> [faceId...]（均针对原始模型计算）
  refFaceByComp: new Map(), // compId -> faceId（开口片参考面）
  meshFixed: null,
  analysisFixed: null,
  view: 'original',         // 'original' | 'fixed'
  colorMode: 'facing',      // 'facing' | 'component'
  show: { boundary: true, nm: true, coincident: true, zero: true },
  selComp: -1,
  selEdgeKey: null,
  selFace: -1,
  pickMode: 'edge',
  refPickArmed: false,
};

const curMesh = () =>
  state.view === 'fixed' && state.meshFixed ? state.meshFixed : state.meshOriginal;
const curAnalysis = () =>
  state.view === 'fixed' && state.analysisFixed ? state.analysisFixed : state.analysisOriginal;

// ---------------- 日志 / 信息面板 ----------------
const $ = (id) => document.getElementById(id);
function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function setInfo(text) { $('info').textContent = text; }

// ---------------- 矩阵/向量 ----------------
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}
function lookAt(eye, c, up) {
  let z = norm3(sub3(eye, c));
  let x = norm3(cross3(up, z));
  let y = cross3(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ];
}
function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function invert4(m) {
  // 列主序 4x4 求逆（gl-matrix 实现）
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3];
  const a10=m[4],a11=m[5],a12=m[6],a13=m[7];
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11];
  const a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return null;
  det = 1 / det;
  return [
    (a11*b11 - a12*b10 + a13*b09) * det,
    (a02*b10 - a01*b11 - a03*b09) * det,
    (a31*b05 - a32*b04 + a33*b03) * det,
    (a22*b04 - a21*b05 - a23*b03) * det,
    (a12*b08 - a10*b11 - a13*b07) * det,
    (a00*b11 - a02*b08 + a03*b07) * det,
    (a32*b02 - a30*b05 - a33*b01) * det,
    (a20*b05 - a22*b02 + a23*b01) * det,
    (a10*b10 - a11*b08 + a13*b06) * det,
    (a01*b08 - a00*b10 - a03*b06) * det,
    (a30*b04 - a31*b02 + a33*b00) * det,
    (a21*b02 - a20*b04 - a23*b00) * det,
    (a11*b07 - a10*b09 - a12*b06) * det,
    (a00*b09 - a01*b07 + a02*b06) * det,
    (a31*b01 - a30*b03 - a32*b00) * det,
    (a20*b03 - a21*b01 + a22*b00) * det,
  ];
}
function xform4(m, v) {
  const [x, y, z, w] = v;
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12]*w,
    m[1]*x + m[5]*y + m[9]*z + m[13]*w,
    m[2]*x + m[6]*y + m[10]*z + m[14]*w,
    m[3]*x + m[7]*y + m[11]*z + m[15]*w,
  ];
}
const sub3 = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add3 = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scale3 = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };

// ---------------- WebGL 初始化 ----------------
const canvas = $('gl');
const gl = canvas.getContext('webgl', { antialias: true });
if (!gl) { setInfo('当前浏览器不支持 WebGL'); throw new Error('no webgl'); }

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aColor;
attribute float aDim; attribute float aHi;
uniform mat4 uMVP;
varying vec3 vN; varying vec3 vC; varying float vDim; varying float vHi;
void main(){
  gl_Position = uMVP * vec4(aPos, 1.0);
  vN = aNrm; vC = aColor; vDim = aDim; vHi = aHi;
  gl_PointSize = 9.0;
}`;
const FS = `
precision mediump float;
varying vec3 vN; varying vec3 vC; varying float vDim; varying float vHi;
uniform float uMode; // 0=正反面 1=连通块 2=线条/点(无光照)
void main(){
  vec3 base;
  if (uMode < 0.5)      base = gl_FrontFacing ? vec3(0.32,0.72,0.45) : vec3(0.88,0.32,0.28);
  else if (uMode < 1.5) base = vC * (gl_FrontFacing ? 1.0 : 0.4);
  else                  base = vC;
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float lit = uMode > 1.5 ? 1.0 : 0.38 + 0.62 * abs(dot(n, normalize(vec3(0.4,0.7,0.55))));
  vec3 col = base * lit;
  col = mix(col, vec3(1.0,0.85,0.2), clamp(vHi,0.0,1.0)*0.7);
  col = mix(col, col*0.3 + vec3(0.04), clamp(vDim,0.0,1.0));
  gl_FragColor = vec4(col, 1.0);
}`;
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
  throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const A = {
  pos: gl.getAttribLocation(prog, 'aPos'),
  nrm: gl.getAttribLocation(prog, 'aNrm'),
  color: gl.getAttribLocation(prog, 'aColor'),
  dim: gl.getAttribLocation(prog, 'aDim'),
  hi: gl.getAttribLocation(prog, 'aHi'),
};
const U = {
  mvp: gl.getUniformLocation(prog, 'uMVP'),
  mode: gl.getUniformLocation(prog, 'uMode'),
};
gl.enableVertexAttribArray(A.pos);
gl.enableVertexAttribArray(A.nrm);
gl.enableVertexAttribArray(A.color);
gl.enableVertexAttribArray(A.dim);
gl.enableVertexAttribArray(A.hi);

const PALETTE = [
  [0.42,0.65,0.88],[0.88,0.58,0.32],[0.48,0.76,0.46],[0.78,0.48,0.72],
  [0.58,0.58,0.84],[0.84,0.74,0.38],[0.42,0.72,0.72],[0.74,0.54,0.44],
];

// 交错顶点缓冲: pos(3) nrm(3) color(3) dim(1) hi(1) = 11 floats
let meshBuf = gl.createBuffer();
let meshVertCount = 0;
let lineBuf = gl.createBuffer();
let lineVertCount = 0;
let pointBuf = gl.createBuffer();
let pointVertCount = 0;

function bindAndAttrib(buf) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const S = 44;
  gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, S, 0);
  gl.vertexAttribPointer(A.nrm, 3, gl.FLOAT, false, S, 12);
  gl.vertexAttribPointer(A.color, 3, gl.FLOAT, false, S, 24);
  gl.vertexAttribPointer(A.dim, 1, gl.FLOAT, false, S, 36);
  gl.vertexAttribPointer(A.hi, 1, gl.FLOAT, false, S, 40);
}
function pushVert(arr, p, n, c, dim, hi) {
  arr.push(p[0],p[1],p[2], n[0],n[1],n[2], c[0],c[1],c[2], dim, hi);
}

function faceCompMap(analysis) {
  const map = new Array(curMesh().faces.length).fill(-1);
  for (const c of analysis.components)
    for (const f of c.faceIds) map[f] = c.id;
  return map;
}

function rebuildBuffers() {
  const mesh = curMesh();
  const an = curAnalysis();
  if (!mesh || !an) { meshVertCount = lineVertCount = pointVertCount = 0; return; }
  const f2c = faceCompMap(an);
  const compSet = state.selComp >= 0;

  // 三角面
  const arr = [];
  mesh.faces.forEach((f, fi) => {
    const ci = f2c[fi];
    const col = PALETTE[(ci >= 0 ? ci : 0) % PALETTE.length];
    const n = an.faceNormal[fi];
    const dim = compSet && ci !== state.selComp ? 0.65 : 0;
    let hi = 0;
    if (fi === state.selFace) hi = 1;
    else if (compSet && ci === state.selComp) hi = 0.22;
    for (let k = 0; k < 3; k++)
      pushVert(arr, mesh.positions[f.v[k]], n, col, dim, hi);
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
  meshVertCount = arr.length / 11;
  rebuildOverlay();
}

function rebuildOverlay() {
  const mesh = curMesh();
  const an = curAnalysis();
  if (!mesh || !an) return;
  const P = mesh.positions;
  const lines = [];
  const pts = [];
  const N0 = [0, 0, 1];
  const line = (a, b, c) => { pushVert(lines, a, N0, c, 0, 0); pushVert(lines, b, N0, c, 0, 0); };
  const pt = (p, c) => pushVert(pts, p, N0, c, 0, 0);

  if (state.show.boundary)
    for (const e of an.boundaryEdges) line(P[e.a], P[e.b], [1.0, 0.62, 0.1]);
  if (state.show.nm)
    for (const e of an.nonManifoldEdges) line(P[e.a], P[e.b], [1.0, 0.1, 0.85]);
  if (state.show.coincident)
    for (const g of an.coincidentVertices) pt(g.position, [1.0, 0.9, 0.1]);
  if (state.show.zero)
    for (const fi of an.zeroAreaFaces) {
      const f = mesh.faces[fi];
      const c = scale3(add3(add3(P[f.v[0]], P[f.v[1]]), P[f.v[2]]), 1 / 3);
      pt(c, [1.0, 0.15, 0.1]);
    }
  if (state.selEdgeKey) {
    const e = an.edges.find((x) => MeshCore.edgeKey(x) === state.selEdgeKey);
    if (e) {
      line(P[e.a], P[e.b], [0.1, 1.0, 1.0]);
      pt(P[e.a], [0.1, 1.0, 1.0]);
      pt(P[e.b], [0.1, 1.0, 1.0]);
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
  lineVertCount = lines.length / 11;
  gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
  pointVertCount = pts.length / 11;
}

// ---------------- 相机 ----------------
const cam = { theta: 0.8, phi: 0.6, dist: 5, target: [0, 0, 0] };
function fitCamera() {
  const an = curAnalysis();
  const mesh = curMesh();
  if (!mesh || !mesh.positions.length) return;
  const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
  for (const p of mesh.positions)
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
  cam.target = scale3(add3(mn, mx), 0.5);
  cam.dist = Math.max(an.diag * 1.9, 1e-3);
}
function camEye() {
  const { theta, phi, dist, target } = cam;
  const cp = Math.cos(phi);
  return add3(target, [
    dist * cp * Math.cos(theta),
    dist * Math.sin(phi),
    dist * cp * Math.sin(theta),
  ]);
}
function viewProj() {
  const aspect = canvas.width / Math.max(canvas.height, 1);
  const near = Math.max(cam.dist / 100, 1e-4);
  const far = cam.dist * 100 + 10;
  return mul4(perspective(0.8, aspect, near, far), lookAt(camEye(), cam.target, [0, 1, 0]));
}

// ---------------- 绘制 ----------------
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.11, 0.12, 0.14, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const mvp = viewProj();
  gl.uniformMatrix4fv(U.mvp, false, new Float32Array(mvp));

  if (meshVertCount) {
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.uniform1f(U.mode, state.colorMode === 'facing' ? 0 : 1);
    bindAndAttrib(meshBuf);
    gl.drawArrays(gl.TRIANGLES, 0, meshVertCount);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  gl.uniform1f(U.mode, 2);
  if (lineVertCount) { bindAndAttrib(lineBuf); gl.drawArrays(gl.LINES, 0, lineVertCount); }
  if (pointVertCount) { bindAndAttrib(pointBuf); gl.drawArrays(gl.POINTS, 0, pointVertCount); }
  requestAnimationFrame(draw);
}

// ---------------- 拾取 ----------------
function pickRay(mx, my) {
  const r = canvas.getBoundingClientRect();
  const nx = ((mx - r.left) / r.width) * 2 - 1;
  const ny = -(((my - r.top) / r.height) * 2 - 1);
  const inv = invert4(viewProj());
  if (!inv) return null;
  const p0 = xform4(inv, [nx, ny, -1, 1]);
  const p1 = xform4(inv, [nx, ny, 1, 1]);
  const a = scale3(p0.slice(0, 3), 1 / p0[3]);
  const b = scale3(p1.slice(0, 3), 1 / p1[3]);
  return { ro: a, rd: norm3(sub3(b, a)) };
}

function pickFace(ray) {
  const mesh = curMesh();
  const P = mesh.positions;
  let best = null;
  mesh.faces.forEach((f, fi) => {
    const a = P[f.v[0]], b = P[f.v[1]], c = P[f.v[2]];
    const e1 = sub3(b, a), e2 = sub3(c, a);
    const p = cross3(ray.rd, e2);
    const det = dot3(e1, p);
    if (Math.abs(det) < 1e-14) return;
    const inv = 1 / det;
    const t = sub3(ray.ro, a);
    const u = dot3(t, p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return;
    const q = cross3(t, e1);
    const v = dot3(ray.rd, q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return;
    const tt = dot3(e2, q) * inv;
    if (tt > 0 && (!best || tt < best.t)) best = { face: fi, t: tt };
  });
  return best;
}

// 射线与线段最近距离（Ericson 线段-线段最近点）
function raySegDist(ro, rd, p0, p1) {
  const d2 = sub3(p1, p0);
  const r = sub3(ro, p0);
  const a = dot3(rd, rd), e = dot3(d2, d2), f = dot3(d2, r), c = dot3(rd, r), b = dot3(rd, d2);
  const denom = a * e - b * b;
  let s = denom > 1e-12 ? (b * f - c * e) / denom : 0; // 射线参数
  let t = e > 1e-12 ? (a * f - b * c) / denom : 0;     // 线段参数
  t = Math.max(0, Math.min(1, t));
  s = (b * t - c) / a;
  if (s < 0) { s = 0; t = e > 1e-12 ? Math.max(0, Math.min(1, f / e)) : 0; }
  const pr = add3(ro, scale3(rd, s));
  const ps = add3(p0, scale3(d2, t));
  const d = Math.hypot(...sub3(pr, ps));
  return { s, d };
}

function pickEdge(ray) {
  const mesh = curMesh();
  const an = curAnalysis();
  const P = mesh.positions;
  const thresh = an.diag * 0.015;
  let best = null;
  for (const e of an.edges) {
    const { s, d } = raySegDist(ray.ro, ray.rd, P[e.a], P[e.b]);
    if (d < thresh && s > 0 && (!best || s < best.s)) best = { edge: e, s };
  }
  return best;
}

// ---------------- 面板刷新 ----------------
function compOfFace(fid) {
  for (const c of curAnalysis().components)
    if (c.faceIds.includes(fid)) return c.id;
  return -1;
}

function refreshPanels() {
  const mesh = curMesh();
  const an = curAnalysis();
  if (!mesh) return;
  $('stat').textContent =
    `${state.name}  v=${mesh.positions.length} vt=${mesh.uvs.length} f=${mesh.faces.length}` +
    (state.view === 'fixed' ? '  [修复后]' : '  [原始]');

  // 连通块
  const comps = $('comps');
  comps.innerHTML = '';
  for (const c of an.components) {
    const div = document.createElement('div');
    div.className = 'item' + (c.id === state.selComp ? ' sel' : '');
    const fixedMark = state.flipsByComp.has(c.id) ? ' ✓已修' : '';
    let status, cls;
    if (c.closed) {
      status = c.orientation === 'outward' ? '闭合·朝外' : '闭合·朝里';
      cls = c.orientation === 'outward' ? 'ok' : 'warn-t';
    } else {
      status = `开口·${c.boundaryEdges.length}条开口边`;
      cls = 'warn-t';
    }
    if (c.nonManifoldEdges.length) { status += ' ⚠非流形'; cls = 'bad'; }
    if (c.zeroAreaFaces.length) { status += ' ⚠零面积'; cls = 'bad'; }
    div.innerHTML = `块 #${c.id}（${c.faceCount} 面）<span class="tag ${cls}">${status}${fixedMark}</span>`;
    div.onclick = () => { state.selComp = c.id; refreshPanels(); rebuildBuffers(); };
    comps.appendChild(div);
  }

  // 问题
  const issues = $('issues');
  issues.innerHTML = '';
  const addIssue = (text, cls, onclick) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span class="${cls}">${text}</span>`;
    div.onclick = onclick;
    issues.appendChild(div);
  };
  for (const e of an.nonManifoldEdges)
    addIssue(`非流形边 v${e.a}–v${e.b}（${e.faces.length} 面共用）`, 'bad', () => selectEdge(e));
  for (const fi of an.zeroAreaFaces)
    addIssue(`零面积面 #${fi}`, 'bad', () => { state.selFace = fi; showFaceInfo(fi); refreshPanels(); rebuildBuffers(); });
  for (const g of an.coincidentVertices)
    addIssue(`重合未连接顶点 ${g.indices.map((i) => 'v' + i).join(', ')}`, 'bad', () => {});
  for (const e of an.boundaryEdges)
    addIssue(`开口边 v${e.a}–v${e.b}`, 'warn-t', () => selectEdge(e));
  if (!issues.children.length)
    issues.innerHTML = '<div class="item ok">无问题</div>';
}

function selectEdge(e) {
  state.selEdgeKey = MeshCore.edgeKey(e);
  showEdgeInfo(e);
  refreshPanels();
  rebuildBuffers();
}

function showEdgeInfo(e) {
  const mesh = curMesh();
  const an = curAnalysis();
  const lines = [`边 v${e.a} – v${e.b}（${e.faces.length} 个相邻面）`];
  if (e.faces.length === 1) lines.push('⚠ 开口边：只有一侧有面');
  if (e.faces.length >= 3) lines.push('⚠ 非法：三个及以上面共用一条边');
  const dirs = e.faces.map((x) => x.dir);
  const consistent = e.faces.length === 2 && dirs[0] !== dirs[1];
  for (const x of e.faces) {
    const dirText = x.dir > 0 ? `v${e.a} → v${e.b}` : `v${e.b} → v${e.a}`;
    lines.push(`  面 #${x.f}（块 #${compOfFace(x.f)}）沿边方向: ${dirText}`);
  }
  if (e.faces.length === 2)
    lines.push(consistent ? '✓ 两面绕向一致（沿边反向）' : '✗ 两面绕向冲突（沿边同向）');
  setInfo(lines.join('\n'));
}

function showFaceInfo(fi) {
  const mesh = curMesh();
  const f = mesh.faces[fi];
  const an = curAnalysis();
  const n = an.faceNormal[fi];
  setInfo(
    `面 #${fi}（块 #${compOfFace(fi)}）\n` +
    `顶点: ${f.v.map((v) => 'v' + v).join(', ')}\n` +
    `UV:   ${f.vt.map((t) => (t >= 0 ? 'vt' + t : '无')).join(', ')}\n` +
    `法线: (${n.map((x) => x.toFixed(3)).join(', ')})\n` +
    `面积: ${an.faceArea[fi].toExponential(3)}`
  );
}

// ---------------- 模型加载 ----------------
function loadModel(text, name) {
  try {
    const mesh = MeshCore.parseOBJ(text);
    if (!mesh.faces.length) { log('未解析到任何面', 'bad'); return; }
    state.name = name;
    state.meshOriginal = mesh;
    state.analysisOriginal = MeshCore.analyze(mesh);
    state.flipsByComp.clear();
    state.refFaceByComp.clear();
    state.meshFixed = null;
    state.analysisFixed = null;
    state.view = 'original';
    state.selComp = -1;
    state.selEdgeKey = null;
    state.selFace = -1;
    fitCamera();
    refreshPanels();
    rebuildBuffers();
    updateButtons();
    const an = state.analysisOriginal;
    log(`已加载 ${name}: ${mesh.faces.length} 面, ${an.components.length} 个连通块, ` +
        `${an.boundaryEdges.length} 开口边, ${an.nonManifoldEdges.length} 非流形边, ` +
        `${an.zeroAreaFaces.length} 零面积面, ${an.coincidentVertices.length} 组重合顶点`);
  } catch (err) {
    log('解析失败: ' + err.message, 'bad');
  }
}

// ---------------- 修复 ----------------
function recomputeFixed() {
  let all = [];
  for (const flips of state.flipsByComp.values()) all = all.concat(flips);
  if (!all.length) { state.meshFixed = null; state.analysisFixed = null; return; }
  state.meshFixed = MeshCore.applyFlips(state.meshOriginal, all);
  state.analysisFixed = MeshCore.analyze(state.meshFixed);
}

function fixSelected() {
  if (state.selComp < 0) { log('请先在右侧选择一个连通块', 'bad'); return; }
  const an = state.analysisOriginal;
  const comp = an.components[state.selComp];
  let ref = null;
  if (!comp.closed) {
    ref = state.refFaceByComp.get(comp.id);
    if (ref == null) {
      state.refPickArmed = true;
      log(`块 #${comp.id} 是开口片，无法自动判断外侧：请在模型上单击一个面作为参考面（保持其当前朝向）`, 'warn-t');
      return;
    }
  }
  const r = MeshCore.unifyComponent(state.meshOriginal, an, comp.id, ref);
  if (r.needsReference) { log('需要参考面', 'bad'); return; }
  state.flipsByComp.set(comp.id, r.flips);
  recomputeFixed();
  let msg = `块 #${comp.id}: 翻转 ${r.flips.length} 个面`;
  if (r.unreached.length) msg += `；${r.unreached.length} 个面被非流形结构隔开，未处理`;
  if (r.skippedZeroArea.length) msg += `；跳过零面积面 ${r.skippedZeroArea.length} 个`;
  log(msg, r.unreached.length ? 'warn-t' : 'ok');
  state.view = 'fixed';
  refreshPanels();
  rebuildBuffers();
  updateButtons();
}

function updateButtons() {
  const hasFix = state.meshFixed != null;
  $('btnViewFixed').disabled = !hasFix;
  $('btnUndo').disabled = !hasFix;
  $('btnViewOrig').classList.toggle('active', state.view === 'original');
  $('btnViewFixed').classList.toggle('active', state.view === 'fixed');
}

// ---------------- 导出 / 自检 ----------------
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportMesh() { return state.meshFixed || state.meshOriginal; }
function exportAnalysis() { return state.meshFixed ? state.analysisFixed : state.analysisOriginal; }

function baseName() { return (state.name || 'model').replace(/\.obj$/i, ''); }

function doExportOBJ() {
  if (!state.meshOriginal) return;
  download(baseName() + (state.meshFixed ? '.fixed.obj' : '.obj'),
    MeshCore.serializeOBJ(exportMesh()));
  log('已导出 OBJ（保留每个面角的 UV）', 'ok');
}
function doExportReport() {
  if (!state.meshOriginal) return;
  let flips = [];
  for (const f of state.flipsByComp.values()) flips = flips.concat(f);
  const report = MeshCore.makeReport(exportMesh(), exportAnalysis(), {
    source: state.name,
    flippedFaces: flips,
  });
  download(baseName() + '.report.json', JSON.stringify(report, null, 1));
  log('已导出报告 JSON', 'ok');
}
function doSelfCheck() {
  if (!state.meshOriginal) return;
  const mesh = exportMesh();
  const text = MeshCore.serializeOBJ(mesh);
  const reparsed = MeshCore.parseOBJ(text);           // 读回
  const report = MeshCore.makeReport(mesh, exportAnalysis());
  const results = MeshCore.verifyAgainstReport(reparsed, report);
  log(`— 读回自检（${state.meshFixed ? '修复后' : '原始'}模型）—`);
  for (const r of results)
    log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? '  ' + r.detail : ''}`, r.pass ? 'ok' : 'bad');
}

// ---------------- 事件 ----------------
let drag = null;
canvas.addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, y: e.clientY, btn: e.button, moved: false, shift: e.shiftKey };
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.btn === 2 || drag.shift) {
    // 平移
    const eye = camEye();
    const fwd = norm3(sub3(cam.target, eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const k = cam.dist * 0.0016;
    cam.target = add3(cam.target, add3(scale3(right, -dx * k), scale3(up, dy * k)));
  } else {
    cam.theta += dx * 0.008;
    cam.phi = Math.max(-1.5, Math.min(1.5, cam.phi + dy * 0.008));
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (drag && !drag.moved && drag.btn === 0 && e.target === canvas) onClick(e);
  drag = null;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.max(1e-3, cam.dist * Math.exp(e.deltaY * 0.001));
}, { passive: false });

function onClick(e) {
  if (!state.meshOriginal) return;
  const ray = pickRay(e.clientX, e.clientY);
  if (!ray) return;
  if (state.refPickArmed || state.pickMode === 'face') {
    const hit = pickFace(ray);
    if (!hit) return;
    state.selFace = hit.face;
    if (state.refPickArmed) {
      const cid = compOfFace(hit.face);
      state.refFaceByComp.set(cid, hit.face);
      state.selComp = cid;
      state.refPickArmed = false;
      log(`已选面 #${hit.face} 作为块 #${cid} 的参考面，点击"统一并修复选中块"继续`, 'ok');
    }
    showFaceInfo(hit.face);
  } else {
    const hit = pickEdge(ray);
    if (!hit) { state.selEdgeKey = null; setInfo('未选中'); }
    else selectEdge(hit.edge);
  }
  refreshPanels();
  rebuildBuffers();
}

// ---------------- UI 绑定 ----------------
$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => loadModel(String(rd.result), f.name);
  rd.readAsText(f);
});
for (const name of Object.keys(EXAMPLE_MODELS)) {
  const b = document.createElement('button');
  b.textContent = name.replace('.obj', '');
  b.onclick = () => loadModel(EXAMPLE_MODELS[name], name);
  $('examples').appendChild(b);
}
document.querySelectorAll('input[name=cmode]').forEach((r) =>
  r.addEventListener('change', () => { state.colorMode = r.value; rebuildBuffers(); }));
document.querySelectorAll('input[name=pick]').forEach((r) =>
  r.addEventListener('change', () => { state.pickMode = r.value; }));
const bindShow = (id, key) =>
  $(id).addEventListener('change', () => { state.show[key] = $(id).checked; rebuildBuffers(); });
bindShow('showBoundary', 'boundary');
bindShow('showNM', 'nm');
bindShow('showCoincident', 'coincident');
bindShow('showZero', 'zero');

$('btnFix').onclick = fixSelected;
$('btnRef').onclick = () => {
  if (state.selComp < 0) { log('请先选择连通块', 'bad'); return; }
  state.refPickArmed = true;
  log('请在模型上单击一个面作为参考面', 'warn-t');
};
$('btnViewOrig').onclick = () => { state.view = 'original'; refreshPanels(); rebuildBuffers(); updateButtons(); };
$('btnViewFixed').onclick = () => {
  if (!state.meshFixed) return;
  state.view = 'fixed'; refreshPanels(); rebuildBuffers(); updateButtons();
};
$('btnUndo').onclick = () => {
  state.flipsByComp.clear();
  state.refFaceByComp.clear();
  state.meshFixed = null;
  state.analysisFixed = null;
  state.view = 'original';
  refreshPanels(); rebuildBuffers(); updateButtons();
  log('已取消全部修复，恢复原始模型与报告', 'warn-t');
};
$('btnExport').onclick = doExportOBJ;
$('btnReport').onclick = doExportReport;
$('btnSelfCheck').onclick = doSelfCheck;

// 拖放加载
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => loadModel(String(rd.result), f.name);
  rd.readAsText(f);
});

// 默认加载演示模型
if (EXAMPLE_MODELS['demo_all.obj']) loadModel(EXAMPLE_MODELS['demo_all.obj'], 'demo_all.obj');
requestAnimationFrame(draw);
