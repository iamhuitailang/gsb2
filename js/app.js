/*
 * 主应用：源图控制点编辑 / 展开预览 / 对齐点对 / 双视角合并 / 查询 / 导入导出。
 * 所有处理均在本地完成，不发起任何网络请求。
 */
(function () {
  'use strict';
  const G = window.CylGeo, R = window.CylRaster, M = window.CylMerge, S = window.CylSynthetic;
  const HANDLE_KEYS = ['LT', 'TM', 'RT', 'LB', 'BM', 'RB'];
  const HANDLE_COLOR = { LT: '#7ddcff', RT: '#7ddcff', LB: '#7ddcff', RB: '#7ddcff', TM: '#ffd166', BM: '#ffd166' };

  const state = {
    views: {
      A: { img: null, controls: null, warp: null, rendered: null, thetaLimit: 90 * Math.PI / 180 },
      B: { img: null, controls: null, warp: null, rendered: null, thetaLimit: 90 * Math.PI / 180 },
    },
    activeView: 'A',
    mode: 'unwarp',            // unwarp | align | merge
    outW: 1440, outH: 720,
    stretchWarn: 2.5,
    showHatch: true,
    showStretch: false,
    pairs: [],                 // [{a:[x,y], b:[x,y]}]
    pairSide: 'a',
    sim: null,
    merge: null,
    blendMode: 'A',
    lumaThr: 25,
    showCoverage: false,
    showLuma: false,
    query: null,
  };

  const srcCanvas = document.getElementById('srcCanvas');
  const outCanvas = document.getElementById('outCanvas');
  const srcCtx = srcCanvas.getContext('2d');
  const outCtx = outCanvas.getContext('2d');
  let drag = null;             // {key} 或 {pairIndex, side}

  /* ---------------- 图片载入 ---------------- */

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function openView(viewKey, file) {
    const img = await loadImageFromFile(file);
    const v = state.views[viewKey];
    v.img = img;
    v.controls = G.defaultControls(img.naturalWidth, img.naturalHeight);
    v.thetaLimit = 90 * Math.PI / 180;
    state.activeView = viewKey;
    document.querySelector(`.tab[data-view="${viewKey}"]`).classList.add('active');
    document.querySelector(`.tab[data-view="${viewKey === 'A' ? 'B' : 'A'}"]`).classList.remove('active');
    rebuildView(viewKey);
    drawSource();
    refreshOutput();
    updateWarnings();
  }

  document.getElementById('fileA').addEventListener('change', (e) => {
    if (e.target.files[0]) openView('A', e.target.files[0]);
  });
  document.getElementById('fileB').addEventListener('change', (e) => {
    if (e.target.files[0]) openView('B', e.target.files[0]);
  });

  document.getElementById('btnDemo').addEventListener('click', () => {
    const demo = S.buildDemo();
    putDemoView('A', demo.views[0]);
    putDemoView('B', demo.views[1]);
    state.pairs = [];
    state.sim = null;
    state.activeView = 'A';
    document.querySelectorAll('.tab[data-view]').forEach((t) =>
      t.classList.toggle('active', t.dataset.view === 'A'));
    drawSource();
    refreshOutput();
    updatePairUI();
    updateWarnings();
  });

  function putDemoView(key, spec) {
    const v = state.views[key];
    v.img = spec.canvas;
    const w = spec.canvas.width, h = spec.canvas.height;
    v.controls = demoControls(spec, w, h);
    v.thetaLimit = spec.fovDeg * Math.PI / 180;
    rebuildView(key);
  }

  /** 演示图几何参数已知，直接给出贴合罐身的控制点 */
  function demoControls(spec, w, h) {
    const cx = w / 2, cy = h / 2, R = spec.R, L = spec.L;
    const halfW = R * Math.sin(spec.fovDeg * S.DEG);
    const LT = [cx - halfW, cy - L], RT = [cx + halfW, cy - L];
    const LB = [cx - halfW, cy + L], RB = [cx + halfW, cy + L];
    // 椭圆弧上中点（贝塞尔控制点），使上下缘贴合罐口投影
    const bulge = R * (1 - Math.cos(spec.fovDeg * S.DEG)) * 0.5;
    return {
      LT, RT, LB, RB,
      TM: [cx, cy - L + bulge],
      BM: [cx, cy + L - bulge],
    };
  }

  /* ---------------- 展开计算 ---------------- */

  function rebuildView(key) {
    const v = state.views[key];
    if (!v.img || !v.controls) return;
    v.warp = G.buildWarp(v.controls, state.outW, state.outH, v.thetaLimit,
      v.img.naturalWidth || v.img.width, v.img.naturalHeight || v.img.height);
    const srcData = srcImageData(v);
    v.rendered = R.renderWarp(v.warp, srcData);
  }

  function srcImageData(v) {
    const c = document.createElement('canvas');
    const w = v.img.naturalWidth || v.img.width, h = v.img.naturalHeight || v.img.height;
    c.width = w; c.height = h;
    c.getContext('2d', { willReadFrequently: true }).drawImage(v.img, 0, 0);
    return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  }

  function rebuildAll() {
    state.outW = clampInt(document.getElementById('outW').value, 120, 4096);
    state.outH = clampInt(document.getElementById('outH').value, 80, 4096);
    rebuildView('A');
    rebuildView('B');
    refreshOutput();
  }
  document.getElementById('btnRebuild').addEventListener('click', rebuildAll);

  function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, parseInt(v, 10) || lo)); }

  /* ---------------- 源图绘制与拖拽 ---------------- */

  function drawSource() {
    const v = state.views[state.activeView];
    if (!v.img) {
      srcCanvas.width = 640; srcCanvas.height = 420;
      srcCtx.fillStyle = '#14161a';
      srcCtx.fillRect(0, 0, srcCanvas.width, srcCanvas.height);
      srcCtx.fillStyle = '#9aa3af';
      srcCtx.font = '15px sans-serif';
      srcCtx.textAlign = 'center';
      srcCtx.fillText('点击左上角「视角 A 图片」或「生成演示罐体」开始', srcCanvas.width / 2, srcCanvas.height / 2);
      document.getElementById('srcSize').textContent = '';
      return;
    }
    const w = v.img.naturalWidth || v.img.width, h = v.img.naturalHeight || v.img.height;
    srcCanvas.width = w; srcCanvas.height = h;
    srcCtx.drawImage(v.img, 0, 0);
    document.getElementById('srcSize').textContent = `${state.activeView} · ${w}×${h}px`;
    const c = v.controls;

    // 展开有效范围在源图上的包络（取 θ 限制对应的两条 s 等值线）
    drawValidEnvelope(v);

    // 控制线
    srcCtx.lineWidth = 2;
    drawBezier(c.LT, c.TM, c.RT, '#ffd166');
    drawBezier(c.LB, c.BM, c.RB, '#ffd166');
    srcCtx.strokeStyle = '#7ddcff';
    srcCtx.beginPath();
    srcCtx.moveTo(...c.LT); srcCtx.lineTo(...c.LB);
    srcCtx.moveTo(...c.RT); srcCtx.lineTo(...c.RB);
    srcCtx.stroke();
    // 轴向
    srcCtx.strokeStyle = 'rgba(255,255,255,.75)';
    srcCtx.setLineDash([6, 5]);
    srcCtx.beginPath(); srcCtx.moveTo(...c.TM); srcCtx.lineTo(...c.BM); srcCtx.stroke();
    srcCtx.setLineDash([]);

    // 控制点
    for (const key of HANDLE_KEYS) {
      const p = c[key];
      srcCtx.beginPath();
      srcCtx.arc(p[0], p[1], 7, 0, Math.PI * 2);
      srcCtx.fillStyle = HANDLE_COLOR[key];
      srcCtx.fill();
      srcCtx.strokeStyle = '#111';
      srcCtx.stroke();
    }
    // 查询回跳高亮
    if (state.query && state.query.view === state.activeView) drawQueryMarker(srcCtx, state.query.sx, state.query.sy);
  }

  function drawBezier(p0, p1, p2, color) {
    srcCtx.strokeStyle = color;
    srcCtx.beginPath();
    srcCtx.moveTo(...p0);
    srcCtx.quadraticCurveTo(...p1, ...p2);
    srcCtx.stroke();
  }

  /** 在源图上标出受 θ 取用角限制后的实际取用范围（绿色半透明带） */
  function drawValidEnvelope(v) {
    if (!v.warp) return;
    const c = v.controls, lim = v.thetaLimit;
    const sL = (Math.sin(-lim) + 1) / 2, sR = (Math.sin(lim) + 1) / 2;
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push(G.edgePoint(c, 'top', G.lerp(sL, sR, i / 24)));
    for (let i = 24; i >= 0; i--) pts.push(G.edgePoint(c, 'bot', G.lerp(sL, sR, i / 24)));
    srcCtx.save();
    srcCtx.fillStyle = 'rgba(60,200,90,.12)';
    srcCtx.strokeStyle = 'rgba(60,200,90,.8)';
    srcCtx.lineWidth = 1.5;
    srcCtx.beginPath();
    srcCtx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) srcCtx.lineTo(p[0], p[1]);
    srcCtx.closePath();
    srcCtx.fill(); srcCtx.stroke();
    srcCtx.restore();
  }

  function drawQueryMarker(ctx, x, y) {
    ctx.save();
    ctx.strokeStyle = '#ff3b3b';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14); ctx.stroke();
    ctx.restore();
  }

  function eventPos(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * canvas.width / rect.width,
      (e.clientY - rect.top) * canvas.height / rect.height,
    ];
  }

  srcCanvas.addEventListener('pointerdown', (e) => {
    const v = state.views[state.activeView];
    if (!v.controls) return;
    const [px, py] = eventPos(srcCanvas, e);
    let best = null, bestD = 14;
    for (const key of HANDLE_KEYS) {
      const d = Math.hypot(v.controls[key][0] - px, v.controls[key][1] - py);
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best) {
      drag = { key: best };
      srcCanvas.setPointerCapture(e.pointerId);
    }
  });

  srcCanvas.addEventListener('pointermove', (e) => {
    const v = state.views[state.activeView];
    if (!drag || !v.controls) return;
    const [px, py] = eventPos(srcCanvas, e);
    const w = v.img.naturalWidth || v.img.width, h = v.img.naturalHeight || v.img.height;
    v.controls[drag.key] = [G.clamp(px, 0, w - 1), G.clamp(py, 0, h - 1)];
    rebuildView(state.activeView);
    drawSource();
    refreshOutput();
    updateWarnings();
  });
  srcCanvas.addEventListener('pointerup', () => { drag = null; });

  /* ---------------- 输出绘制 ---------------- */

  function refreshOutput() {
    outCanvas.width = state.outW;
    outCanvas.height = state.outH;
    outCtx.clearRect(0, 0, state.outW, state.outH);
    if (state.mode === 'align') {
      drawPairMarkers();   // align 模式自行绘制当前打点侧的展开图
    } else if (state.mode === 'merge') {
      drawMerge();
    } else {
      drawUnwarp();
    }
    drawQueryOnOutput();
  }

  function drawUnwarp() {
    const v = state.views[state.activeView];
    if (!v.rendered) {
      outCtx.fillStyle = '#14161a';
      outCtx.fillRect(0, 0, state.outW, state.outH);
      outCtx.fillStyle = '#9aa3af';
      outCtx.font = '16px sans-serif';
      outCtx.textAlign = 'center';
      outCtx.fillText('展开图将显示在这里', state.outW / 2, state.outH / 2);
      return;
    }
    outCtx.putImageData(v.rendered, 0, 0);
    if (state.showHatch) R.drawHatching(outCtx, v.warp);
    if (state.showStretch) drawStretchHeat(v);
    drawAngleRuler(v);
  }

  /** 拉伸热力：超过提示倍数的列描橙，倍数标注在顶部 */
  function drawStretchHeat(v) {
    const { W, H, stretch, status } = v.warp;
    outCtx.save();
    for (let x = 0; x < W; x++) {
      if (status[x] !== 0) continue;
      const s = stretch[x];
      if (s < state.stretchWarn) continue;
      const a = Math.min(0.45, (s - state.stretchWarn) / (state.stretchWarn * 2));
      outCtx.fillStyle = `rgba(255,140,0,${a})`;
      outCtx.fillRect(x, 0, 1, H);
    }
    outCtx.restore();
  }

  /** 顶部角度标尺，每 10° 一刻，便于量间距 */
  function drawAngleRuler(v) {
    const { W } = v.warp;
    outCtx.save();
    outCtx.fillStyle = 'rgba(20,22,26,.78)';
    outCtx.fillRect(0, 0, W, 22);
    outCtx.strokeStyle = '#cfd6e0';
    outCtx.fillStyle = '#cfd6e0';
    outCtx.font = '11px monospace';
    outCtx.textAlign = 'center';
    for (let deg = -90; deg <= 90; deg += 10) {
      const x = (Math.sin(deg * Math.PI / 180) + 1) / 2 * (W - 1);
      outCtx.beginPath();
      outCtx.moveTo(x, 16);
      outCtx.lineTo(x, 22);
      outCtx.stroke();
      if (deg % 30 === 0) outCtx.fillText(`${deg}°`, x, 12);
    }
    outCtx.restore();
  }

  /* ---------------- 对齐点对 ---------------- */

  outCanvas.addEventListener('click', (e) => {
    const [px, py] = eventPos(outCanvas, e);
    if (state.mode === 'align') {
      const side = state.pairSide;
      const viewKey = side === 'a' ? 'A' : 'B';
      if (!state.views[viewKey].rendered) {
        setHint(`视角 ${viewKey} 还没有图片，无法在该侧打点`);
        return;
      }
      placePairPoint(side, px, py);
    } else {
      queryAt(px, py);
    }
  });

  function placePairPoint(side, px, py) {
    // 打点侧只由顶部下拉框决定，点击不自动切换：支持同侧连点，也支持 A/B 交替。
    // 找该侧第一个还空着的 pair；都满了就新开一对。
    let idx = state.pairs.findIndex((p) => p[side] === null);
    if (idx < 0) {
      state.pairs.push({ a: null, b: null });
      idx = state.pairs.length - 1;
    }
    state.pairs[idx][side] = [px, py];
    updatePairUI();
    refreshOutput();
  }

  function updatePairUI() {
    const sel = document.getElementById('pairSide');
    sel.innerHTML = '<option value="a">A 侧（点 A 展开图）</option><option value="b">B 侧（点 B 展开图）</option>';
    sel.value = state.pairSide;
    const list = document.getElementById('pairList');
    const complete = state.pairs.filter((p) => p.a && p.b);
    list.innerHTML = state.pairs.map((p, i) => {
      const ok = p.a && p.b;
      return `<span class="pair-chip ${ok ? '' : 'bad'}">#${i + 1}${ok ? '' : '（缺' + (p.a ? 'B' : 'A') + '）'}</span>`;
    }).join('');
    const info = document.getElementById('alignInfo');
    if (complete.length >= 1) {
      state.sim = G.fitSimilarity(complete.map((p) => ({ a: p.a, b: p.b })));
      const warn = state.sim.warnings.length ? `　⚠ ${state.sim.warnings.map((w) => w.msg).join('；')}` : '';
      info.innerHTML = `已拟合 ${complete.length} 对：残差 RMS=${state.sim.rms.toFixed(2)}px，缩放=${Math.hypot(state.sim.M.a, state.sim.M.b).toFixed(4)}，旋转=${(Math.atan2(state.sim.M.b, state.sim.M.a) * 180 / Math.PI).toFixed(2)}°<span class="${state.sim.degenerate ? 'warn-item error' : 'muted'}">${warn}</span>`;
    } else {
      state.sim = null;
      info.textContent = '至少完成 1 对点（建议 3 对以上）';
    }
    state.merge = null;
  }

  function drawPairMarkers() {
    if (state.mode !== 'align') return;
    const side = state.pairSide === 'a' ? 'a' : 'b';
    const viewKey = side === 'a' ? 'A' : 'B';
    if (!state.views[viewKey].rendered) {
      outCtx.fillStyle = '#14161a';
      outCtx.fillRect(0, 0, state.outW, state.outH);
      outCtx.fillStyle = '#ffb020';
      outCtx.font = '15px sans-serif';
      outCtx.textAlign = 'center';
      outCtx.fillText(`视角 ${viewKey} 尚未载入图片，请先在左上角打开`, state.outW / 2, state.outH / 2);
      return;
    }
    outCtx.putImageData(state.views[viewKey].rendered, 0, 0);
    if (state.showHatch) R.drawHatching(outCtx, state.views[viewKey].warp);
    drawAngleRuler(state.views[viewKey]);
    const colors = ['#ff5d5d', '#5dd5ff', '#9dff5d', '#ffd166', '#d58bff', '#ff9dcf'];
    state.pairs.forEach((p, i) => {
      const q = p[side];
      if (!q) return;
      outCtx.save();
      outCtx.strokeStyle = colors[i % colors.length];
      outCtx.lineWidth = 2;
      outCtx.beginPath(); outCtx.arc(q[0], q[1], 9, 0, Math.PI * 2); outCtx.stroke();
      outCtx.fillStyle = colors[i % colors.length];
      outCtx.font = 'bold 12px sans-serif';
      outCtx.fillText(String(i + 1), q[0] + 11, q[1] - 8);
      outCtx.restore();
    });
  }

  document.getElementById('btnAddPair').addEventListener('click', () => {
    state.pairs.push({ a: null, b: null });
    updatePairUI(); refreshOutput();
  });
  document.getElementById('btnDelPair').addEventListener('click', () => {
    state.pairs.pop();
    updatePairUI(); refreshOutput();
  });
  document.getElementById('btnClearPairs').addEventListener('click', () => {
    state.pairs = []; state.sim = null; state.merge = null;
    updatePairUI(); refreshOutput();
  });
  document.getElementById('pairSide').addEventListener('change', (e) => {
    state.pairSide = e.target.value;
    refreshOutput();
  });

  /* ---------------- 合并 ---------------- */

  function ensureMerge() {
    const A = state.views.A, B = state.views.B;
    if (!A.rendered) return null;
    if (B.rendered && (!state.sim || state.sim.degenerate)) return undefined; // B 未对齐或变换不可信，提示用户
    const viewB = B.rendered && state.sim ? { img: B.rendered, warp: B.warp, M: state.sim.M } : null;
    state.merge = M.mergeViews(
      { img: A.rendered, warp: A.warp },
      viewB,
      state.blendMode
    );
    return state.merge;
  }

  function drawMerge() {
    const res = ensureMerge();
    if (res === undefined) {
      outCtx.fillStyle = '#14161a';
      outCtx.fillRect(0, 0, state.outW, state.outH);
      outCtx.fillStyle = '#ffb020';
      outCtx.font = '15px sans-serif';
      outCtx.textAlign = 'center';
      const msg = state.sim && state.sim.degenerate
        ? '对齐点共线/不足：请在「对齐点」页补一个不在同一直线上的点（至少 3 个非共线点）'
        : '视角 B 已载入：请到「对齐点」页至少完成一对同名图案点';
      outCtx.fillText(msg, state.outW / 2, state.outH / 2);
      return;
    }
    if (!res) {
      outCtx.fillStyle = '#14161a';
      outCtx.fillRect(0, 0, state.outW, state.outH);
      outCtx.fillStyle = '#9aa3af';
      outCtx.font = '15px sans-serif';
      outCtx.textAlign = 'center';
      outCtx.fillText('先载入视角 A', state.outW / 2, state.outH / 2);
      return;
    }
    outCtx.putImageData(res.merged, 0, 0);
    if (state.showCoverage) M.drawCoverage(outCtx, res, state.outW, state.outH);
    if (state.showLuma) M.drawLumaConflict(outCtx, res, state.outW, state.outH, state.lumaThr);
    drawNoDataHatch(res);
    drawAngleRuler(state.views.A);
  }

  /** 合并图无数据区（含两视角都没拍到的背面）：浅灰底 + 灰斜纹，明确留空。
   *  留空在本模型下是整列的，按列处理，避免逐像素画线。 */
  function drawNoDataHatch(res) {
    const W = state.outW, H = state.outH;
    const noneCol = new Uint8Array(W);
    for (let x = 0; x < W; x++) noneCol[x] = res.source[x] === M.SRC_NONE ? 1 : 0;
    outCtx.save();
    // 浅灰底
    outCtx.fillStyle = 'rgba(150,150,150,.35)';
    for (let x = 0; x < W; x++) if (noneCol[x]) outCtx.fillRect(x, 0, 1, H);
    // 斜纹：先按留空列建裁剪路径，再在裁剪区内画统一斜线
    outCtx.beginPath();
    let runStart = -1;
    const flush = (end) => { if (runStart >= 0) { outCtx.rect(runStart, 0, end - runStart, H); runStart = -1; } };
    for (let x = 0; x < W; x++) {
      if (noneCol[x] && runStart < 0) runStart = x;
      else if (!noneCol[x]) flush(x);
    }
    flush(W);
    outCtx.clip();
    outCtx.strokeStyle = 'rgba(90,90,90,.85)';
    outCtx.lineWidth = 1;
    outCtx.beginPath();
    for (let k = -H; k < W + H; k += 9) {
      outCtx.moveTo(k, 0);
      outCtx.lineTo(k + H, H);
    }
    outCtx.stroke();
    outCtx.restore();
  }

  /* ---------------- 点查询 ---------------- */

  function queryAt(px, py) {
    const x = Math.round(px), y = Math.round(py);
    if (state.mode === 'merge') {
      if (!state.merge) return;
      const info = M.traceOrigin(
        state.merge,
        { img: state.views.A.rendered },
        state.views.B.rendered && state.sim ? { img: state.views.B.rendered, M: state.sim.M } : null,
        x, y
      );
      state.query = { x, y, mode: 'merge', info };
      describeMergeQuery(info);
    } else {
      const key = state.activeView;
      const v = state.views[key];
      if (!v.warp) return;
      const i = y * state.outW + x;
      const q = G.unwrappedToSource(v.controls, x, y, state.outW, state.outH);
      state.query = { x, y, mode: 'unwarp', view: key, sx: q.sx, sy: q.sy };
      const st = v.warp.status[i];
      const stText = st === 0 ? '有效取样' : st === 1 ? '超取用角 · 留空' : '源图外 · 留空';
      document.getElementById('queryInfo').textContent =
        `展开图 (${x}, ${y}) → 视角 ${key} 源图 (${q.sx.toFixed(1)}, ${q.sy.toFixed(1)})\n` +
        `中心角 θ=${(q.theta * 180 / Math.PI).toFixed(1)}°，局部拉伸=${q.stretch.toFixed(2)}×，状态：${stText}`;
      drawSource();
    }
    refreshOutput();
  }

  function describeMergeQuery(info) {
    const srcName = { [M.SRC_NONE]: '无数据（背面未拍到，留空）', [M.SRC_A]: '仅视角 A', [M.SRC_B]: '仅视角 B', [M.SRC_BOTH]: 'A/B 重合' };
    let txt = `合并图 (${info.x}, ${info.y})：${srcName[info.source]}`;
    let jumpTo = null;
    if (info.source === M.SRC_BOTH) {
      txt += `\n亮度差 ΔY=${info.lumaDiff.toFixed(1)}（阈值 ${state.lumaThr}），融合模式：${blendName(state.blendMode)}`;
      const qa = G.unwrappedToSource(state.views.A.controls, info.a.localX, info.a.localY, state.outW, state.outH);
      txt += `\nA 源图坐标 (${qa.sx.toFixed(1)}, ${qa.sy.toFixed(1)})`;
      jumpTo = { view: 'A', sx: qa.sx, sy: qa.sy };
      if (info.b) {
        const qb = G.unwrappedToSource(state.views.B.controls, info.b.local[0], info.b.local[1], state.outW, state.outH);
        txt += `\nB 源图坐标 (${qb.sx.toFixed(1)}, ${qb.sy.toFixed(1)})`;
      }
    } else if (info.source === M.SRC_A && info.a) {
      const qa = G.unwrappedToSource(state.views.A.controls, info.a.localX, info.a.localY, state.outW, state.outH);
      txt += `\nA 源图坐标 (${qa.sx.toFixed(1)}, ${qa.sy.toFixed(1)})`;
      jumpTo = { view: 'A', sx: qa.sx, sy: qa.sy };
    } else if (info.source === M.SRC_B && info.b) {
      const qb = G.unwrappedToSource(state.views.B.controls, info.b.local[0], info.b.local[1], state.outW, state.outH);
      txt += `\nB 源图坐标 (${qb.sx.toFixed(1)}, ${qb.sy.toFixed(1)})`;
      jumpTo = { view: 'B', sx: qb.sx, sy: qb.sy };
    }
    document.getElementById('queryInfo').textContent = txt;
    // 在对应视角源图上画回跳高亮（自动切到该视角标签）
    if (jumpTo) {
      state.activeView = jumpTo.view;
      document.querySelectorAll('.tab[data-view]').forEach((t) =>
        t.classList.toggle('active', t.dataset.view === jumpTo.view));
      state.query = { x: info.x, y: info.y, mode: 'merge', info, view: jumpTo.view, sx: jumpTo.sx, sy: jumpTo.sy };
      drawSource();
    }
  }

  function blendName(m) {
    return { A: '只用 A', B: '只用 B', average: '平均', brighter: '取较亮' }[m];
  }

  function drawQueryOnOutput() {
    if (!state.query) return;
    const q = state.query;
    outCtx.save();
    outCtx.strokeStyle = '#ff3b3b';
    outCtx.lineWidth = 2;
    outCtx.beginPath(); outCtx.arc(q.x, q.y, 9, 0, Math.PI * 2); outCtx.stroke();
    outCtx.restore();
  }

  /* ---------------- 警告面板 ---------------- */

  function updateWarnings() {
    const box = document.getElementById('warnings');
    box.innerHTML = '';
    for (const key of ['A', 'B']) {
      const v = state.views[key];
      if (!v.controls || !v.img) continue;
      const w = v.img.naturalWidth || v.img.width, h = v.img.naturalHeight || v.img.height;
      const warns = G.controlWarnings(v.controls, w, h);
      const margin = R.edgeMargins(v.controls, w, h);
      if (margin < 12) warns.push({ level: 'warn', msg: `视角 ${key} 控制点距源图边缘仅 ${margin.toFixed(0)}px，展开采样可能落到图外（黄色列）` });
      // 源图边缘列统计
      if (v.warp) {
        const n2 = countStatus(v.warp, 2);
        if (n2 > 0) warns.push({ level: 'warn', msg: `视角 ${key} 有 ${n2} 个展开列落在源图外，已按留空处理` });
      }
      for (const it of warns) {
        const div = document.createElement('div');
        div.className = `warn-item ${it.level}`;
        div.textContent = `[${key}] ${it.msg}`;
        box.appendChild(div);
      }
    }
  }

  function countStatus(warp, st) {
    let n = 0;
    for (let x = 0; x < warp.W; x++) if (warp.status[x] === st) n++;
    return n;
  }

  function setHint(t) { document.getElementById('srcHint').textContent = t; }

  /* ---------------- 导入 / 导出 ---------------- */

  document.getElementById('btnExport').addEventListener('click', doExport);

  async function doExport() {
    const cfg = buildConfig();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // 1. 平面展开图
    downloadCanvas(outCanvas, `unwrapped-${stamp}.png`);
    // 2. 覆盖范围
    await delay(50);
    const cov = document.createElement('canvas');
    cov.width = state.outW; cov.height = state.outH;
    if (state.mode === 'merge' && state.merge) {
      M.drawCoverage(cov.getContext('2d'), state.merge, state.outW, state.outH);
    } else {
      const v = state.views[state.activeView];
      if (v.warp) cov.getContext('2d').putImageData(R.coverageImage(v.warp), 0, 0);
    }
    downloadCanvas(cov, `coverage-${stamp}.png`);
    // 3. 取样配置（含源图 dataURL，读回可直接还原并反查）
    await delay(50);
    cfg.images = {};
    for (const key of ['A', 'B']) {
      const v = state.views[key];
      if (v.img) cfg.images[key] = canvasToDataURL(v.img);
    }
    downloadText(JSON.stringify(cfg, null, 2), `cyl-config-${stamp}.json`, 'application/json');
  }

  function buildConfig() {
    const pick = (key) => {
      const v = state.views[key];
      if (!v.controls) return null;
      return {
        controls: v.controls,
        thetaLimitDeg: v.thetaLimit * 180 / Math.PI,
        sourceSize: [v.img.naturalWidth || v.img.width, v.img.naturalHeight || v.img.height],
      };
    };
    return {
      format: 'cyl-unwarp-config/1',
      exportedAt: new Date().toISOString(),
      output: { width: state.outW, height: state.outH },
      stretchWarn: state.stretchWarn,
      blendMode: state.blendMode,
      lumaThreshold: state.lumaThr,
      viewA: pick('A'),
      viewB: pick('B'),
      pairs: state.pairs,
      similarity: state.sim ? state.sim.M : null,
    };
  }

  function canvasToDataURL(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function downloadCanvas(cv, name) {
    cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
  function downloadText(text, name, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  document.getElementById('fileImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const cfg = JSON.parse(await file.text());
    await importConfig(cfg);
  });

  async function importConfig(cfg) {
    state.outW = cfg.output.width;
    state.outH = cfg.output.height;
    document.getElementById('outW').value = state.outW;
    document.getElementById('outH').value = state.outH;
    state.stretchWarn = cfg.stretchWarn ?? 2.5;
    state.blendMode = cfg.blendMode ?? 'A';
    state.lumaThr = cfg.lumaThreshold ?? 25;
    document.getElementById('blendMode').value = state.blendMode;
    document.getElementById('lumaThr').value = state.lumaThr;
    document.getElementById('lumaVal').textContent = state.lumaThr;
    for (const key of ['A', 'B']) {
      const spec = cfg[`view${key}`];
      const dataUrl = cfg.images && cfg.images[key];
      if (!spec || !dataUrl) continue;
      const img = await loadDataURL(dataUrl);
      const v = state.views[key];
      v.img = img;
      v.controls = spec.controls;
      v.thetaLimit = spec.thetaLimitDeg * Math.PI / 180;
      rebuildView(key);
    }
    state.pairs = (cfg.pairs || []).map((p) => ({ a: p.a, b: p.b }));
    updatePairUI();
    state.activeView = 'A';
    drawSource();
    refreshOutput();
    updateWarnings();
    setHint('配置已读回：在展开图点击任意像素，即可跳到对应源图位置。');
  }

  function loadDataURL(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  /* ---------------- 控件绑定 ---------------- */

  document.querySelectorAll('.tab[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeView = tab.dataset.view;
      document.querySelectorAll('.tab[data-view]').forEach((t) => t.classList.toggle('active', t === tab));
      drawSource();
      if (state.mode === 'unwarp') refreshOutput();
    });
  });
  document.querySelectorAll('.tab[data-mode]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode;
      document.querySelectorAll('.tab[data-mode]').forEach((t) => t.classList.toggle('active', t === tab));
      document.getElementById('fsUnwarp').classList.toggle('hidden', state.mode !== 'unwarp');
      document.getElementById('fsAlign').classList.toggle('hidden', state.mode !== 'align');
      document.getElementById('fsMerge').classList.toggle('hidden', state.mode !== 'merge');
      document.getElementById('legendUnwarp').classList.toggle('hidden', state.mode !== 'unwarp');
      document.getElementById('legendMerge').classList.toggle('hidden', state.mode !== 'merge');
      if (state.mode === 'align') {
        state.pairSide = state.views[state.pairSide === 'a' ? 'A' : 'B'].rendered ? state.pairSide : 'a';
        if (!state.views.A.rendered) state.pairSide = 'a';
        document.getElementById('pairSide').value = state.pairSide;
      }
      refreshOutput();
    });
  });

  document.getElementById('thetaLimit').addEventListener('input', (e) => {
    const deg = parseInt(e.target.value, 10);
    document.getElementById('thetaVal').textContent = `${deg}°`;
    const v = state.views[state.activeView];
    if (!v.controls) return;
    v.thetaLimit = deg * Math.PI / 180;
    rebuildView(state.activeView);
    refreshOutput();
    updateWarnings();
  });
  document.getElementById('stretchWarn').addEventListener('input', (e) => {
    state.stretchWarn = parseFloat(e.target.value);
    document.getElementById('stretchVal').textContent = `${state.stretchWarn.toFixed(1)}×`;
    refreshOutput();
  });
  document.getElementById('showHatch').addEventListener('change', (e) => { state.showHatch = e.target.checked; refreshOutput(); });
  document.getElementById('showStretch').addEventListener('change', (e) => { state.showStretch = e.target.checked; refreshOutput(); });
  document.getElementById('blendMode').addEventListener('change', (e) => { state.blendMode = e.target.value; state.merge = null; refreshOutput(); });
  document.getElementById('lumaThr').addEventListener('input', (e) => {
    state.lumaThr = parseInt(e.target.value, 10);
    document.getElementById('lumaVal').textContent = state.lumaThr;
    refreshOutput();
  });
  document.getElementById('showCoverage').addEventListener('change', (e) => { state.showCoverage = e.target.checked; refreshOutput(); });
  document.getElementById('showLuma').addEventListener('change', (e) => { state.showLuma = e.target.checked; refreshOutput(); });

  // 初始空状态
  drawSource();
  refreshOutput();

  // 调试/自动化钩子：仅用于 headless 测试读取内部状态，不影响正常交互
  window.__cylState = state;
})();
