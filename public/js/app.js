// 应用主控：轨道状态、对齐分析、漂移校准、UI 联动、工程保存/加载。
import * as dsp from './dsp.js';
import { getAudioContext, decodeAudioFile, mixToMono, downloadBlob } from './audio.js';
import { Player } from './player.js';
import { WaveformView } from './waveform.js';
import { exportAligned } from './export.js';

const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#39c5cf', '#e3835c', '#8ddb8c'];

export class App {
  constructor() {
    this.tracks = [];
    this.selectedIndex = 0;
    this.preMode = 'after'; // after=对齐后, before=对齐前（原始位置）
    this.loopRange = null;
    this.projectName = 'untitled-alignment';
    this.dsp = dsp;
    this._idSeq = 1;

    this.ctx = getAudioContext();
    this.player = new Player(this.ctx);
    this.player.getTracks = () => this.tracks;
    this.player.getProjectDuration = () => this.projectDuration();
    this.player.getSolo = () => this.tracks.some((t) => t.solo);
    this.player.onTick = (t) => {
      this._playhead = t;
      this.updateTransport(t);
      this.view.render(t);
    };
    this._playhead = 0;

    this.view = new WaveformView(document.getElementById('waveCanvas'), this);
    this._wire();
    this._rafLoop();
    this.setStatus('就绪：导入两条以上音轨开始对齐（所有计算均在本地完成）');
  }

  trackDefaults(name) {
    return {
      id: `trk_${this._idSeq++}`,
      name,
      buffer: null,
      peaks: null,
      mono: null, // 单声道 Float32，供分析
      offsetSec: 0,
      driftPpm: 0,
      anchors: [],
      drift: null, // 最近一次漂移分析结果
      align: null, // 最近一次整轨对齐结果
      gainDb: 0,
      muted: false,
      solo: false,
      pan: 0,
      color: COLORS[(this.tracks.length) % COLORS.length],
      fileMeta: null, // { name, size, type }
    };
  }

  projectDuration() {
    let d = 0;
    for (const t of this.tracks) {
      if (!t.buffer) continue;
      // 源素材在工程轴上覆盖的末端时间（简单估计，锚点模式取映射近似）。
      const endSrc = t.buffer.duration;
      const endProj = this.view.sourceToProject(t, endSrc);
      d = Math.max(d, endProj);
    }
    return d;
  }

  setStatus(msg, busy = false) {
    const el = document.getElementById('status');
    el.textContent = (busy ? '⏳ ' : '') + msg;
  }

  // ---------- 导入 ----------
  async importFiles(fileList, replaceTrackId = null) {
    const files = [...fileList];
    if (files.length === 0) return;
    for (const file of files) {
      try {
        this.setStatus(`解码 ${file.name} …`, true);
        await this._yield();
        const decoded = await decodeAudioFile(file);
        let track;
        if (replaceTrackId) {
          track = this.tracks.find((t) => t.id === replaceTrackId);
          if (!track) continue;
        } else {
          track = this.trackDefaults(file.name);
          this.tracks.push(track);
        }
        track.name = file.name;
        track.buffer = decoded.buffer;
        track.fileMeta = { name: file.name, size: file.size, type: file.type };
        track.peaks = this.view.buildPeaks(decoded.buffer);
        track.mono = mixToMono(decoded.buffer);
        if (!replaceTrackId) track.color = COLORS[(this.tracks.length - 1) % COLORS.length];
        // 替换音轨：offsetSec / driftPpm / anchors / gain / muted 等设置保持不变
        this.setStatus(`已加载 ${file.name}（${decoded.buffer.numberOfChannels} 声道, ${decoded.buffer.sampleRate} Hz, ${decoded.buffer.duration.toFixed(2)} s）`);
      } catch (err) {
        this.setStatus(`加载失败 ${file.name}: ${err.message}`);
      }
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.tracks.length - 1));
    this.refreshTrackPanel();
    this.onTrackChanged();
  }

  _yield() {
    return new Promise((r) => setTimeout(r, 0));
  }

  selectTrack(i) {
    this.selectedIndex = i;
    this.refreshTrackPanel();
  }

  selectedTrack() {
    return this.tracks[this.selectedIndex];
  }

  referenceTrack() {
    return this.tracks.find((t) => t.reference) || this.tracks[0];
  }

  // ---------- 分析 ----------
  async autoAlignAll() {
    const ref = this.referenceTrack();
    if (this.tracks.length < 2 || !ref || !ref.mono) {
      this.setStatus('至少需要两条已加载音轨');
      return;
    }
    this.setStatus('整轨相关性对齐分析中…', true);
    for (const t of this.tracks) {
      if (t === ref || !t.mono) continue;
      await this._yield();
      const r = dsp.estimateOffset(ref.mono, t.mono, t.buffer.sampleRate);
      // lag: target[q]=ref[p], q=p-lag；映射 source = project + lag/SR
      t.offsetSec = r.lagSamples / t.buffer.sampleRate;
      t.driftPpm = 0;
      t.align = {
        coeff: r.coeff,
        lagMs: (r.lagSamples / t.buffer.sampleRate) * 1000,
      };
      this.setStatus(`${t.name}: 偏移 ${t.align.lagMs.toFixed(2)} ms，相关系数 ${r.coeff.toFixed(3)}`);
    }
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  async analyzeDrift() {
    const ref = this.referenceTrack();
    const t = this.selectedTrack();
    if (!t || t === ref || !t.mono || !ref.mono) {
      this.setStatus('请选择一条非参考轨再做漂移分析');
      return;
    }
    this.setStatus(`分窗口漂移分析：${t.name} …`, true);
    await this._yield();
    // 先做整轨对齐得到基准 lag，作为漂移窗口跟踪的锚（全程信号更稳健，规避短窗假峰）。
    const off = dsp.estimateOffset(ref.mono, t.mono, t.buffer.sampleRate);
    const baseLagSec = off.lagSamples / t.buffer.sampleRate;
    const res = dsp.estimateDrift(ref.mono, t.mono, t.buffer.sampleRate, 4, 2, 10, baseLagSec);
    t.drift = res;
    if (res.points.length >= 2) {
      t.driftPpm = res.driftPpm;
      // 以第一窗口为基准修正整体偏移（漂移直线在 t0 处的截距）。
      const p0 = res.points[0];
      t.offsetSec = p0.lagSec - res.driftPpm * 1e-6 * p0.t;
    } else if (res.points.length < 2) {
      // 漂移窗口不足时回退到整轨偏移。
      t.offsetSec = baseLagSec;
    }
    this.setStatus(`漂移 ${res.driftPpm.toFixed(1)} ppm，${res.points.length} 个校准窗口（见校准面板局部偏差）`);
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  // 依据漂移分析的各窗口 lag 生成锚点（多点校准）。
  anchorsFromDrift() {
    const t = this.selectedTrack();
    if (!t || !t.drift || t.drift.points.length < 2) {
      this.setStatus('请先对该轨执行漂移分析');
      return;
    }
    t.anchors = t.drift.points
      .filter((p) => p.coeff > 0.5)
      .map((p) => ({
        projectSec: +p.t.toFixed(4),
        sourceSec: +(p.t + p.lagSec).toFixed(4),
      }));
    this.setStatus(`已生成 ${t.anchors.length} 个校准锚点`);
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  addAnchorHere() {
    const t = this.selectedTrack();
    if (!t) return;
    const p = this._playhead;
    const s = this.view.projectToSource(t, p);
    t.anchors.push({ projectSec: +p.toFixed(4), sourceSec: +s.toFixed(4) });
    t.anchors.sort((a, b) => a.projectSec - b.projectSec);
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  removeAnchor(i) {
    const t = this.selectedTrack();
    t.anchors.splice(i, 1);
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  clearAnchors() {
    const t = this.selectedTrack();
    if (!t) return;
    t.anchors = [];
    this.onTrackChanged();
    this.refreshTrackPanel();
  }

  onTrackChanged() {
    this.player.resync();
    this.view.render(this._playhead);
    this.updateTransport(this._playhead);
  }

  // ---------- 工程保存 / 加载 ----------
  saveProject() {
    const payload = {
      formatVersion: 1,
      projectName: this.projectName,
      savedAt: new Date().toISOString(),
      loopRange: this.loopRange,
      tracks: this.tracks.map((t, i) => ({
        id: t.id,
        fileMeta: t.fileMeta,
        offsetSec: t.offsetSec,
        driftPpm: t.driftPpm,
        anchors: t.anchors,
        gainDb: t.gainDb,
        muted: t.muted,
        solo: t.solo,
        pan: t.pan,
        reference: i === this.tracks.indexOf(this.referenceTrack()),
        color: t.color,
        align: t.align,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${this.projectName}.align.json`);
    this.setStatus('工程已保存（音频文件不内嵌，重新打开时按文件名匹配）');
  }

  async loadProject(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      this.setStatus('工程文件解析失败');
      return;
    }
    this.projectName = (file.name || 'loaded').replace(/\.align\.json$/i, '');
    this.loopRange = data.loopRange || null;
    this.tracks = data.tracks.map((td) => {
      const t = this.trackDefaults(td.fileMeta?.name || 'unknown');
      Object.assign(t, {
        offsetSec: td.offsetSec || 0,
        driftPpm: td.driftPpm || 0,
        anchors: td.anchors || [],
        gainDb: td.gainDb || 0,
        muted: !!td.muted,
        solo: !!td.solo,
        pan: td.pan || 0,
        reference: !!td.reference,
        color: td.color || t.color,
        align: td.align || null,
        fileMeta: td.fileMeta || null,
      });
      return t;
    });
    this.selectedIndex = 0;
    this.refreshTrackPanel();
    this.view.render(0);
    this.setStatus('工程已载入，请选择对应音频文件以重新关联（按文件名自动匹配）');
    document.getElementById('relinkPanel').classList.remove('hidden');
    this._renderRelink(data.tracks);
  }

  // 重新打开工程时关联音频：按文件名+大小自动匹配，未匹配的手动替换。
  async relinkFiles(fileList) {
    const files = [...fileList];
    for (const file of files) {
      const match = this.tracks.find((t) =>
        !t.buffer && t.fileMeta && t.fileMeta.name === file.name &&
        (t.fileMeta.size == null || t.fileMeta.size === file.size));
      if (match) await this.importFiles([file], match.id);
    }
    const unmatched = files.filter((f) => !this.tracks.some((t) => t.buffer && t.fileMeta?.name === f.name));
    this._pendingUnmatched = unmatched;
    this._renderRelink();
    if (this.tracks.every((t) => t.buffer)) {
      document.getElementById('relinkPanel').classList.add('hidden');
      this.setStatus('全部音轨已重新关联');
    }
  }

  _renderRelink(savedTracks) {
    const box = document.getElementById('relinkList');
    box.innerHTML = '';
    for (const t of this.tracks) {
      const row = document.createElement('div');
      row.className = 'relink-row';
      row.innerHTML = `<span class="${t.buffer ? 'ok' : 'missing'}">${t.buffer ? '✓' : '✗'}</span>
        <span>${t.fileMeta?.name || t.name}</span>`;
      if (!t.buffer) {
        const btn = document.createElement('button');
        btn.textContent = '选择文件…';
        btn.onclick = () => {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = 'audio/*';
          inp.onchange = () => this.importFiles([...inp.files], t.id);
          inp.click();
        };
        row.appendChild(btn);
      }
      box.appendChild(row);
    }
  }

  // ---------- 导出 ----------
  async doExport(opts) {
    const ready = this.tracks.filter((t) => t.buffer);
    if (ready.length === 0) {
      this.setStatus('没有可导出的音轨');
      return;
    }
    this.setStatus('离线渲染同步音轨…', true);
    await this._yield();
    ready.forEach((t, i) => { t.index = i; });
    const dur = this.projectDuration();
    const manifest = await exportAligned(ready, dur, opts, downloadBlob);
    this.setStatus(`导出完成：${ready.length} 条同步音轨 + offsets.json/csv（时长 ${dur.toFixed(2)} s）`);
    return manifest;
  }

  // ---------- UI ----------
  _wire() {
    document.getElementById('importBtn').onclick = () => this._pickAudio((f) => this.importFiles(f));
    document.getElementById('alignBtn').onclick = () => this.autoAlignAll();
    document.getElementById('driftBtn').onclick = () => this.analyzeDrift();
    document.getElementById('anchorDriftBtn').onclick = () => this.anchorsFromDrift();
    document.getElementById('anchorDriftSideBtn').onclick = () => this.anchorsFromDrift();
    document.getElementById('anchorHereBtn').onclick = () => this.addAnchorHere();
    document.getElementById('clearAnchorBtn').onclick = () => this.clearAnchors();

    document.getElementById('playBtn').onclick = () => {
      if (this.player.playing) this.player.pause();
      else this.player.play();
      this.updateTransport(this._playhead);
    };
    document.getElementById('stopBtn').onclick = () => {
      this.player.pause();
      this.player.seek(0);
      this.updateTransport(0);
    };
    document.getElementById('loopSetBtn').onclick = () => {
      const a = parseFloat(document.getElementById('loopStart').value) || 0;
      const b = parseFloat(document.getElementById('loopEnd').value) || this.projectDuration();
      if (b > a) {
        this.loopRange = [a, b];
        this.player.setLoop(this.loopRange);
        this.setStatus(`循环试听区间 ${a.toFixed(2)} – ${b.toFixed(2)} s`);
        this.view.render(this._playhead);
      }
    };
    document.getElementById('loopClearBtn').onclick = () => {
      this.loopRange = null;
      this.player.setLoop(null);
      this.view.render(this._playhead);
    };

    document.getElementById('modeAfter').onchange = (e) => {
      this.preMode = e.target.checked ? 'after' : 'before';
      this.view.render(this._playhead);
      this.refreshTrackPanel();
    };

    document.getElementById('saveBtn').onclick = () => this.saveProject();
    document.getElementById('loadBtn').onclick = () => this._pickJson((f) => this.loadProject(f[0]));
    document.getElementById('relinkBtn').onclick = () => this._pickAudio((f) => this.relinkFiles(f));

    document.getElementById('exportBtn').onclick = () => {
      const opts = {
        sampleRate: parseInt(document.getElementById('exportRate').value, 10),
        skipMuted: document.getElementById('skipMuted').checked,
        applyGain: document.getElementById('applyGain').checked,
        asZip: document.getElementById('asZip').checked,
      };
      this.doExport(opts);
    };

    document.getElementById('zoomIn').onclick = () => {
      this.view.pxPerSec = Math.min(800, this.view.pxPerSec * 1.25);
      this.view.render(this._playhead);
    };
    document.getElementById('zoomOut').onclick = () => {
      this.view.pxPerSec = Math.max(2, this.view.pxPerSec / 1.25);
      this.view.render(this._playhead);
    };
    document.getElementById('zoomFit').onclick = () => {
      const w = document.getElementById('waveCanvas').clientWidth;
      const d = Math.max(1, this.projectDuration());
      this.view.pxPerSec = Math.max(2, w / d);
      this.view.viewStart = 0;
      this.view.render(this._playhead);
    };

    // 拖拽文件到窗口
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const audios = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio') || /\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(f.name));
      if (audios.length) this.importFiles(audios);
    });
  }

  _pickAudio(cb) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*';
    inp.multiple = true;
    inp.onchange = () => cb([...inp.files]);
    inp.click();
  }

  _pickJson(cb) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.multiple = true;
    inp.onchange = () => cb([...inp.files]);
    inp.click();
  }

  _rafLoop() {
    // 播放时由 player.onTick 驱动；暂停时也保持指针显示刷新。
    requestAnimationFrame(() => {
      if (!this.player.playing) this.view.render(this._playhead);
      this._rafLoop();
    });
  }

  updateTransport(t) {
    document.getElementById('timeNow').textContent = dsp.formatTime(t);
    document.getElementById('timeTotal').textContent = dsp.formatTime(this.projectDuration());
    document.getElementById('playBtn').textContent = this.player.playing ? '⏸ 暂停' : '▶ 播放';
  }

  refreshTrackPanel() {
    const panel = document.getElementById('trackPanel');
    panel.innerHTML = '';
    const ref = this.referenceTrack();
    this.tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'track-row' + (i === this.selectedIndex ? ' selected' : '');
      row.onclick = () => this.selectTrack(i);
      const localOffset = t.anchors && t.anchors.length
        ? this._anchorOffsetAt(t, this._playhead)
        : t.offsetSec + t.driftPpm * 1e-6 * this._playhead;
      row.innerHTML = `
        <div class="tr-head">
          <span class="dot" style="background:${t.color}"></span>
          <span class="tr-name" title="${t.name}">${t.name}</span>
          ${t === ref ? '<span class="badge ref">参考</span>' : ''}
          ${t.buffer ? '' : '<span class="badge miss">未关联</span>'}
        </div>
        <div class="tr-ctrl">
          <button data-act="mute" class="${t.muted ? 'on' : ''}">${t.muted ? '🔇 已静音' : '🔈 静音'}</button>
          <button data-act="solo" class="${t.solo ? 'on' : ''}">S</button>
          ${t === ref ? '' : '<button data-act="ref">设为参考</button>'}
          ${t.buffer ? '<button data-act="replace">替换文件</button>' : '<button data-act="replace">关联文件</button>'}
        </div>
        <div class="tr-params">
          <label>增益 <input type="range" min="-24" max="12" step="0.5" value="${t.gainDb}" data-act="gain">
            <span class="val">${t.gainDb.toFixed(1)} dB</span></label>
          <label>声像 <input type="range" min="-1" max="1" step="0.05" value="${t.pan}" data-act="pan">
            <span class="val">${t.pan.toFixed(2)}</span></label>
          <label>起始偏移 <input type="number" step="0.001" value="${t.offsetSec.toFixed(3)}" data-act="offset">
            <span class="val">s</span></label>
          <label>漂移 <input type="number" step="0.1" value="${(t.driftPpm || 0).toFixed(1)}" data-act="drift">
            <span class="val">ppm</span></label>
          <span class="local">当前位置局部偏差: <b>${(localOffset * 1000).toFixed(1)} ms</b></span>
          ${t.align ? `<span class="coeff">NCC=${t.align.coeff.toFixed(3)}</span>` : ''}
        </div>`;

      row.querySelector('[data-act="mute"]').onclick = (e) => {
        e.stopPropagation();
        t.muted = !t.muted;
        this.onTrackChanged();
        this.refreshTrackPanel();
      };
      row.querySelector('[data-act="solo"]').onclick = (e) => {
        e.stopPropagation();
        t.solo = !t.solo;
        this.onTrackChanged();
        this.refreshTrackPanel();
      };
      const refBtn = row.querySelector('[data-act="ref"]');
      if (refBtn) refBtn.onclick = (e) => {
        e.stopPropagation();
        this.tracks.forEach((x) => delete x.reference);
        t.reference = true;
        this.refreshTrackPanel();
      };
      row.querySelector('[data-act="replace"]').onclick = (e) => {
        e.stopPropagation();
        this._pickAudio((f) => this.importFiles(f, t.id));
      };
      row.querySelector('[data-act="gain"]').oninput = (e) => {
        t.gainDb = parseFloat(e.target.value);
        this.onTrackChanged();
        this.refreshTrackPanel();
      };
      row.querySelector('[data-act="pan"]').oninput = (e) => {
        t.pan = parseFloat(e.target.value);
        this.onTrackChanged();
        this.refreshTrackPanel();
      };
      row.querySelector('[data-act="offset"]').oninput = (e) => {
        t.offsetSec = parseFloat(e.target.value) || 0;
        this.onTrackChanged();
      };
      row.querySelector('[data-act="drift"]').oninput = (e) => {
        t.driftPpm = parseFloat(e.target.value) || 0;
        this.onTrackChanged();
      };
      panel.appendChild(row);
    });

    this._renderAnchorTable();
    this._renderDriftPanel();
  }

  _anchorOffsetAt(t, pSec) {
    const s = dsp.sourceTimeFromAnchors(pSec, t.anchors);
    return s - pSec;
  }

  _renderAnchorTable() {
    const box = document.getElementById('anchorTable');
    const t = this.selectedTrack();
    if (!t) {
      box.innerHTML = '<p class="hint">未选择轨道</p>';
      return;
    }
    if (!t.anchors || t.anchors.length === 0) {
      box.innerHTML = `<p class="hint">${t.name}：暂无锚点。在波形上双击可添加，或先做漂移分析后一键生成。</p>`;
      return;
    }
    let html = `<table><thead><tr><th>#</th><th>工程时间 (s)</th><th>源时间 (s)</th><th>局部偏差 (ms)</th><th></th></tr></thead><tbody>`;
    t.anchors.forEach((a, i) => {
      html += `<tr>
        <td>${i + 1}</td>
        <td><input data-k="${i}" data-f="projectSec" value="${a.projectSec.toFixed(4)}" size="9"></td>
        <td><input data-k="${i}" data-f="sourceSec" value="${a.sourceSec.toFixed(4)}" size="9"></td>
        <td>${((a.sourceSec - a.projectSec) * 1000).toFixed(2)}</td>
        <td><button data-rm="${i}">删除</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    box.querySelectorAll('input').forEach((inp) => {
      inp.onchange = () => {
        const k = +inp.dataset.k;
        t.anchors[k][inp.dataset.f] = parseFloat(inp.value) || 0;
        t.anchors.sort((a, b) => a.projectSec - b.projectSec);
        this.onTrackChanged();
        this.refreshTrackPanel();
      };
    });
    box.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.onclick = () => this.removeAnchor(+btn.dataset.rm);
    });
  }

  _renderDriftPanel() {
    const box = document.getElementById('driftInfo');
    const t = this.selectedTrack();
    if (!t || !t.drift) {
      box.innerHTML = '<p class="hint">漂移分析结果会显示在这里（局部偏差 = 各窗口实测 lag 相对线性漂移模型的残差）。</p>';
      return;
    }
    const d = t.drift;
    let html = `<div>线性漂移：<b>${d.driftPpm.toFixed(2)} ppm</b>（${(d.driftPpm / 1e6 * 60).toFixed(2)} ms/分钟），校准窗口 ${d.points.length} 个</div>`;
    html += '<table><thead><tr><th>工程时间(s)</th><th>lag(ms)</th><th>NCC</th><th>局部偏差(ms)</th></tr></thead><tbody>';
    for (const p of d.points) {
      html += `<tr><td>${p.t.toFixed(2)}</td><td>${(p.lagSec * 1000).toFixed(2)}</td><td>${p.coeff.toFixed(3)}</td><td>${p.localMs.toFixed(2)}</td></tr>`;
    }
    html += '</tbody></table>';
    box.innerHTML = html;
  }
}

// 启动应用并暴露到全局，便于控制台调试与自动化测试。
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
