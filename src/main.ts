import { Engine, EngineConfig, InputEvent, Cand, replayAtFps } from './engine.js';
import { DEFAULT_CONFIG, SAMPLE_GROUPS, Sample } from './samples.js';

// ---------------- 状态 ----------------
let cfg: EngineConfig = structuredClone(DEFAULT_CONFIG);
let events: InputEvent[] = [];
let engine: Engine = new Engine(cfg);
let playing = false;
let speed = 1;
let lastFrameReal = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $('cv') as HTMLCanvasElement;
const ctx = cv.getContext('2d')!;
const logEl = $('log');
const cfgTextEl = $('cfgText') as unknown as HTMLTextAreaElement;
const clockEl = $('clock');

// ---------------- 引擎生命周期 ----------------
function rebuild(runToT = 0): void {
  renderedLogs = 0;
  logEl.innerHTML = '';
  engine = new Engine(cfg);
  engine.load(events);
  if (runToT > 0) engine.runTo(runToT);
  renderAll();
}

function currentEventsFromTable(): InputEvent[] {
  const rows = [...document.querySelectorAll<HTMLTableRowElement>('#evTable tbody tr')];
  return rows.map((tr, i) => ({
    id: i + 1,
    t: Number((tr.querySelector('.ev-t') as HTMLInputElement).value) || 0,
    key: (tr.querySelector('.ev-k') as HTMLInputElement).value.trim() || 'A',
    type: (tr.querySelector('.ev-y') as HTMLSelectElement).value as 'down' | 'up',
  }));
}

// ---------------- 样例 ----------------
function loadSample(s: Sample): void {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfgTextEl.value = JSON.stringify(cfg, null, 2);
  events = s.events.map(e => ({ ...e }));
  $('note').textContent = s.note;
  renderEventTable();
  rebuild();
}

function buildSampleButtons(): void {
  const host = $('sampleBtns');
  for (const g of SAMPLE_GROUPS) {
    const title = document.createElement('div');
    title.className = 'groupdesc';
    title.innerHTML = `<b style="color:var(--fg)">${g.name}</b> — ${g.desc}`;
    host.appendChild(title);
    const row = document.createElement('div');
    for (const s of g.samples) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.onclick = () => {
        [...row.parentElement!.querySelectorAll('button')].forEach(x => x.classList.remove('active'));
        document.querySelectorAll('#sampleBtns button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        loadSample(s);
      };
      row.appendChild(b);
    }
    host.appendChild(row);
  }
}

// ---------------- 事件表 ----------------
function renderEventTable(): void {
  const tb = document.querySelector('#evTable tbody')!;
  tb.innerHTML = '';
  events.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td>
      <td><input class="ev-t" type="number" value="${e.t}"></td>
      <td><input class="ev-k" value="${e.key}"></td>
      <td><select class="ev-y">
        <option value="down" ${e.type === 'down' ? 'selected' : ''}>down</option>
        <option value="up" ${e.type === 'up' ? 'selected' : ''}>up</option>
      </select></td>
      <td><button class="ev-del">✕</button></td>`;
    tr.querySelector('.ev-del')!.addEventListener('click', () => { tr.remove(); });
    tb.appendChild(tr);
  });
}

// ---------------- 画布 ----------------
const LEFT = 130, TOP = 22, KEY_H = 24, CAND_H = 15, ACT_H = 40, BUF_H = 18, PXM = 0.45;

function drawShape(shape: string, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
  else if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); }
  else { // pentagon
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
}

function renderCanvas(): void {
  const keys = [...new Set([...events.map(e => e.key),
    ...cfg.commands.flatMap(c => c.steps.flatMap(s => s.kind === 'chord' ? s.keys : [s.key]))])].sort();
  const cands = engine.cands;
  const dur = Math.max(
    800,
    ...events.map(e => e.t),
    ...cands.map(c => c.deadT ?? c.fireT ?? 0),
    ...engine.episodes.map(a => a.endT),
    engine.now,
  ) + 250;
  const W = LEFT + dur * PXM + 60;
  const yKeys = TOP;
  const yCands = yKeys + keys.length * KEY_H + 14;
  const yActs = yCands + cands.length * CAND_H + 14;
  const yBuf = yActs + ACT_H + 6;
  const H = yBuf + BUF_H + 12;
  cv.width = W; cv.height = H;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.font = '11px Menlo, monospace';
  ctx.textBaseline = 'middle';

  const X = (t: number) => LEFT + t * PXM;

  // 时间轴
  ctx.fillStyle = '#8b96a5';
  for (let t = 0; t <= dur; t += 100) {
    ctx.fillRect(X(t), TOP - 6, 1, H - TOP);
    ctx.fillText(String(t), X(t) + 3, 8);
  }

  // 键行：按下/松开事件 + 按住区间
  keys.forEach((k, i) => {
    const y = yKeys + i * KEY_H + KEY_H / 2;
    ctx.fillStyle = '#8b96a5';
    ctx.fillText(`键 ${k}`, 8, y);
    let downT: number | null = null;
    for (const e of engine.events.length ? engine.events : events) {
      if (e.key !== k) continue;
      if (e.t > engine.now) break;
      if (e.type === 'down') {
        if (downT !== null) { // 重复上报：画虚线标记
          ctx.strokeStyle = '#616e7a'; ctx.setLineDash([2, 2]);
          ctx.strokeRect(X(e.t) - 3, y - 5, 6, 10); ctx.setLineDash([]);
        }
        downT = e.t;
        ctx.fillStyle = '#4fc3f7';
        ctx.beginPath(); ctx.moveTo(X(e.t), y - 7); ctx.lineTo(X(e.t) + 5, y - 1); ctx.lineTo(X(e.t) - 5, y - 1); ctx.fill();
      } else {
        if (downT !== null) {
          ctx.fillStyle = 'rgba(79,195,247,0.25)';
          ctx.fillRect(X(downT), y - 4, X(e.t) - X(downT), 8);
          downT = null;
        }
        ctx.strokeStyle = '#4fc3f7';
        ctx.beginPath(); ctx.moveTo(X(e.t), y + 7); ctx.lineTo(X(e.t) + 5, y + 1); ctx.lineTo(X(e.t) - 5, y + 1); ctx.stroke();
      }
    }
    if (downT !== null) {
      ctx.fillStyle = 'rgba(79,195,247,0.25)';
      ctx.fillRect(X(downT), y - 4, X(engine.now) - X(downT), 8);
    }
  });

  // 候选泳道
  ctx.fillStyle = '#8b96a5'; ctx.fillText('候选（进度/丢弃原因）', 8, yCands - 7);
  cands.forEach((c: Cand, i: number) => {
    const y = yCands + i * CAND_H + CAND_H / 2;
    const end = c.deadT ?? c.fireT ?? engine.now;
    ctx.fillStyle = '#8b96a5';
    ctx.fillText(`#${c.id} ${c.cmd.name}`, 8, y);
    const alpha = c.state === 'dead' ? 0.22 : c.state === 'pending' ? 0.45 : 0.85;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c.state === 'dead' ? '#9aa5b1' : c.cmd.color;
    ctx.fillRect(X(c.startT), y - 5, Math.max(2, X(end) - X(c.startT)), 10);
    ctx.globalAlpha = 1;
    // 步骤完成刻度
    ctx.fillStyle = '#10141a';
    for (const st of c.stepDoneTs) ctx.fillRect(X(st) - 1, y - 5, 2, 10);
    // 状态标注
    if (c.state === 'pending') {
      ctx.fillStyle = '#ffb74d';
      ctx.fillText('⏳ 等待后续输入…', X(end) + 5, y);
    } else if (c.state === 'dead') {
      ctx.fillStyle = '#e57373';
      ctx.fillText('✕ ' + (c.deadReason ?? ''), X(end) + 5, y);
    } else if (c.state === 'fired') {
      drawShape(c.cmd.shape, X(c.fireT!) + 8, y, 6, c.cmd.color);
      ctx.fillStyle = c.cmd.color;
      ctx.fillText(`生效@${c.fireT}`, X(c.fireT!) + 18, y);
    }
  });

  // 动作行
  const yA = yActs + ACT_H / 2;
  ctx.fillStyle = '#8b96a5'; ctx.fillText('动作', 8, yA);
  for (const a of engine.episodes) {
    const shownEnd = Math.min(a.endT, engine.now);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = a.color;
    ctx.fillRect(X(a.startT), yA - 13, X(a.endT) - X(a.startT), 26); // 计划时长
    ctx.globalAlpha = 0.9;
    ctx.fillRect(X(a.startT), yA - 13, Math.max(0, X(shownEnd) - X(a.startT)), 26); // 已进行
    ctx.globalAlpha = 1;
    drawShape(a.shape, X(a.startT) + 12, yA, 8, '#10141a');
    ctx.fillStyle = '#10141a';
    ctx.fillText(`${a.name}(${a.source})`, X(a.startT) + 24, yA);
  }
  if (engine.action) {
    ctx.fillStyle = '#ffd54f';
    ctx.fillText(`进行中：${engine.action.cmd.name}${engine.action.cmd.interruptible ? '(可打断)' : '(不可打断)'}`,
      X(engine.action.endT) + 6, yA);
  }

  // 预存行
  ctx.fillStyle = '#8b96a5'; ctx.fillText('预存', 8, yBuf + BUF_H / 2);
  if (engine.buffered) {
    const b = engine.buffered;
    ctx.fillStyle = 'rgba(206,147,216,0.5)';
    ctx.fillRect(X(b.t), yBuf + 3, X(Math.min(b.expireAt, engine.now)) - X(b.t), BUF_H - 6);
    ctx.fillStyle = '#ce93d8';
    ctx.fillText(`「${b.cmd.name}」预存中，${b.expireAt}ms 失效`, X(b.t) + 4, yBuf + BUF_H / 2);
  }

  // 播放头
  ctx.strokeStyle = '#ef5350';
  ctx.beginPath(); ctx.moveTo(X(engine.now), 0); ctx.lineTo(X(engine.now), H); ctx.stroke();
}

// ---------------- 日志 ----------------
let renderedLogs = 0;
function renderLog(): void {
  for (; renderedLogs < engine.log.length; renderedLogs++) {
    const l = engine.log[renderedLogs];
    const d = document.createElement('div');
    d.className = 'lg-' + l.kind;
    d.textContent = `[${String(l.t).padStart(5)}ms] ${l.text}`;
    logEl.appendChild(d);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function renderAll(): void {
  clockEl.textContent = `t = ${Math.round(engine.now)} ms`;
  renderCanvas();
  renderLog();
}

// ---------------- 播放 ----------------
function tick(realT: number): void {
  if (!playing) return;
  const dt = Math.min(100, realT - lastFrameReal);
  lastFrameReal = realT;
  engine.runTo(engine.now + dt * speed);
  renderAll();
  if (engine.finished && engine.now > durEnd() + 600) { setPlaying(false); return; }
  requestAnimationFrame(tick);
}
function durEnd(): number {
  return Math.max(0, ...events.map(e => e.t));
}
function setPlaying(p: boolean): void {
  playing = p;
  $('playBtn').textContent = p ? '⏸ 暂停' : '▶ 播放';
  if (p) { lastFrameReal = performance.now(); requestAnimationFrame(tick); }
}

$('playBtn').onclick = () => setPlaying(!playing);
$('stepBtn').onclick = () => { setPlaying(false); engine.stepToNextEvent(); renderAll(); };
$('resetBtn').onclick = () => { setPlaying(false); rebuild(); };
$('speed').onchange = (e) => { speed = Number((e.target as HTMLSelectElement).value); };

// ---------------- 配置 / 事件编辑 ----------------
$('applyCfg').onclick = () => {
  try {
    cfg = JSON.parse(cfgTextEl.value);
    setPlaying(false);
    rebuild();
  } catch (err) { alert('配置 JSON 解析失败：' + err); }
};
$('resetCfg').onclick = () => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfgTextEl.value = JSON.stringify(cfg, null, 2);
  setPlaying(false);
  rebuild();
};
$('applyEvents').onclick = () => {
  const keepT = engine.now;
  events = currentEventsFromTable();
  setPlaying(false);
  rebuild(keepT); // 编辑一条事件后重跑到原时刻
  renderEventTable();
};
$('addEvent').onclick = () => {
  events = currentEventsFromTable();
  const lastT = events.reduce((m, e) => Math.max(m, e.t), 0);
  events.push({ id: events.length + 1, t: lastT + 100, key: 'A', type: 'down' });
  renderEventTable();
};

// ---------------- 帧率无关性重放 ----------------
$('runFps').onclick = () => {
  const fpsList = [24, 30, 60, 144];
  const results = fpsList.map(fps => ({ fps, r: replayAtFps(cfg, currentEventsFromTable(), fps) }));
  const base = JSON.stringify({ a: results[0].r.actions, c: results[0].r.consumed });
  let html = `<table><tr><th>fps</th><th>动作序列（名称@开始ms·来源）</th><th>消费事件</th><th>与基准一致</th></tr>`;
  for (const { fps, r } of results) {
    const same = JSON.stringify({ a: r.actions, c: r.consumed }) === base;
    html += `<tr><td>${fps}</td><td>${r.actions.join(' → ') || '(无)'}</td>
      <td>${r.consumed.map(i => '#' + i).join(' ') || '(无)'}</td>
      <td class="${same ? 'ok' : 'bad'}">${same ? '✓ 相同' : '✗ 不同'}</td></tr>`;
  }
  html += '</table>';
  $('fpsOut').innerHTML = html;
};

// ---------------- 启动 ----------------
buildSampleButtons();
cfgTextEl.value = JSON.stringify(cfg, null, 2);
loadSample(SAMPLE_GROUPS[1].samples[0]); // 默认展示 2a：单按A → 轻击挂起后生效
