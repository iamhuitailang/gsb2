// 锁定路径导出:从帧 0 完整重放(含 TAA 历史积累过程),
// 保证导出帧与交互播放到同一帧号时结果一致。
// 输出:
//   - 联系表 PNG:每个选中帧一行,含 单帧/TAA/重影热力/权重 四列与标注
//   - 指标 JSON:逐帧全图指标、探针读数、重开事件、全部复现参数

import { FIXED_DT, MAX_FRAME } from './clock.js';
import { RESET_REASON } from './renderer.js';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 线性 HDR -> 8bit sRGB
function toByte(v) {
  const g = Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2);
  return Math.round(g * 255);
}

function heatColor(v) {
  v = Math.min(1, Math.max(0, v));
  return [
    Math.round(255 * smooth(v, 0.3, 0.9)),
    Math.round(255 * (smooth(v, 0.1, 0.6) * (1 - smooth(v, 0.75, 1)) + 0.25 * v)),
    Math.round(255 * (1 - smooth(v, 0, 0.35)) * 0.8),
  ];
}
function smooth(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Exporter {
  constructor({ renderer, scene, probes, clock, getConfig, yieldEvery = 8 }) {
    this.r = renderer;
    this.scene = scene;
    this.probes = probes;
    this.clock = clock;
    this.getConfig = getConfig;
    // 每 yieldEvery 帧让出一次事件循环;0 = 不让出(自动化/无头环境使用)
    this.yieldEvery = yieldEvery;
  }

  _maybeYield(f) {
    if (this.yieldEvery && f % this.yieldEvery === 0) {
      return new Promise((res) => setTimeout(res, 0));
    }
    return Promise.resolve();
  }

  // frames: 帧号数组;onProgress(f,total)
  async run(frames, onProgress) {
    const r = this.r;
    const selected = [...new Set(frames)].sort((a, b) => a - b);
    const maxFrame = selected[selected.length - 1];
    if (maxFrame > MAX_FRAME) throw new Error(`帧号超出镜头长度 ${MAX_FRAME}`);

    // 记录交互态,导出结束恢复
    const wasPlaying = this.clock.playing;
    this.clock.pause();

    const perFrame = [];
    const probeSamples = [];
    const grab = new Map();

    // 从 0 重放,逐帧驱动同一条管线(含 reset 规则与 jitter 序列)
    r.reset(RESET_REASON.SEED);
    let prev = null;
    for (let f = 0; f <= maxFrame; f++) {
      const state = this.scene.evaluate(f);
      const info = r.renderFrame(state, prev, { wrapped: false });
      this.probes.sample(f);
      perFrame.push({ frame: f, t: +(f * FIXED_DT).toFixed(4), ...r.lastStats });
      if (selected.includes(f)) {
        grab.set(f, {
          raw: r.readDisplay(0, 0, 0.5),
          taa: r.readDisplay(1, 0, 0.5),
          ghost: r.readDisplay(4, 4, 0.5),
          weight: r.readDisplay(4, 0, 0.5),
          jitter: info.jitter,
        });
        probeSamples.push({
          frame: f,
          ghost: this.probes.ghost.map((p) => this.probes.get(p.id).at(-1)),
          jitter: this.probes.jitter.map((p) => this.probes.get(p.id).at(-1)),
        });
      }
      prev = state;
      if (onProgress && f % 5 === 0) onProgress(f, maxFrame);
      await this._maybeYield(f);
    }

    const sheet = this._buildContactSheet(selected, grab);
    const json = {
      schema: 'taa-ghost-inspection-v1',
      exportedAt: new Date().toISOString(),
      seed: this.scene.params.seed,
      resolution: { w: r.w, h: r.h },
      fixedDt: FIXED_DT,
      maxFrame: MAX_FRAME,
      config: this.getConfig(),
      sceneParams: this.scene.params,
      selectedFrames: selected,
      resetEvents: r.events,
      perFrame,
      probeSamples,
      probes: {
        ghost: this.probes.ghost,
        jitter: this.probes.jitter,
        tracks: this.probes.tracks,
      },
    };

    if (onProgress) onProgress(maxFrame, maxFrame);
    if (wasPlaying) this.clock.play();
    return { sheetBlob: await sheet, jsonBlob: new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), json };
  }

  _buildContactSheet(selected, grab) {
    const r = this.r;
    const cellW = r.w, cellH = r.h;
    const labelH = 26;
    const cols = 4;
    const cv = document.createElement('canvas');
    cv.width = cellW * cols;
    cv.height = (cellH + labelH) * selected.length + labelH;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#101012';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const headers = ['单帧(当前帧)', 'TAA(历史累积)', '重影热力 |TAA-单帧|', '历史权重调试'];

    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#c3c2b7';
    headers.forEach((h, i) => ctx.fillText(h, i * cellW + 10, 18));

    const drawCell = (data, col, row, heat = false, weight = false) => {
      const img = ctx.createImageData(cellW, cellH);
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          // GPU 行序自下而上
          const si = ((cellH - 1 - y) * cellW + x) * 4;
          const di = (y * cellW + x) * 4;
          if (heat) {
            const c = heatColor(data[si + 3] * 2.5);
            img.data[di] = c[0]; img.data[di + 1] = c[1]; img.data[di + 2] = c[2];
          } else if (weight) {
            const g = toByte(data[si]);
            img.data[di] = g; img.data[di + 1] = g; img.data[di + 2] = g;
          } else {
            img.data[di] = toByte(data[si]);
            img.data[di + 1] = toByte(data[si + 1]);
            img.data[di + 2] = toByte(data[si + 2]);
          }
          img.data[di + 3] = 255;
        }
      }
      ctx.putImageData(img, col * cellW, row * (cellH + labelH) + labelH);
    };

    selected.forEach((f, row) => {
      const g = grab.get(f);
      const y0 = row * (cellH + labelH) + labelH;
      drawCell(g.raw, 0, row);
      drawCell(g.taa, 1, row);
      drawCell(g.ghost, 2, row, true);
      drawCell(g.weight, 3, row, false, true);
      ctx.fillStyle = '#e66767';
      ctx.fillRect(0, y0 - labelH + 6, 4, 14);
      ctx.fillStyle = '#f0efec';
      const resetHere = r_eventsAt(this.r, f);
      ctx.fillText(
        `帧 ${f}  t=${(f * FIXED_DT).toFixed(3)}s  jitter=(${g.jitter.x.toFixed(3)}, ${g.jitter.y.toFixed(3)})${resetHere ? `  ⟲ ${resetHere}` : ''}`,
        10, y0 - 8,
      );
    });

    return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
  }

  save({ sheetBlob, jsonBlob }, tag) {
    const stamp = `${this.scene.params.seed}-${tag || Date.now()}`;
    download(sheetBlob, `taa-contact-${stamp}.png`);
    download(jsonBlob, `taa-metrics-${stamp}.json`);
  }
}

function r_eventsAt(r, frame) {
  const ev = r.events.filter((e) => e.frame === frame);
  return ev.map((e) => e.reason).join(', ');
}
