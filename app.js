'use strict';
/* 像素放大对照台
 * A = 直接复制像素（最近邻）
 * B = 保留斜边转折（EPX / Scale2x 规则，任意整数倍）
 * 两种方式都只从原图取色，绝不混色；透明像素统一视为“空”，不会被当成颜色涂进图案。
 */

/* ==================== 纯算法（可在 node 中测试） ==================== */

function eq4(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// 取像素；越界与全透明都归一化为“空”[0,0,0,0]，不参与颜色比较
function makeGetter(img) {
  const { w, h, data } = img;
  return function getP(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0, 0];
    const i = (y * w + x) * 4;
    const a = data[i + 3];
    if (a === 0) return [0, 0, 0, 0];
    return [data[i], data[i + 1], data[i + 2], a];
  };
}

function colorKey(c) { return c[0] + ',' + c[1] + ',' + c[2] + ',' + c[3]; }

function buildPalette(img) {
  const getP = makeGetter(img);
  const map = new Map();
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const c = getP(x, y);
      map.set(colorKey(c), c);
    }
  return map; // key -> [r,g,b,a]
}

// EPX 四象限取色，返回 [{c, from}]，from 用于界面解释来源
function epxSources(getP, x, y) {
  const E = getP(x, y);
  const B = getP(x, y - 1), D = getP(x - 1, y);
  const F = getP(x + 1, y), H = getP(x, y + 1);
  const q = [{ c: E, from: '自身' }, { c: E, from: '自身' },
             { c: E, from: '自身' }, { c: E, from: '自身' }];
  if (eq4(D, B) && !eq4(B, F) && !eq4(D, H)) q[0] = { c: D, from: '左(=上)' };
  if (eq4(B, F) && !eq4(B, D) && !eq4(F, H)) q[1] = { c: F, from: '右(=上)' };
  if (eq4(D, H) && !eq4(D, B) && !eq4(H, F)) q[2] = { c: D, from: '左(=下)' };
  if (eq4(H, F) && !eq4(D, H) && !eq4(B, F)) q[3] = { c: F, from: '右(=下)' };
  return q;
}

function inRegions(regions, x, y) {
  for (const r of regions)
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true;
  return false;
}

function snapToPalette(c, paletteList) {
  let best = paletteList[0], bd = Infinity;
  for (const p of paletteList) {
    const dr = c[0] - p[0], dg = c[1] - p[1], db = c[2] - p[2], da = c[3] - p[3];
    const d = dr * dr + dg * dg + db * db + da * da * 2; // 透明度权重加倍，半透明边不会被拉成不透明
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// 计算两种输出。返回 { outA, outB, outW, outH, diffMask, diffCount, violations, palette }
function computeOutputs(img, scale, regions, paletteLock) {
  const N = scale, W = img.w, H = img.h;
  const outW = W * N, outH = H * N;
  const getP = makeGetter(img);
  const palette = buildPalette(img);
  const paletteList = [...palette.values()];
  const outA = new Uint8ClampedArray(outW * outH * 4);
  const outB = new Uint8ClampedArray(outW * outH * 4);
  const diffMask = new Uint8Array(outW * outH);
  let diffCount = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const E = getP(x, y);
    let q;
    if (inRegions(regions, x, y)) q = [E, E, E, E]; // 保护区：直接放大
    else q = epxSources(getP, x, y).map(s => s.c);
    if (paletteLock) q = q.map(c => palette.has(colorKey(c)) ? c : snapToPalette(c, paletteList));
    for (let dy = 0; dy < N; dy++) for (let dx = 0; dx < N; dx++) {
      const qi = (dx * 2 >= N ? 1 : 0) + (dy * 2 >= N ? 2 : 0);
      const op = (y * N + dy) * outW + (x * N + dx);
      const oi = op * 4;
      outA[oi] = E[0]; outA[oi + 1] = E[1]; outA[oi + 2] = E[2]; outA[oi + 3] = E[3];
      const c = q[qi];
      outB[oi] = c[0]; outB[oi + 1] = c[1]; outB[oi + 2] = c[2]; outB[oi + 3] = c[3];
      if (outA[oi] !== c[0] || outA[oi + 1] !== c[1] || outA[oi + 2] !== c[2] || outA[oi + 3] !== c[3]) {
        diffMask[op] = 1; diffCount++;
      }
    }
  }
  // 调色板校验：输出 B 中不允许出现原图没有的颜色
  let violations = 0;
  for (let i = 0; i < outW * outH; i++) {
    const oi = i * 4;
    if (!palette.has(outB[oi] + ',' + outB[oi + 1] + ',' + outB[oi + 2] + ',' + outB[oi + 3])) violations++;
  }
  return { outA, outB, outW, outH, diffMask, diffCount, violations, palette };
}

// 特征像素分类：细线 / 尖角 / 挖空 / 半透明边缘
function classifyPixels(img) {
  const getP = makeGetter(img);
  const res = { thin: [], corner: [], hollow: [], semi: [] };
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const c = getP(x, y);
    if (c[3] > 0 && c[3] < 255) res.semi.push([x, y]);
    const L = getP(x - 1, y), R = getP(x + 1, y), U = getP(x, y - 1), D = getP(x, y + 1);
    if (c[3] === 0) {
      if (L[3] > 0 && R[3] > 0 && U[3] > 0 && D[3] > 0) res.hollow.push([x, y]); // 四周被围住的空洞
      continue;
    }
    const sL = eq4(c, L), sR = eq4(c, R), sU = eq4(c, U), sD = eq4(c, D);
    if ((!sL && !sR) || (!sU && !sD)) res.thin.push([x, y]); // 某一方向两侧都接不上 → 细线
    if ([sL, sR, sU, sD].filter(Boolean).length <= 1) res.corner.push([x, y]); // 同类邻居 ≤1 → 尖角/端点
  }
  return res;
}

// 保护区边界两侧各 1 像素宽的“接缝”源像素
function seamMask(img, regions) {
  const m = new Uint8Array(img.w * img.h);
  if (!regions.length) return m;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const inR = inRegions(regions, x, y);
    for (let dy = -1; dy <= 1 && !m[y * img.w + x]; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (inRegions(regions, x + dx, y + dy) !== inR) { m[y * img.w + x] = 1; break; }
      }
  }
  return m;
}

/* ==================== 自带样例 ==================== */

function blankImg(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }
function putPx(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
}

// 样例1：断点斜线 vs 连续斜线、细线、尖角、挖空、空心框
function makeSample1() {
  const img = blankImg(36, 30);
  const INK = [43, 43, 58, 255], RED = [224, 62, 62, 255], BLUE = [64, 120, 224, 255],
        GREEN = [58, 178, 102, 255], ORANGE = [238, 150, 50, 255], CLEAR = [0, 0, 0, 0];
  for (let i = 0; i < 14; i++) if (i % 4 !== 3) putPx(img, 2 + i, 2 + i, INK);   // 断点斜线
  for (let i = 0; i < 14; i++) putPx(img, 20 + i, 2 + i, RED);                    // 连续斜线
  for (let x = 2; x <= 16; x++) putPx(img, x, 24, INK);                           // 细横线
  putPx(img, 8, 23, INK);                                                         // 线上突起（尖角）
  for (let y = 16; y <= 27; y++) putPx(img, 33, y, BLUE);                         // 细竖线
  for (let i = 0; i <= 5; i++) putPx(img, 20 + i, 18 + i, ORANGE);                // 尖角左臂
  for (let i = 1; i <= 6; i++) putPx(img, 25 + i, 23 - i, ORANGE);                // 尖角右臂
  for (let y = 16; y <= 22; y++) for (let x = 2; x <= 9; x++) putPx(img, x, y, GREEN); // 实心块
  putPx(img, 4, 18, CLEAR); putPx(img, 7, 21, CLEAR);                             // 挖空
  for (let x = 12; x <= 17; x++) { putPx(img, x, 15, BLUE); putPx(img, x, 20, BLUE); } // 空心框
  for (let y = 15; y <= 20; y++) { putPx(img, 12, y, BLUE); putPx(img, 17, y, BLUE); }
  return { img, name: '样例-断点连线' };
}

// 样例2：带半透明边缘的圆形图标
function makeSample2() {
  const img = blankImg(16, 16);
  const GOLD = [240, 180, 60];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d <= 4.6) putPx(img, x, y, [GOLD[0], GOLD[1], GOLD[2], 255]);
    else if (d <= 5.6) putPx(img, x, y, [GOLD[0], GOLD[1], GOLD[2], 128]);
    else if (d <= 6.3) putPx(img, x, y, [GOLD[0], GOLD[1], GOLD[2], 70]);
  }
  putPx(img, 5, 5, [255, 255, 255, 230]);
  putPx(img, 6, 5, [255, 255, 255, 160]);
  putPx(img, 5, 6, [255, 255, 255, 160]);
  return { img, name: '样例-透明边缘图标' };
}

// 样例3：箭头光标（长斜边 + 尖角）
function makeSample3() {
  const rows = [
    'X...........',
    'XX..........',
    'XOX.........',
    'XOOX........',
    'XOOOX.......',
    'XOOOOX......',
    'XOOOOOX.....',
    'XOOOOOOX....',
    'XOOOOOOOX...',
    'XOOOOOXX....',
    'XOOXX.......',
    'XOX.X.......',
    'XX..X.......',
    'X....X......',
    '.....X......',
  ];
  const img = blankImg(12, rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'X') putPx(img, x, y, [30, 30, 40, 255]);
      else if (row[x] === 'O') putPx(img, x, y, [245, 245, 250, 255]);
    }
  });
  return { img, name: '样例-箭头光标' };
}

/* ==================== UI ==================== */

const LS_KEY = 'pixup.v1';

const state = {
  img: null, name: '', dataURL: null,
  scale: 3, mode: 'split', grid: true, paletteLock: true,
  regions: [],
  inspect: { thin: false, corner: false, hollow: false, semi: false, diff: false, seam: false },
  selected: null, divider: 0.5, ozoom: 0, drawMode: false,
};
let regionHistory = [];
let out = null, cls = null, seam = null;
let srcNative = null;                    // 原图 1:1 canvas
let offA, offB, offDiff, offSeam;        // 输出尺寸的离屏 canvas
let srcZ = 8, outZ = 4;                  // 当前显示缩放
let dragRect = null, dividerDrag = false;

const $ = id => document.getElementById(id);

function init() {
  bindEvents();
  if (!restore()) loadSample(makeSample1);
}

function bindEvents() {
  $('file').addEventListener('change', onFile);
  $('s1').onclick = () => loadSample(makeSample1);
  $('s2').onclick = () => loadSample(makeSample2);
  $('s3').onclick = () => loadSample(makeSample3);
  $('scale').onchange = e => { state.scale = +e.target.value; rebuild(); };
  $('mA').onclick = () => setMode('A');
  $('mB').onclick = () => setMode('B');
  $('mSplit').onclick = () => setMode('split');
  $('tGrid').onclick = () => { state.grid = !state.grid; renderAll(); };
  $('tPal').onclick = () => { state.paletteLock = !state.paletteLock; rebuild(); };
  const insp = { iThin: 'thin', iCorner: 'corner', iHollow: 'hollow', iSemi: 'semi', iDiff: 'diff', iSeam: 'seam' };
  for (const [id, key] of Object.entries(insp))
    $(id).onclick = () => { state.inspect[key] = !state.inspect[key]; renderAll(); };
  $('tDraw').onclick = () => { state.drawMode = !state.drawMode; renderAll(); };
  $('undoRegion').onclick = undoRegions;
  $('clearRegion').onclick = () => {
    if (!state.regions.length) return;
    regionHistory.push(state.regions.map(r => ({ ...r })));
    state.regions = []; rebuild();
  };
  $('wipe').onclick = () => { localStorage.removeItem(LS_KEY); location.reload(); };
  $('zIn').onclick = () => { state.ozoom = Math.min(24, (state.ozoom || fitZoom()) + 1); renderAll(); };
  $('zOut').onclick = () => { state.ozoom = Math.max(1, (state.ozoom || fitZoom()) - 1); renderAll(); };
  $('zFit').onclick = () => { state.ozoom = 0; renderAll(); };
  $('expA').onclick = () => exportPNG('A');
  $('expB').onclick = () => exportPNG('B');
  bindCanvasEvents();
}

/* ---------- 载入与存档 ---------- */

function onFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => loadFromDataURL(rd.result, f.name, false);
  rd.readAsDataURL(f);
  e.target.value = '';
}

function loadSample(make) {
  const { img, name } = make();
  const c = imgToCanvas(img);
  setImage(img, name, c.toDataURL(), false);
}

function loadFromDataURL(url, name, keep) {
  const im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(im, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height);
    setImage({ w: c.width, h: c.height, data: id.data }, name, url, keep);
  };
  im.src = url;
}

function setImage(img, name, dataURL, keep) {
  state.img = img; state.name = name; state.dataURL = dataURL;
  if (!keep) {
    state.regions = []; regionHistory = []; state.selected = null; state.ozoom = 0;
  }
  srcNative = imgToCanvas(img);
  rebuild();
}

function imgToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.w; c.height = img.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  return c;
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      v: 1, name: state.name, dataURL: state.dataURL,
      scale: state.scale, mode: state.mode, grid: state.grid, paletteLock: state.paletteLock,
      regions: state.regions, inspect: state.inspect, divider: state.divider,
    }));
  } catch (e) { /* 图片过大存不下时静默跳过 */ }
}

function restore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignore */ }
  if (!s || !s.dataURL) return false;
  Object.assign(state, {
    scale: s.scale || 3, mode: s.mode || 'split', grid: s.grid !== false,
    paletteLock: s.paletteLock !== false, regions: s.regions || [],
    inspect: Object.assign(state.inspect, s.inspect), divider: s.divider ?? 0.5,
  });
  loadFromDataURL(s.dataURL, s.name || '已存图片', true);
  return true;
}

/* ---------- 重算与渲染 ---------- */

function rebuild() {
  out = computeOutputs(state.img, state.scale, state.regions, state.paletteLock);
  cls = classifyPixels(state.img);
  seam = seamMask(state.img, state.regions);
  buildOffscreens();
  renderAll();
  save();
}

function buildOffscreens() {
  offA = document.createElement('canvas'); offA.width = out.outW; offA.height = out.outH;
  offA.getContext('2d').putImageData(new ImageData(out.outA, out.outW, out.outH), 0, 0);
  offB = document.createElement('canvas'); offB.width = out.outW; offB.height = out.outH;
  offB.getContext('2d').putImageData(new ImageData(out.outB, out.outW, out.outH), 0, 0);
  // A/B 差异层
  const dd = new Uint8ClampedArray(out.outW * out.outH * 4);
  for (let i = 0; i < out.diffMask.length; i++) if (out.diffMask[i]) {
    dd[i * 4] = 255; dd[i * 4 + 1] = 40; dd[i * 4 + 2] = 90; dd[i * 4 + 3] = 150;
  }
  offDiff = document.createElement('canvas'); offDiff.width = out.outW; offDiff.height = out.outH;
  offDiff.getContext('2d').putImageData(new ImageData(dd, out.outW, out.outH), 0, 0);
  // 接缝层
  const N = state.scale;
  const sd = new Uint8ClampedArray(out.outW * out.outH * 4);
  for (let y = 0; y < state.img.h; y++) for (let x = 0; x < state.img.w; x++) {
    if (!seam[y * state.img.w + x]) continue;
    for (let dy = 0; dy < N; dy++) for (let dx = 0; dx < N; dx++) {
      const oi = ((y * N + dy) * out.outW + (x * N + dx)) * 4;
      sd[oi] = 0; sd[oi + 1] = 200; sd[oi + 2] = 255; sd[oi + 3] = 70;
    }
  }
  offSeam = document.createElement('canvas'); offSeam.width = out.outW; offSeam.height = out.outH;
  offSeam.getContext('2d').putImageData(new ImageData(sd, out.outW, out.outH), 0, 0);
}

function renderAll() {
  if (!out) return;
  renderSrc();
  renderOut();
  renderMeta();
  syncButtons();
}

function drawChecker(x, w, h, s) {
  for (let j = 0; j * s < h; j++) for (let i = 0; i * s < w; i++) {
    x.fillStyle = (i + j) % 2 ? '#20242e' : '#272c38';
    x.fillRect(i * s, j * s, s, s);
  }
}

function renderSrc() {
  const { w, h } = state.img;
  const cv = $('src');
  srcZ = Math.max(2, Math.min(24, Math.floor(420 / w), Math.floor(420 / h)));
  cv.width = w * srcZ; cv.height = h * srcZ;
  const x = cv.getContext('2d');
  drawChecker(x, cv.width, cv.height, Math.max(4, srcZ));
  x.imageSmoothingEnabled = false;
  x.drawImage(srcNative, 0, 0, cv.width, cv.height);
  // 网格
  if (state.grid && srcZ >= 4) {
    x.strokeStyle = 'rgba(255,255,255,.10)'; x.lineWidth = 1;
    x.beginPath();
    for (let i = 0; i <= w; i++) { x.moveTo(i * srcZ + .5, 0); x.lineTo(i * srcZ + .5, cv.height); }
    for (let j = 0; j <= h; j++) { x.moveTo(0, j * srcZ + .5); x.lineTo(cv.width, j * srcZ + .5); }
    x.stroke();
  }
  // 特征检查高亮
  const layers = [
    ['thin', 'rgba(190,90,255,.55)'], ['corner', 'rgba(255,150,40,.65)'],
    ['hollow', 'rgba(60,220,220,.6)'], ['semi', 'rgba(255,230,60,.55)'],
  ];
  for (const [key, color] of layers) {
    if (!state.inspect[key]) continue;
    x.fillStyle = color;
    for (const [px, py] of cls[key]) x.fillRect(px * srcZ, py * srcZ, srcZ, srcZ);
  }
  // 保护区
  for (const r of state.regions) {
    x.fillStyle = 'rgba(90,200,255,.16)';
    x.fillRect(r.x * srcZ, r.y * srcZ, r.w * srcZ, r.h * srcZ);
    x.strokeStyle = '#5ac8ff'; x.lineWidth = 1.5;
    x.strokeRect(r.x * srcZ + .5, r.y * srcZ + .5, r.w * srcZ - 1, r.h * srcZ - 1);
  }
  // 正在框选的矩形
  if (dragRect) {
    const r = normRect(dragRect);
    x.strokeStyle = '#ffd34d'; x.lineWidth = 1.5;
    x.setLineDash([4, 3]);
    x.strokeRect(r.x * srcZ + .5, r.y * srcZ + .5, r.w * srcZ - 1, r.h * srcZ - 1);
    x.setLineDash([]);
  }
  // 选中原图像素（从输出回看）
  if (state.selected) {
    x.strokeStyle = '#ffd34d'; x.lineWidth = 2;
    x.strokeRect(state.selected.x * srcZ - 1, state.selected.y * srcZ - 1, srcZ + 2, srcZ + 2);
  }
}

function fitZoom() {
  return Math.max(1, Math.min(16, Math.floor(640 / out.outW), Math.floor(520 / out.outH)));
}

function renderOut() {
  const cv = $('out');
  outZ = state.ozoom || fitZoom();
  const W = out.outW * outZ, H = out.outH * outZ;
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  drawChecker(x, W, H, 8);
  x.imageSmoothingEnabled = false;
  if (state.mode === 'A') {
    x.drawImage(offA, 0, 0, W, H);
  } else if (state.mode === 'B') {
    x.drawImage(offB, 0, 0, W, H);
  } else {
    const dxp = Math.round(state.divider * out.outW) * outZ;
    x.save(); x.beginPath(); x.rect(0, 0, dxp, H); x.clip();
    x.drawImage(offA, 0, 0, W, H); x.restore();
    x.save(); x.beginPath(); x.rect(dxp, 0, W - dxp, H); x.clip();
    x.drawImage(offB, 0, 0, W, H); x.restore();
    x.fillStyle = '#ffd34d'; x.fillRect(dxp - 1, 0, 2, H);
    x.font = 'bold 12px sans-serif';
    x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(4, 4, 16, 16); x.fillRect(W - 20, 4, 16, 16);
    x.fillStyle = '#fff'; x.fillText('A', 8, 16); x.fillText('B', W - 16, 16);
  }
  if (state.inspect.diff) x.drawImage(offDiff, 0, 0, W, H);
  if (state.inspect.seam) x.drawImage(offSeam, 0, 0, W, H);
  // 网格：细线=输出像素，粗线=原图像素块边界
  if (state.grid) {
    const N = state.scale;
    x.lineWidth = 1;
    if (outZ >= 4) {
      x.strokeStyle = 'rgba(255,255,255,.06)';
      x.beginPath();
      for (let i = 0; i <= out.outW; i++) { x.moveTo(i * outZ + .5, 0); x.lineTo(i * outZ + .5, H); }
      for (let j = 0; j <= out.outH; j++) { x.moveTo(0, j * outZ + .5); x.lineTo(W, j * outZ + .5); }
      x.stroke();
    }
    x.strokeStyle = 'rgba(255,255,255,.20)';
    x.beginPath();
    for (let i = 0; i <= state.img.w; i++) { x.moveTo(i * N * outZ + .5, 0); x.lineTo(i * N * outZ + .5, H); }
    for (let j = 0; j <= state.img.h; j++) { x.moveTo(0, j * N * outZ + .5); x.lineTo(W, j * N * outZ + .5); }
    x.stroke();
  }
  // 保护区轮廓
  const N = state.scale;
  x.strokeStyle = '#5ac8ff'; x.lineWidth = 1.5;
  for (const r of state.regions)
    x.strokeRect(r.x * N * outZ + .5, r.y * N * outZ + .5, r.w * N * outZ - 1, r.h * N * outZ - 1);
  // 选中块
  if (state.selected) {
    x.strokeStyle = '#ffd34d'; x.lineWidth = 2;
    x.strokeRect(state.selected.x * N * outZ - 1, state.selected.y * N * outZ - 1, N * outZ + 2, N * outZ + 2);
  }
}

function renderMeta() {
  const { w, h } = state.img;
  $('srcMeta').textContent = `${state.name} · ${w}×${h} · ${out.palette.size} 色`;
  const palState = out.violations === 0
    ? '<span class="ok">调色板校验 ✓ 未引入新颜色</span>'
    : `<span class="bad">调色板校验 ✗ 出现 ${out.violations} 个新颜色像素</span>`;
  $('outMeta').innerHTML =
    `${out.outW}×${out.outH} · A/B 差异像素 ${out.diffCount} · ${palState}`;
  // 调色板色板
  const pal = $('palette');
  pal.innerHTML = '<span class="grp">调色板</span>';
  for (const c of out.palette.values()) {
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.title = `rgba(${c.join(',')})`;
    sw.style.background = c[3] === 0
      ? 'repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/8px 8px'
      : `rgba(${c.join(',')})`;
    pal.appendChild(sw);
  }
  // 保护区列表
  const rg = $('regions');
  rg.innerHTML = state.regions.length ? '<span class="grp">保护区（直接放大）</span>' : '';
  state.regions.forEach((r, i) => {
    const item = document.createElement('span');
    item.className = 'ritem';
    item.textContent = `(${r.x},${r.y}) ${r.w}×${r.h} `;
    const del = document.createElement('button');
    del.textContent = '删';
    del.onclick = () => {
      regionHistory.push(state.regions.map(o => ({ ...o })));
      state.regions.splice(i, 1); rebuild();
    };
    item.appendChild(del);
    rg.appendChild(item);
  });
}

function syncButtons() {
  $('mA').classList.toggle('on', state.mode === 'A');
  $('mB').classList.toggle('on', state.mode === 'B');
  $('mSplit').classList.toggle('on', state.mode === 'split');
  $('tGrid').classList.toggle('on', state.grid);
  $('tPal').classList.toggle('on', state.paletteLock);
  $('tDraw').classList.toggle('on', state.drawMode);
  const map = { iThin: 'thin', iCorner: 'corner', iHollow: 'hollow', iSemi: 'semi', iDiff: 'diff', iSeam: 'seam' };
  for (const [id, key] of Object.entries(map)) $(id).classList.toggle('on', state.inspect[key]);
  $('scale').value = String(state.scale);
  $('src').style.cursor = state.drawMode ? 'crosshair' : 'default';
}

function setMode(m) { state.mode = m; renderAll(); save(); }

/* ---------- 交互 ---------- */

function bindCanvasEvents() {
  const oc = $('out'), sc = $('src');

  oc.addEventListener('mousedown', e => {
    const p = outEventPixel(e);
    if (!p) return;
    if (state.mode === 'split' && Math.abs(e.offsetX - state.divider * oc.width) < 8) {
      dividerDrag = true;
    } else {
      selectSource(p.sx, p.sy);
    }
  });
  oc.addEventListener('mousemove', e => {
    if (dividerDrag) {
      state.divider = Math.min(1, Math.max(0, e.offsetX / oc.width));
      renderOut(); return;
    }
    const p = outEventPixel(e);
    if (p) showOutInfo(p);
  });
  window.addEventListener('mouseup', () => { if (dividerDrag) { dividerDrag = false; save(); } });
  oc.addEventListener('mouseleave', () => { $('info').textContent = '移动鼠标查看像素来源；点击输出图像定位原图像素。'; });

  sc.addEventListener('mousedown', e => {
    const p = srcEventPixel(e);
    if (!p) return;
    if (state.drawMode) dragRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    else selectSource(p.x, p.y);
  });
  sc.addEventListener('mousemove', e => {
    const p = srcEventPixel(e);
    if (dragRect && p) { dragRect.x1 = p.x; dragRect.y1 = p.y; renderSrc(); }
    else if (p) showSrcInfo(p);
  });
  sc.addEventListener('mouseup', e => {
    if (!dragRect) return;
    const p = srcEventPixel(e);
    if (p) { dragRect.x1 = p.x; dragRect.y1 = p.y; }
    const r = normRect(dragRect);
    dragRect = null;
    if (r.w >= 1 && r.h >= 1) {
      regionHistory.push(state.regions.map(o => ({ ...o })));
      state.regions.push(r);
      rebuild();
    } else renderSrc();
  });
}

function outEventPixel(e) {
  const ox = Math.floor(e.offsetX / outZ), oy = Math.floor(e.offsetY / outZ);
  if (ox < 0 || oy < 0 || ox >= out.outW || oy >= out.outH) return null;
  return { ox, oy, sx: Math.floor(ox / state.scale), sy: Math.floor(oy / state.scale) };
}

function srcEventPixel(e) {
  const r = $('src').getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / srcZ), y = Math.floor((e.clientY - r.top) / srcZ);
  if (x < 0 || y < 0 || x >= state.img.w || y >= state.img.h) return null;
  return { x, y };
}

function normRect(d) {
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
  return { x, y, w: Math.abs(d.x1 - d.x0) + 1, h: Math.abs(d.y1 - d.y0) + 1 };
}

function rgbaAt(arr, w, px, py) {
  const i = (py * w + px) * 4;
  return `rgba(${arr[i]},${arr[i + 1]},${arr[i + 2]},${arr[i + 3]})`;
}

function showOutInfo(p) {
  $('info').textContent =
    `输出(${p.ox},${p.oy}) ← 原图(${p.sx},${p.sy}) · A: ${rgbaAt(out.outA, out.outW, p.ox, p.oy)}` +
    ` · B: ${rgbaAt(out.outB, out.outW, p.ox, p.oy)}` +
    (out.diffMask[p.oy * out.outW + p.ox] ? ' · ⚠ 两种方式结果不同' : '');
}

function showSrcInfo(p) {
  const getP = makeGetter(state.img);
  const c = getP(p.x, p.y);
  $('info').textContent =
    `原图(${p.x},${p.y}) rgba(${c.join(',')})` +
    (inRegions(state.regions, p.x, p.y) ? ' · 位于保护区（直接放大）' : '');
}

function selectSource(sx, sy) {
  state.selected = { x: sx, y: sy };
  renderSrc(); renderOut();
  const getP = makeGetter(state.img);
  const c = getP(sx, sy);
  let how;
  if (inRegions(state.regions, sx, sy)) {
    how = '位于保护区：四个象限全部直接复制自身';
  } else {
    const q = epxSources(getP, sx, sy);
    how = 'B 方式四象限取色 → 左上:' + q[0].from + ' 右上:' + q[1].from +
          ' 左下:' + q[2].from + ' 右下:' + q[3].from;
  }
  $('selInfo').textContent = `已选中原图(${sx},${sy}) rgba(${c.join(',')}) · ${how}`;
}

function undoRegions() {
  if (!regionHistory.length) return;
  state.regions = regionHistory.pop();
  rebuild();
}

/* ---------- 导出 ---------- */

function exportPNG(which) {
  const c = document.createElement('canvas');
  c.width = out.outW; c.height = out.outH;
  c.getContext('2d').putImageData(
    new ImageData(which === 'A' ? out.outA : out.outB, out.outW, out.outH), 0, 0);
  c.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${state.name}-${which}-${state.scale}x.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

/* ---------- 启动 ---------- */

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', init);
}
if (typeof module !== 'undefined') {
  module.exports = {
    eq4, makeGetter, buildPalette, epxSources, inRegions, snapToPalette,
    computeOutputs, classifyPixels, seamMask,
    makeSample1, makeSample2, makeSample3,
  };
}
