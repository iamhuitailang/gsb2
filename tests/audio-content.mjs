#!/usr/bin/env node
/**
 * 音频内容级验证：通过实际离线渲染的采样数据，证明
 * 1. 静音片段区域确实无声（独奏隔离后）
 * 2. 音量自动化使电平随时间平滑变化
 * 3. 全静音工程输出全零但时长保留
 * 4. 空轨道不影响混音结果
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9338;
const profile = join(tmpdir(), `chrome-content-${process.pid}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  'http://127.0.0.1:4173/',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('4173'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(200);
  }
  throw new Error('Chrome 未就绪');
}

const ws = new WebSocket(await getWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send('Runtime.enable');
await sleep(2500);

/** 渲染给定工程并返回分段峰值/RMS，全部在页面内计算，只回传统计数字 */
const harness = `(async () => {
  const store = window.__store;
  const engine = window.__engine;
  const ctx = await engine.ensureContext();

  // 把 Blob 解码为可分析的峰值序列
  async function renderStats(project, windows) {
    const blob = await window.__exportMix(project, ctx, () => {});
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const rate = dv.getUint32(24, true);
    const frames = (buf.length - 44) / 4;
    const sample = (i, ch) => dv.getInt16(44 + (i * 2 + ch) * 2, true) / 32768;
    const winStats = windows.map(([a, b]) => {
      let peak = 0, sumSq = 0, n = 0;
      for (let i = Math.floor(a * rate); i < Math.min(frames, Math.floor(b * rate)); i++) {
        for (let ch = 0; ch < 2; ch++) {
          const v = sample(i, ch);
          const abs = Math.abs(v);
          if (abs > peak) peak = abs;
          sumSq += v * v; n++;
        }
      }
      return { peak, rms: Math.sqrt(sumSq / Math.max(1, n)) };
    });
    let globalPeak = 0;
    for (let i = 0; i < frames; i++) for (let ch = 0; ch < 2; ch++) globalPeak = Math.max(globalPeak, Math.abs(sample(i, ch)));
    return { lengthSec: frames / rate, globalPeak, windows: winStats };
  }

  const base = JSON.parse(JSON.stringify(store.project));
  const results = {};

  // --- A. 独奏鼓轨：14-18s 的鼓片段被静音 → 该区间应无声；0-8s 有声 ---
  const soloDrum = JSON.parse(JSON.stringify(base));
  soloDrum.tracks.forEach((t, i) => { t.solo = i === 0; t.muted = false; });
  results.A = await renderStats(soloDrum, [[0.5, 1.5], [14.5, 15.5], [16, 17]]);

  // --- B. 自动化：鼓轨 0s=0 → 9s=1 线性 ramp，独奏，前段应明显弱于后段 ---
  const auto = JSON.parse(JSON.stringify(base));
  auto.tracks.forEach((t, i) => { t.solo = i === 0; t.muted = false; });
  auto.tracks[0].automation = [
    { id: 'p1', time: 0, value: 0 },
    { id: 'p2', time: 9, value: 1 },
  ];
  results.B = await renderStats(auto, [[0.2, 1], [3.5, 4.5], [8, 8.8]]);

  // --- C. 全部静音：输出全零，但时长仍等于工程长度 ---
  const allMute = JSON.parse(JSON.stringify(base));
  allMute.tracks.forEach((t) => { t.muted = true; });
  results.C = await renderStats(allMute, [[0, 9], [9, 18]]);

  // --- D. 加一条空轨道：混音全局峰值应与基础工程一致 ---
  const withEmpty = JSON.parse(JSON.stringify(base));
  withEmpty.tracks.push({
    id: 'empty', name: '空轨道', volume: 1, muted: false, solo: false,
    clips: [], automation: [],
  });
  results.D_base = await renderStats(base, [[0, 18]]);
  results.D_empty = await renderStats(withEmpty, [[0, 18]]);

  return results;
})()`;

const r = await evalJs(harness);
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// A：独奏鼓轨，静音片段区无声，正常区有声
check('A1 独奏鼓轨正常片段有声 (0.5-1.5s peak>0.3)', r.A.windows[0].peak > 0.3, `peak=${r.A.windows[0].peak.toFixed(3)}`);
check('A2 静音鼓片段区域无声 (14.5-15.5s peak<0.01)', r.A.windows[1].peak < 0.01, `peak=${r.A.windows[1].peak.toFixed(4)}`);
check('A3 静音鼓片段区域无声 (16-17s peak<0.01)', r.A.windows[2].peak < 0.01, `peak=${r.A.windows[2].peak.toFixed(4)}`);

// B：自动化 ramp，电平随时间上升
const [earlyW, midW, lateW] = r.B.windows;
check('B1 自动化起点附近电平很低 (rms<0.05)', earlyW.rms < 0.05, `rms=${earlyW.rms.toFixed(4)}`);
check('B2 自动化中段电平介于首尾之间', midW.rms > earlyW.rms && midW.rms < lateW.rms,
  `${earlyW.rms.toFixed(3)} < ${midW.rms.toFixed(3)} < ${lateW.rms.toFixed(3)}`);
check('B3 自动化终点附近电平较起点显著升高 (>5×)', lateW.rms > earlyW.rms * 5,
  `early=${earlyW.rms.toFixed(4)} late=${lateW.rms.toFixed(4)}`);

// C：全静音 → 全零，时长保留
check('C1 全部静音时输出全零 (globalPeak=0)', r.C.globalPeak === 0, `peak=${r.C.globalPeak}`);
check('C2 静音工程仍保留完整时长', Math.abs(r.C.lengthSec - 18) < 0.02, `len=${r.C.lengthSec}s`);

// D：空轨道不改变混音
check('D1 空轨道不改变混音全局峰值', Math.abs(r.D_base.globalPeak - r.D_empty.globalPeak) < 1e-6,
  `${r.D_base.globalPeak.toFixed(4)} vs ${r.D_empty.globalPeak.toFixed(4)}`);
check('D2 空轨道不改变工程时长', Math.abs(r.D_base.lengthSec - r.D_empty.lengthSec) < 1e-6);

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} 项内容验证通过`);
ws.close();
chrome.kill();
process.exit(failed ? 1 : 0);
