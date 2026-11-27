'use strict';

/* ================= 状态 ================= */
const state = {
  source: null,      // { name, W, H, fps, frames: [ImageData] }
  fieldOrder: 'TFF', // TFF: 顶场(偶数行)先, BFF: 底场(奇数行)先
  outIndex: 0,       // 输出时间轴位置（场率，单位=一场）
  playing: false,
  methodL: 'weave',
  methodR: 'adaptive',
  roi: null,         // {x,y,w,h} 源坐标
};

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= 时间轴模型 ================= */
// 输出时间轴以“场”为单位：k ∈ [0, 2N)
const frameCount = () => state.source ? state.source.frames.length : 0;
const fieldCount = () => frameCount() * 2;
const fieldRate  = () => state.source.fps * 2;
const frameOf    = k => k >> 1;
// 第 k 场对应的行奇偶：TFF 时帧内第1场=偶数行(0)，BFF 时第1场=奇数行(1)
const parityOf   = k => (k & 1) ^ (state.fieldOrder === 'BFF' ? 1 : 0);
const parityName = p => p === 0 ? '顶场（偶数行）' : '底场（奇数行）';

/* ================= 去隔行算法 ================= */
// Bob：单场放大，缺失行用当前场上下行插值
function bobFrame(id, parity) {
  const W = id.width, H = id.height;
  const s = id.data;
  const out = new ImageData(W, H);
  const d = out.data;
  for (let y = 0; y < H; y++) {
    if ((y & 1) === parity) {
      d.set(s.subarray(y * W * 4, (y + 1) * W * 4), y * W * 4);
    } else {
      const y0 = Math.max(y - 1, 0), y1 = Math.min(y + 1, H - 1);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, o0 = (y0 * W + x) * 4, o1 = (y1 * W + x) * 4;
        d[o]     = (s[o0]     + s[o1])     >> 1;
        d[o + 1] = (s[o0 + 1] + s[o1 + 1]) >> 1;
        d[o + 2] = (s[o0 + 2] + s[o1 + 2]) >> 1;
        d[o + 3] = 255;
      }
    }
  }
  return out;
}

// 运动自适应（三场检测）：静止区域编织（保留另一场原行，静止细线不丢），
// 运动区域改用当前场插值（不再保留梳齿）。
// 运动判据：当前帧另一场的行 与 参考帧（前一帧，首帧取后一帧）同位置行 的差异——
// 静止内容跨帧不变，1px 静止细线不会被误判为运动。
function adaptiveFrame(id, parity, refId, thresh = 32) {
  const W = id.width, H = id.height;
  const s = id.data, r = refId.data;
  const out = new ImageData(W, H);
  const d = out.data;
  for (let y = 0; y < H; y++) {
    if ((y & 1) === parity) {
      d.set(s.subarray(y * W * 4, (y + 1) * W * 4), y * W * 4);
      continue;
    }
    const y0 = Math.max(y - 1, 0), y1 = Math.min(y + 1, H - 1);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, o0 = (y0 * W + x) * 4, o1 = (y1 * W + x) * 4;
      // 另一场原行 与 参考帧同位置行 的差异 → 运动检测
      const diff = Math.max(
        Math.abs(s[o] - r[o]),
        Math.abs(s[o + 1] - r[o + 1]),
        Math.abs(s[o + 2] - r[o + 2])
      );
      if (diff > thresh) { // 运动：当前场上下行插值，消除梳齿
        d[o]     = (s[o0]     + s[o1])     >> 1;
        d[o + 1] = (s[o0 + 1] + s[o1 + 1]) >> 1;
        d[o + 2] = (s[o0 + 2] + s[o1 + 2]) >> 1;
      } else {             // 静止：编织，保留原行（细线不丢）
        d[o] = s[o]; d[o + 1] = s[o + 1]; d[o + 2] = s[o + 2];
      }
      d[o + 3] = 255;
    }
  }
  return out;
}

function renderMethodToCanvas(method, k, canvas) {
  const i = frameOf(k);
  const id = state.source.frames[i];
  const p = parityOf(k);
  const ctx = canvas.getContext('2d');
  if (method === 'weave') ctx.putImageData(id, 0, 0);
  else if (method === 'bob') ctx.putImageData(bobFrame(id, p), 0, 0);
  else {
    const N = frameCount();
    const ref = state.source.frames[i > 0 ? i - 1 : (N > 1 ? 1 : 0)];
    ctx.putImageData(adaptiveFrame(id, p, ref), 0, 0);
  }
}

/* ================= 样片生成 ================= */
// 一场画面：移动斜边 + 旋转指针 + 静止细线
function renderScene(ctx, t, k, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3a3f4a'); g.addColorStop(1, '#22242a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 1) 移动斜边（左上区域，匀速右移，循环）
  const x = 30 + ((t * 90) % 230);
  ctx.fillStyle = '#e8e8e8';
  ctx.beginPath();
  ctx.moveTo(x, 30); ctx.lineTo(x + 60, 30);
  ctx.lineTo(x + 20, 160); ctx.lineTo(x - 40, 160);
  ctx.closePath(); ctx.fill();

  // 2) 静止细线（右上区域，1px 横线，每行只属于一个场）
  ctx.fillStyle = '#101014'; ctx.fillRect(280, 30, 180, 130);
  ctx.fillStyle = '#f5f5f5';
  for (let y = 32; y < 158; y += 4) ctx.fillRect(280, y, 180, 1);

  // 3) 旋转指针（下方表盘）
  const cx = 240, cy = 265, r = 70;
  ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  const ang = -Math.PI / 2 + t * Math.PI * 2 / 1.5; // 1.5s 一圈
  ctx.strokeStyle = '#ff4d4f'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * (r - 14), cy + Math.sin(ang) * (r - 14));
  ctx.stroke();
  ctx.fillStyle = '#ff4d4f';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

  // 场序号烧录，便于逐场核对
  ctx.font = '12px monospace';
  ctx.fillStyle = '#000';
  ctx.fillText(`t=${t.toFixed(3)}s field#${k}`, 9, H - 9);
  ctx.fillStyle = '#ffe95e';
  ctx.fillText(`t=${t.toFixed(3)}s field#${k}`, 8, H - 10);
}

// swapped=false：帧i = 场2i(偶行)+场2i+1(奇行)，时间顺序正确
// swapped=true ：帧i = 场2i+1(偶行)+场2i(奇行)，帧内时间顺序颠倒 → 运动来回顿挫
function generateSample(name, swapped) {
  const W = 480, H = 360, fps = 25, secs = 3;
  const N = fps * secs;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const fields = [];
  for (let k = 0; k < N * 2; k++) {
    renderScene(ctx, k / (fps * 2), k, W, H);
    fields.push(ctx.getImageData(0, 0, W, H));
  }
  const frames = [];
  for (let i = 0; i < N; i++) {
    const evenSrc = fields[swapped ? 2 * i + 1 : 2 * i];
    const oddSrc  = fields[swapped ? 2 * i     : 2 * i + 1];
    const out = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      const src = (y & 1) === 0 ? evenSrc : oddSrc;
      out.data.set(src.data.subarray(y * W * 4, (y + 1) * W * 4), y * W * 4);
    }
    frames.push(out);
  }
  setSource({ name, W, H, fps, frames });
}

/* ================= 视频导入 ================= */
async function importVideo(file) {
  setStatus('导入中：需完整播放一遍以逐帧抓取…');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.src = url;
  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error('视频无法解码'));
  });

  const scale = Math.min(1, 480 / video.videoWidth);
  const W = Math.floor(video.videoWidth * scale / 2) * 2;
  const H = Math.floor(video.videoHeight * scale / 2) * 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const MAXF = 300;
  const frames = [];
  let lastMediaTime = -1;
  await video.play();
  await new Promise(resolve => {
    const onFrame = (now, meta) => {
      if (meta.mediaTime !== lastMediaTime) {
        lastMediaTime = meta.mediaTime;
        ctx.drawImage(video, 0, 0, W, H);
        frames.push(ctx.getImageData(0, 0, W, H));
        setStatus(`导入中… 已抓取 ${frames.length} 帧`);
      }
      if (frames.length >= MAXF) { video.pause(); resolve(); return; }
      video.requestVideoFrameCallback(onFrame);
    };
    video.onended = resolve;
    video.requestVideoFrameCallback(onFrame);
  });
  URL.revokeObjectURL(url);
  if (!frames.length) { setStatus('未抓到任何帧'); return; }
  const dur = video.duration;
  const fps = (isFinite(dur) && dur > 0) ? frames.length / dur : 25;
  setSource({ name: file.name, W, H, fps, frames });
  setStatus('');
}

/* ================= 片源装载 ================= */
function setSource(src) {
  pause();
  state.source = src;
  state.outIndex = 0;
  state.roi = {
    x: Math.round(src.W / 2 - 80), y: Math.round(src.H / 2 - 60),
    w: 160, h: 120,
  };
  for (const id of ['frameView', 'fieldView', 'viewL', 'viewR']) {
    $(id).width = src.W; $(id).height = src.H;
  }
  $('fieldA').width = src.W / 2; $('fieldA').height = src.H / 2;
  $('fieldB').width = src.W / 2; $('fieldB').height = src.H / 2;
  $('slider').max = fieldCount() - 1;
  $('slider').value = 0;
  $('srcInfo').textContent =
    `${src.name} · ${src.W}×${src.H} · ${src.frames.length} 帧 / ${fieldCount()} 场 · ` +
    `${src.fps.toFixed(2)} fps · 时长 ${(src.frames.length / src.fps).toFixed(2)}s`;
  renderAll();
}

/* ================= 渲染 ================= */
const tmpCanvas = document.createElement('canvas');
function putScaled(id, canvas) {
  tmpCanvas.width = id.width; tmpCanvas.height = id.height;
  tmpCanvas.getContext('2d').putImageData(id, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, 0, canvas.width, canvas.height);
}

function renderAll() {
  const src = state.source;
  if (!src) return;
  const k = state.outIndex;
  const i = frameOf(k);
  const p = parityOf(k);
  const id = src.frames[i];

  // 帧预览（交织原帧）
  const fv = $('frameView').getContext('2d');
  fv.putImageData(id, 0, 0);
  if ($('tintToggle').checked) {
    fv.fillStyle = 'rgba(255,80,80,0.18)';
    for (let y = p; y < src.H; y += 2) fv.fillRect(0, y, src.W, 1);
  }

  // 两场并列（按实际时间先后）
  const firstP = state.fieldOrder === 'BFF' ? 1 : 0;
  putScaled(bobFrame(id, firstP), $('fieldA'));
  putScaled(bobFrame(id, firstP ^ 1), $('fieldB'));
  const t0 = i / src.fps, dt = 1 / (src.fps * 2);
  $('fieldALabel').textContent = `场①（先）${parityName(firstP)} · t=${t0.toFixed(3)}s`;
  $('fieldBLabel').textContent = `场②（后）${parityName(firstP ^ 1)} · t=${(t0 + dt).toFixed(3)}s`;

  // 场步进视图
  $('fieldView').getContext('2d').putImageData(bobFrame(id, p), 0, 0);
  $('fieldViewLabel').textContent =
    `第 ${i + 1}/${frameCount()} 帧 · 帧内第 ${(k & 1) + 1} 场 · ${parityName(p)} · ` +
    `t=${(k / fieldRate()).toFixed(3)}s`;

  renderCompare();
  updateTransport();
}

const offL = document.createElement('canvas');
const offR = document.createElement('canvas');

function renderCompare() {
  const src = state.source;
  const k = state.outIndex;
  offL.width = src.W; offL.height = src.H;
  offR.width = src.W; offR.height = src.H;
  renderMethodToCanvas(state.methodL, k, offL);
  renderMethodToCanvas(state.methodR, k, offR);

  for (const [view, off] of [[$('viewL'), offL], [$('viewR'), offR]]) {
    const ctx = view.getContext('2d');
    ctx.drawImage(off, 0, 0);
    const r = state.roi;
    ctx.strokeStyle = '#ffe95e'; ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
  }
  // 局部放大（最近邻，梳齿看得清）
  for (const [zoom, off] of [[$('zoomL'), offL], [$('zoomR'), offR]]) {
    const ctx = zoom.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, zoom.width, zoom.height);
    const r = state.roi;
    ctx.drawImage(off, r.x, r.y, r.w, r.h, 0, 0, zoom.width, zoom.height);
  }
}

function updateTransport() {
  const k = state.outIndex;
  $('slider').value = k;
  $('timeLabel').textContent =
    `场 ${k + 1}/${fieldCount()} · 帧 ${frameOf(k) + 1}/${frameCount()} · ` +
    `t=${(k / fieldRate()).toFixed(3)}s`;
}

/* ================= 走带控制 ================= */
function setOutIndex(k) {
  state.outIndex = Math.max(0, Math.min(fieldCount() - 1, k));
  renderAll();
}
let rafId = null, lastTs = null, acc = 0;
function playTick(ts) {
  if (!state.playing) return;
  if (lastTs === null) lastTs = ts;
  acc += (ts - lastTs) / 1000;
  lastTs = ts;
  const step = 1 / fieldRate();
  let moved = false;
  while (acc >= step) {
    acc -= step;
    if (state.outIndex < fieldCount() - 1) { state.outIndex++; moved = true; }
    else { pause(); break; }
  }
  if (moved) renderAll();
  if (state.playing) rafId = requestAnimationFrame(playTick);
}
function play() {
  if (!state.source || state.playing) return;
  if (state.outIndex >= fieldCount() - 1) state.outIndex = 0;
  state.playing = true;
  lastTs = null; acc = 0;
  $('playBtn').textContent = '⏸ 暂停';
  rafId = requestAnimationFrame(playTick);
}
function pause() {
  state.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  $('playBtn').textContent = '▶ 播放';
  if (state.source) updateTransport();
}

/* ================= 导出 ================= */
function buildManifest(method) {
  const src = state.source;
  const N = frameCount(), total = fieldCount(), fr = fieldRate();
  const frames = [];
  for (let k = 0; k < total; k++) {
    frames.push({
      out: k,
      time: +(k / fr).toFixed(4),
      srcFrame: frameOf(k),
      fieldSeqInFrame: (k & 1) + 1,
      field: parityOf(k) === 0 ? 'top(even)' : 'bottom(odd)',
    });
  }
  const last = frames[frames.length - 1];
  return {
    source: src.name,
    method,
    fieldOrder: state.fieldOrder,
    sourceFps: +src.fps.toFixed(4),
    outputFps: +fr.toFixed(4),
    sourceFrames: N,
    outputFrames: total,
    duration: +(N / src.fps).toFixed(4),
    frames,
    tailCheck: {
      expectedLast: { srcFrame: N - 1, fieldSeqInFrame: 2 },
      actualLast: { srcFrame: last.srcFrame, fieldSeqInFrame: last.fieldSeqInFrame },
      complete: last.srcFrame === N - 1 && last.fieldSeqInFrame === 2,
    },
  };
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function setStatus(t) { $('exportStatus').textContent = t; }

async function exportVideo() {
  const src = state.source;
  if (!src) return;
  pause();
  const method = $('exportMethod').value;
  const total = fieldCount(), fr = fieldRate();
  const cv = document.createElement('canvas');
  cv.width = src.W; cv.height = src.H;
  const stream = cv.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => rec.onstop = r);
  rec.start();
  const frameMs = 1000 / fr;
  for (let k = 0; k < total; k++) {
    renderMethodToCanvas(method, k, cv);
    track.requestFrame();
    setStatus(`导出中… ${k + 1}/${total}`);
    await sleep(frameMs);
  }
  rec.stop();
  await stopped;
  download(new Blob(chunks, { type: 'video/webm' }),
    `deint_${method}_${Date.now()}.webm`);
  download(new Blob([JSON.stringify(buildManifest(method), null, 2)],
    { type: 'application/json' }),
    `deint_${method}_manifest.json`);
  setStatus(`完成：${total} 场输出，时长 ${(frameCount() / src.fps).toFixed(2)}s`);
}

/* ================= 事件绑定 ================= */
$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) importVideo(e.target.files[0]).catch(err => setStatus(err.message));
  e.target.value = '';
});
$('genGood').addEventListener('click', () => generateSample('样片-顺序正确', false));
$('genBad').addEventListener('click', () => generateSample('样片-顺序错误', true));

document.querySelectorAll('input[name=fieldOrder]').forEach(r =>
  r.addEventListener('change', () => {
    state.fieldOrder = r.value;
    if (state.source) renderAll();
  }));

$('playBtn').addEventListener('click', () => state.playing ? pause() : play());
$('prevField').addEventListener('click', () => { pause(); setOutIndex(state.outIndex - 1); });
$('nextField').addEventListener('click', () => { pause(); setOutIndex(state.outIndex + 1); });
$('prevFrame').addEventListener('click', () => { pause(); setOutIndex((frameOf(state.outIndex) - 1) * 2); });
$('nextFrame').addEventListener('click', () => { pause(); setOutIndex((frameOf(state.outIndex) + 1) * 2); });
$('slider').addEventListener('input', () => { pause(); setOutIndex(+$('slider').value); });

$('methodL').addEventListener('change', e => { state.methodL = e.target.value; if (state.source) renderCompare(); });
$('methodR').addEventListener('change', e => { state.methodR = e.target.value; if (state.source) renderCompare(); });
$('tintToggle').addEventListener('change', () => state.source && renderAll());

$('exportBtn').addEventListener('click', () => exportVideo().catch(err => setStatus('导出失败: ' + err.message)));
$('manifestBtn').addEventListener('click', () => {
  if (!state.source) return;
  const method = $('exportMethod').value;
  download(new Blob([JSON.stringify(buildManifest(method), null, 2)],
    { type: 'application/json' }), `deint_${method}_manifest.json`);
});

// ROI 框选（左右画面均可拖拽）
for (const viewId of ['viewL', 'viewR']) {
  const view = $(viewId);
  let start = null;
  view.addEventListener('mousedown', e => {
    if (!state.source) return;
    start = { x: e.offsetX, y: e.offsetY };
    const onMove = ev => {
      const rect = view.getBoundingClientRect();
      const W = state.source.W, H = state.source.H;
      const cur = {
        x: Math.max(0, Math.min(W, ev.clientX - rect.left)),
        y: Math.max(0, Math.min(H, ev.clientY - rect.top)),
      };
      state.roi = {
        x: Math.round(Math.min(start.x, cur.x)),
        y: Math.round(Math.min(start.y, cur.y)),
        w: Math.max(16, Math.round(Math.abs(cur.x - start.x))),
        h: Math.max(16, Math.round(Math.abs(cur.y - start.y))),
      };
      state.roi.w = Math.min(state.roi.w, W - state.roi.x);
      state.roi.h = Math.min(state.roi.h, H - state.roi.y);
      renderCompare();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

window.addEventListener('keydown', e => {
  if (!state.source || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === 'ArrowLeft') { pause(); setOutIndex(state.outIndex - (e.shiftKey ? 2 : 1)); }
  else if (e.key === 'ArrowRight') { pause(); setOutIndex(state.outIndex + (e.shiftKey ? 2 : 1)); }
});

// 启动自带正确顺序样片，便于立即查看
generateSample('样片-顺序正确', false);
