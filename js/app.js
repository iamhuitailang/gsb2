// 主编排:时钟驱动 -> 场景求值 -> 渲染器 -> 探针/指标 -> 图表/覆盖层/面板。
import { FrameClock, FIXED_DT, MAX_FRAME } from './clock.js';
import { createScene } from './scene.js';
import { Renderer, RESET_REASON } from './renderer.js';
import { ProbeBank, defaultProbes } from './probes.js';
import { Overlay } from './overlay.js';
import { Sparkline } from './charts.js';
import { Exporter } from './exporter.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.clock = new FrameClock();
    this.glCanvas = $('gl-canvas');
    this.overlayCanvas = $('overlay-canvas');
    this.renderer = new Renderer(this.glCanvas);
    this.scene = createScene('fence-0001');
    this.renderer.setSceneDefs(this.scene.defs);
    this.probes = new ProbeBank(this.renderer);
    this.overlay = new Overlay(this.overlayCanvas, this.glCanvas);
    this.mode = 1;
    this.debugChannel = 0;
    this.manualJump = { frame: -1, offset: 0 };
    this.prevState = null;
    this.statsHist = new Map();
    this.pendingProbe = null;

    this._initProbes();
    this._initCharts();
    this._initUI();
    this._bindClock();
    this._bindProbeClicks();
    this._initSize(); // 必须在布局完成后再按真实尺寸分配 FBO

    // 首帧:显式重开 + 渲染
    this.renderer.reset(RESET_REASON.FIRST_FRAME);
    this.tick('init');
  }

  _initSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.glCanvas.clientWidth || 640;
    const ch = this.glCanvas.clientHeight || 400;
    const w = Math.max(64, Math.round(cw * dpr));
    const h = Math.max(64, Math.round(ch * dpr));
    this.glCanvas.width = w;
    this.glCanvas.height = h;
    this.overlay.syncSize();
    this.renderer.allocate(w, h);
    // 画布尺寸变化:FBO 整体重建 + 重开,同步覆盖层
    this.renderer.attachResize(this.glCanvas, () => {
      this.overlay.syncSize();
      this.probes.clearTrails();
      this.statsHist.clear();
      this.prevState = null;
      this.tick('resize');
    });
  }

  _initProbes() {
    defaultProbes(this.probes);
  }

  _initCharts() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of document.querySelectorAll('.spark')) {
      // 模块脚本在 body 末尾执行,布局已就绪;用 CSS 盒尺寸做后备
      const cw = cv.clientWidth || 320;
      const ch = cv.clientHeight || 150;
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    const get = (f) => this.statsHist.get(f);
    this.chartGhost = new Sparkline($('chart-ghost'), {
      title: '屏幕拖影:重影亮度(移动边缘)',
      series: [
        { key: 'ghost', label: '全图重影', color: '#d95926' },
        { key: 'edgeGhost', label: '移动边缘重影', color: '#e66767' },
      ],
      getPoint: get,
    });
    this.chartStatic = new Sparkline($('chart-static'), {
      title: '静止细线:历史对边缘的改动量',
      series: [
        { key: 'staticEdgeDelta', label: '静止边缘变化', color: '#3987e5' },
        { key: 'staticFlatDelta', label: '平坦区变化', color: '#199e70' },
      ],
      getPoint: get,
    });
    this.chartWeight = new Sparkline($('chart-weight'), {
      title: '历史权重均值与移动边缘规模',
      series: [
        { key: 'meanWeight', label: '平均权重', color: '#3987e5' },
        { key: 'movingEdgePx', label: '移动边缘像素(缩放)', color: '#d95926' },
      ],
      getPoint: (f) => {
        const p = get(f);
        return p ? { ...p, movingEdgePx: p.movingEdgePx / (this.renderer.w * this.renderer.h) } : null;
      },
    });
    for (const c of [this.chartGhost, this.chartStatic, this.chartWeight]) {
      c.setEvents(this.renderer.events);
    }
    window.addEventListener('resize', () => {
      for (const cv of document.querySelectorAll('.spark')) {
        const cw = cv.clientWidth || 320;
        const ch = cv.clientHeight || 150;
        cv.width = Math.round(cw * dpr);
        cv.height = Math.round(ch * dpr);
      }
      this._redrawCharts();
    });
  }

  _initUI() {
    const r = this.renderer;
    $('btn-play').addEventListener('click', () => this.clock.toggle());
    $('btn-step').addEventListener('click', () => this.clock.advance('manual'));
    $('btn-step-back').addEventListener('click', () => this.clock.stepBack());
    $('btn-reset').addEventListener('click', () => {
      this.clock.reset();
      this.manualJump = { frame: -1, offset: 0 };
      this._hardReset(RESET_REASON.MANUAL);
    });
    $('seek-frame').addEventListener('change', (e) => {
      this.clock.seek(parseInt(e.target.value || '0', 10));
    });
    $('btn-jump-cam').addEventListener('click', () => {
      // 在下一帧生效;seek 重放时该断点保留,导出锁定路径不受影响
      this.manualJump = { frame: this.clock.frame + 1, offset: 0.7 };
      this.clock.advance('manual');
    });
    $('btn-seed').addEventListener('click', () => this._rebuildScene());
    $('btn-clear-probes').addEventListener('click', () => {
      this.probes.clear();
      this._renderProbeList();
    });
    $('btn-export').addEventListener('click', () => this._export());

    // 模式切换
    $('mode-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      this.mode = parseInt(btn.dataset.mode, 10);
      document.querySelectorAll('#mode-seg button').forEach((b) => b.classList.toggle('active', b === btn));
      $('debug-channel').classList.toggle('hidden', this.mode !== 4);
    });
    $('debug-channel').addEventListener('change', (e) => {
      this.debugChannel = parseInt(e.target.value, 10);
    });

    // 参数滑块
    const bind = (sliderId, valId, key, fmt) => {
      const s = $(sliderId);
      const apply = () => {
        r.config[key] = parseFloat(s.value);
        $(valId).textContent = fmt(r.config[key]);
      };
      s.addEventListener('input', apply);
      apply();
    };
    $('s-mix').value = r.config.historyMix;
    $('s-speed').value = r.config.speedReject;
    $('s-floor').value = r.config.weightFloor;
    $('s-eps').value = r.config.depthEps;
    bind('s-mix', 'v-mix', 'historyMix', (v) => v.toFixed(2));
    bind('s-speed', 'v-speed', 'speedReject', (v) => v.toFixed(1));
    bind('s-floor', 'v-floor', 'weightFloor', (v) => v.toFixed(2));
    bind('s-eps', 'v-eps', 'depthEps', (v) => v.toFixed(4));
    $('c-jitter').addEventListener('change', (e) => {
      r.config.jitterEnabled = e.target.checked;
    });

    // 键盘:空格播放、方向键单步、G/J/T 选探针类型
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.clock.toggle(); }
      else if (e.code === 'ArrowRight') this.clock.advance('manual');
      else if (e.code === 'ArrowLeft') this.clock.stepBack();
      else if (['KeyG', 'KeyJ', 'KeyT'].includes(e.code)) {
        this.pendingProbe = { KeyG: 'ghost', KeyJ: 'jitter', KeyT: 'track' }[e.code];
      }
    });

    r.onEvent((ev) => this._appendEvent(ev));
  }

  _bindClock() {
    this.clock.onChange((frame, reason) => this.tick(reason));
  }

  _bindProbeClicks() {
    this.glCanvas.addEventListener('click', (e) => {
      if (!this.pendingProbe) return;
      const rect = this.glCanvas.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      const v = 1 - (e.clientY - rect.top) / rect.height;
      const kind = this.pendingProbe;
      if (kind === 'ghost') this.probes.addGhost(u, v);
      else if (kind === 'jitter') this.probes.addJitter(u, v);
      else this.probes.addTrack(u, v);
      this.pendingProbe = null;
      this._renderProbeList();
      this.overlay.draw();
    });
  }

  _hardReset(reason) {
    this.renderer.reset(reason);
    this.probes.clearTrails();
    this.statsHist.clear();
    this.prevState = null;
    this.tick(reason);
  }

  _rebuildScene() {
    const seed = $('seed-input').value.trim() || 'fence-0001';
    this.scene = createScene(seed);
    this.renderer.setSceneDefs(this.scene.defs);
    this.manualJump = { frame: -1, offset: 0 };
    this.clock.reset();
    this._hardReset(RESET_REASON.SEED);
  }

  // 每一帧的唯一入口
  tick(reason) {
    const frame = this.clock.frame;

    // seek/回退:时间轴非线性移动,历史不可信 —— 从 0 重放到目标帧
    if (reason === 'seek-replay' || (reason === 'seek' && frame !== this.renderer.frame + 1)) {
      this._replayTo(frame);
      return;
    }

    const state = this.scene.evaluate(frame, this.manualJump);
    const wrapped = reason === 'play' && frame === 0 && this.renderer.frame === MAX_FRAME;
    const info = this.renderer.renderFrame(state, this.prevState, { wrapped });

    this.probes.sample(frame);
    this.statsHist.set(frame, { ...this.renderer.lastStats });

    this.renderer.display(this.mode, this.debugChannel, 0.5);
    this._updateOverlay(frame, info);
    this._updateMetrics();
    this._renderProbeList();
    this._redrawCharts();
    $('seek-frame').value = frame;
    $('btn-play').textContent = this.clock.playing ? '⏸ 暂停' : '▶ 播放';

    this.prevState = state;
  }

  _replayTo(target) {
    this.renderer.reset(RESET_REASON.SEEK);
    this.probes.clearTrails();
    this.statsHist.clear();
    let prev = null;
    for (let f = 0; f <= target; f++) {
      const state = this.scene.evaluate(f, this.manualJump);
      const info = this.renderer.renderFrame(state, prev, { wrapped: false });
      this.probes.sample(f);
      this.statsHist.set(f, { ...this.renderer.lastStats });
      prev = state;
      if (f === target) {
        this.renderer.display(this.mode, this.debugChannel, 0.5);
        this._updateOverlay(f, info);
      }
    }
    this.prevState = prev;
    this._updateMetrics();
    this._renderProbeList();
    this._redrawCharts();
    $('seek-frame').value = target;
  }

  _updateOverlay(frame, info) {
    this.overlay.probes = this.probes;
    this.overlay.mode = this.mode;
    this.overlay.frameInfo = {
      frame,
      maxFrame: MAX_FRAME,
      t: frame * FIXED_DT,
      jitterIndex: info.jitterIndex - 1,
      jx: info.jitter.x,
      jy: info.jitter.y,
      reset: this.renderer.lastReset && this.renderer.lastReset.frame === frame
        ? this.renderer.lastReset.reason : null,
    };
    this.overlay.draw();
  }

  _updateMetrics() {
    const s = this.renderer.lastStats;
    if (!s) return;
    const rows = [
      ['全图平均重影亮度', s.ghost.toFixed(5)],
      ['移动边缘平均重影', s.edgeGhost.toFixed(5)],
      ['移动边缘像素数', s.movingEdgePx.toFixed(0)],
      ['历史权重均值', s.meanWeight.toFixed(4)],
      ['静止边缘变化量', s.staticEdgeDelta.toFixed(5)],
      ['静止平坦区变化量', s.staticFlatDelta.toFixed(5)],
      ['静止边缘像素数', s.staticEdgePx.toFixed(0)],
    ];
    $('metrics-table').querySelector('tbody').innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  }

  _renderProbeList() {
    const host = $('probe-list');
    const item = (p, kind, glyph) => {
      const rec = this.probes.get(p.id);
      const last = rec.at(-1);
      const vals = kind === 'ghost'
        ? [`重影 ${last ? last.ghost.toFixed(4) : '-'}`, `w ${last ? last.weight.toFixed(2) : '-'}`,
          `速度 ${last ? last.speedN.toFixed(2) : '-'}`, last && last.disoccluded ? '⟲显露' : '']
        : [`单帧 ${last ? last.curLum.toFixed(3) : '-'}`, `TAA ${last ? last.taaLum.toFixed(3) : '-'}`,
          `Δ ${last ? Math.abs(last.taaLum - last.curLum).toFixed(4) : '-'}`];
      return `<div class="probe-item ${kind}">
        <div class="row"><span class="name">${glyph} ${p.label}</span>
        <button data-del="${p.id}" title="删除">✕</button></div>
        <div class="row"><span class="val">${vals.filter(Boolean).join(' · ')}</span></div>
      </div>`;
    };
    host.innerHTML = [
      ...this.probes.ghost.map((p) => item(p, 'ghost', 'G')),
      ...this.probes.jitter.map((p) => item(p, 'jitter', 'J')),
      ...this.probes.tracks.map((p) => `<div class="probe-item"><span class="name">T ${p.label}</span></div>`),
    ].join('');
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      this.probes.remove(b.dataset.del);
      this._renderProbeList();
      this.overlay.draw();
    }));
  }

  _appendEvent(ev) {
    const log = $('event-log');
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `<span>f${ev.frame}</span><span>t${ev.t.toFixed(3)}s</span><span class="reason">${ev.reason}</span>`;
    log.prepend(row);
    for (const c of [this.chartGhost, this.chartStatic, this.chartWeight]) c.setEvents(this.renderer.events);
  }

  _redrawCharts() {
    const f = this.clock.frame;
    this.chartGhost.draw(f);
    this.chartStatic.draw(f);
    this.chartWeight.draw(f);
  }

  async _export() {
    const frames = $('export-frames').value.split(',').map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (!frames.length) return;
    const btn = $('btn-export');
    btn.disabled = true;
    const exp = new Exporter({
      renderer: this.renderer,
      scene: this.scene,
      probes: this.probes,
      clock: this.clock,
      getConfig: () => ({ ...this.renderer.config }),
    });
    try {
      const result = await exp.run(frames, (f, total) => {
        $('export-progress').textContent = `重放中 ${f}/${total}…`;
      });
      exp.save(result, `f${frames[0]}-${frames.at(-1)}`);
      $('export-progress').textContent = '已导出联系表 PNG 与指标 JSON';
      // 导出期间改动了渲染器内部历史,恢复交互态:重放到当前帧
      this._replayTo(this.clock.frame);
    } catch (err) {
      $('export-progress').textContent = `导出失败: ${err.message}`;
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }
}

// 渲染器报错直接上屏,避免静默白屏
window.addEventListener('error', (e) => {
  const host = document.getElementById('canvas-wrap');
  if (host && !host.querySelector('.fatal')) {
    const div = document.createElement('div');
    div.className = 'fatal';
    div.style.cssText = 'position:absolute;inset:20px;color:#e66767;font:12px monospace;white-space:pre-wrap;z-index:9;';
    div.textContent = e.message || String(e);
    host.appendChild(div);
  }
});

new App();
