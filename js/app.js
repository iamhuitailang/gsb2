/*
 * app.js — 页面主控：素材加载、压缩处理流水线、播放引擎、
 * 三视图时间联动、试听切换、削波告警、A/B 预设与 WAV 导出。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 与 index.html 滑块一一对应的参数定义
  const PARAM_DEFS = [
    { id: 'threshold', key: 'thresholdDb', fmt: (v) => `${v.toFixed(1)} dB` },
    { id: 'ratio', key: 'ratio', fmt: (v) => `1 : ${v.toFixed(1)}` },
    { id: 'attack', key: 'attackMs', fmt: (v) => `${v.toFixed(1)} ms` },
    { id: 'release', key: 'releaseMs', fmt: (v) => `${v.toFixed(0)} ms` },
    { id: 'makeup', key: 'makeupDb', fmt: (v) => `${v.toFixed(1)} dB` },
  ];

  const REPROCESS_DEBOUNCE_MS = 90;

  const App = {
    // 素材
    audioCtx: null,
    inputBuffer: null,        // AudioBuffer（原声）
    inputChannelData: null,   // Float32Array[] 视图
    fileName: '',
    isSynthetic: false,
    segments: null,

    // 处理结果（压缩后、未加补偿）
    result: null,             // DSP.compress 返回值
    processedChannelData: null,
    inputPeaks: null,
    outputPeaks: null,
    clipBuckets: null,
    stats: null,              // rms/峰值/静音等
    effectiveMakeupDb: 0,

    // 播放
    source: null,
    gainNode: null,
    playing: false,
    sourceStartedAt: 0,
    sourceOffset: 0,
    naturalStop: false,
    listenMode: 'processed',  // 'original' | 'processed'
    rafId: null,

    // 参数
    params: null,
    reprocessTimer: null,
    clipTimer: null,
    cache: new Map(),         // 参数签名 → 处理结果

    // 预设
    presets: { A: null, B: null },

    views: {},

    // ---------------- 初始化 ----------------

    init() {
      this.params = this.readControls();
      this.initViews();
      this.bindControls();
      this.bindTransport();
      this.bindSeekAndHover();
      this.bindPresets();
      this.bindFileInput();
      this.updateParamLabels();
      this.updateSegmentedButtons();
      this.setStatus('就绪：点“载入内置样音”，或导入自己的音频。');
    },

    ensureCtx() {
      if (!this.audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      return this.audioCtx;
    },

    initViews() {
      this.views.input = new Views.WaveView($('inputCanvas'), {
        title: '输入波形',
        onResized: () => this.rebuildPeaks(),
      });
      this.views.output = new Views.WaveView($('outputCanvas'), {
        title: '输出波形',
        onResized: () => this.rebuildPeaks(),
      });
      this.views.gain = new Views.GainView($('gainCanvas'));
    },

    // ---------------- DOM 绑定 ----------------

    readControls() {
      const p = {};
      for (const def of PARAM_DEFS) p[def.key] = parseFloat($(def.id).value);
      p.linked = $('linked').checked;
      p.loudnessMatch = $('loudnessMatch').checked;
      return p;
    },

    updateParamLabels() {
      for (const def of PARAM_DEFS) {
        $(`${def.id}Val`).textContent = def.fmt(parseFloat($(def.id).value));
      }
    },

    bindControls() {
      for (const def of PARAM_DEFS) {
        $(def.id).addEventListener('input', () => {
          this.updateParamLabels();
          this.params = this.readControls();
          if (def.id === 'makeup') {
            // 补偿增益不改变压缩结果，只刷新输出与削波提示
            this.refreshMakeupDependent();
          } else {
            this.scheduleReprocess();
          }
        });
      }
      $('linked').addEventListener('change', () => {
        this.params = this.readControls();
        this.scheduleReprocess();
      });
      $('loudnessMatch').addEventListener('change', () => {
        this.params = this.readControls();
        $('makeup').disabled = this.params.loudnessMatch;
        this.refreshMakeupDependent();
      });

      $('listenOriginal').addEventListener('click', () => this.switchListen('original'));
      $('listenProcessed').addEventListener('click', () => this.switchListen('processed'));
      $('quickToggle').addEventListener('click', () => {
        this.switchListen(this.listenMode === 'original' ? 'processed' : 'original');
      });

      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
          e.preventDefault();
          if (!this.inputBuffer) return;
          if (this.playing) this.stopPlayback();
          else this.startPlayback();
        }
      });
    },

    bindTransport() {
      $('playBtn').addEventListener('click', () => {
        if (this.playing) this.stopPlayback();
        else this.startPlayback();
      });
      $('stopBtn').addEventListener('click', () => this.stopPlayback());
    },

    bindSeekAndHover() {
      const canvases = [
        this.views.input.canvas,
        this.views.output.canvas,
        this.views.gain.canvas,
      ];
      let dragging = false;

      const seekToEvent = (ev) => {
        const rect = ev.target.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const t = this.views.input.xToTime(x);
        this.seek(t);
      };

      for (const canvas of canvases) {
        canvas.addEventListener('pointerdown', (ev) => {
          if (!this.inputBuffer) return;
          dragging = true;
          try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* 合成事件可能无有效 pointerId */ }
          seekToEvent(ev);
        });
        canvas.addEventListener('pointermove', (ev) => {
          if (!this.inputBuffer) return;
          const rect = canvas.getBoundingClientRect();
          const x = ev.clientX - rect.left;
          for (const v of Object.values(this.views)) v.setHover(x);
          this.showTooltip(ev, canvas);
          if (dragging) seekToEvent(ev);
        });
        canvas.addEventListener('pointerup', () => { dragging = false; });
        canvas.addEventListener('pointerleave', () => {
          dragging = false;
          for (const v of Object.values(this.views)) v.setHover(null);
          $('tooltip').classList.add('hidden');
        });
      }
    },

    showTooltip(ev, canvas) {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      let tip = null;
      if (canvas === this.views.gain.canvas) tip = this.views.gain.tooltipAt(x);
      else if (canvas === this.views.input.canvas) tip = this.views.input.tooltipAt(x);
      else tip = this.views.output.tooltipAt(x);
      if (!tip) return;

      const tt = $('tooltip');
      tt.innerHTML =
        `<div class="tt-title">${tip.title}</div>` +
        tip.lines.map((l) => `<div class="tt-line">${l}</div>`).join('');
      tt.classList.remove('hidden');

      // 相对 .views 容器定位
      const host = canvas.closest('.views').getBoundingClientRect();
      let left = ev.clientX - host.left + 14;
      if (left + tt.offsetWidth > host.width) left = ev.clientX - host.left - tt.offsetWidth - 14;
      tt.style.left = `${Math.max(4, left)}px`;
      tt.style.top = `${ev.clientY - host.top + 10}px`;
    },

    bindPresets() {
      $('saveA').addEventListener('click', () => this.savePreset('A'));
      $('saveB').addEventListener('click', () => this.savePreset('B'));
      $('loadA').addEventListener('click', () => this.loadPreset('A'));
      $('loadB').addEventListener('click', () => this.loadPreset('B'));
    },

    bindFileInput() {
      $('fileInput').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (f) this.loadFile(f);
      });

      ['dragover', 'dragenter'].forEach((evt) =>
        document.body.addEventListener(evt, (e) => {
          e.preventDefault();
          document.body.classList.add('dragover');
        })
      );
      ['dragleave', 'drop'].forEach((evt) =>
        document.body.addEventListener(evt, (e) => {
          e.preventDefault();
          document.body.classList.remove('dragover');
        })
      );
      document.body.addEventListener('drop', (e) => {
        const f = e.dataTransfer.files[0];
        if (f) this.loadFile(f);
      });

      $('loadSampleBtn').addEventListener('click', () => this.loadBuiltinSample());
      $('exportBtn').addEventListener('click', () => this.exportWav());
    },

    // ---------------- 素材加载 ----------------

    loadBuiltinSample() {
      const s = SampleGen.generateSample();
      const ctx = this.ensureCtx();
      const buf = ctx.createBuffer(
        s.channelData.length, s.channelData[0].length, s.sampleRate
      );
      for (let c = 0; c < s.channelData.length; c++) {
        buf.copyToChannel(s.channelData[c], c);
      }
      this.fileName = '内置样音（短响 + 持续声 + 安静区）';
      this.isSynthetic = true;
      this.segments = s.segments;
      this.setBuffer(buf);
      this.setStatus('已载入内置样音：观察 0.8s / 1.15s 短响与 2.0–3.6s 持续声的增益差别。');
    },

    async loadFile(file) {
      try {
        const ctx = this.ensureCtx();
        const arr = await file.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        this.fileName = file.name;
        this.isSynthetic = false;
        this.segments = null;
        this.setBuffer(buf);
        this.setStatus(`已导入 ${file.name}（${buf.numberOfChannels} 声道，${buf.sampleRate} Hz，${buf.duration.toFixed(2)} s）。`);
      } catch (err) {
        this.setStatus(`导入失败：${err.message}（请尝试浏览器支持的 wav / mp3 / m4a 等格式）。`, true);
      }
    },

    setBuffer(buffer) {
      this.stopPlayback();
      this.inputBuffer = buffer;
      this.inputChannelData = Array.from(
        { length: buffer.numberOfChannels },
        (_, c) => buffer.getChannelData(c)
      );
      this.cache.clear();
      this.presets = { A: null, B: null };
      this.updatePresetUI();
      this.sourceOffset = 0;

      $('fileName').textContent = this.fileName;
      $('playBtn').disabled = false;
      $('stopBtn').disabled = false;
      $('quickToggle').disabled = false;
      $('saveA').disabled = false;
      $('saveB').disabled = false;
      $('exportBtn').disabled = false;

      // 单声道时联动选项无意义，且隐藏 R 表行
      const linkedEl = $('linked');
      if (buffer.numberOfChannels === 1) {
        linkedEl.checked = true;
        linkedEl.disabled = true;
        $('meterRowR').classList.add('hidden');
        // 单声道把 L 标签改为中性
        $('meterRowL').querySelector('.meter-name').innerHTML =
          '<span class="dot dot-l"></span>单声道';
      } else {
        linkedEl.disabled = false;
        $('meterRowR').classList.remove('hidden');
        $('meterRowL').querySelector('.meter-name').innerHTML =
          '<span class="dot dot-l"></span>L';
      }
      this.params = this.readControls();

      for (const v of Object.values(this.views)) {
        v.setDuration(buffer.duration);
        v.setSegments(this.segments);
      }
      this.reprocess();
    },

    // ---------------- 处理流水线 ----------------

    compressSignature() {
      const p = this.params;
      return [p.thresholdDb, p.ratio, p.attackMs, p.releaseMs, p.linked]
        .join('|');
    },

    scheduleReprocess() {
      clearTimeout(this.reprocessTimer);
      this.setStatus('正在重新计算压缩…');
      this.reprocessTimer = setTimeout(() => this.reprocess(), REPROCESS_DEBOUNCE_MS);
    },

    reprocess() {
      if (!this.inputBuffer) return;
      clearTimeout(this.reprocessTimer);
      const p = this.params;
      const sig = this.compressSignature();

      if (this.cache.has(sig)) {
        this.result = this.cache.get(sig);
      } else {
        this.result = DSP.compress(
          this.inputChannelData,
          this.inputBuffer.sampleRate,
          {
            thresholdDb: p.thresholdDb,
            ratio: p.ratio,
            attackMs: p.attackMs,
            releaseMs: p.releaseMs,
            linked: p.linked,
          },
          2000
        );
        // 缓存上限，避免长素材多次调参后占内存
        if (this.cache.size >= 12) this.cache.clear();
        this.cache.set(sig, this.result);
      }
      this.processedChannelData = this.result.out;
      this.computeStats();
      this.rebuildPeaks();
      this.refreshGainView();
      this.refreshMakeupDependent();
      this.refreshMeters();
      this.setStatus(
        `处理完成：最大衰减 ${this.stats.maxGr.toFixed(1)} dB，` +
        `起效 ${p.attackMs.toFixed(1)} ms / 恢复 ${p.releaseMs.toFixed(0)} ms。`
      );
    },

    computeStats() {
      const inRms = DSP.rmsDb(this.inputChannelData);
      const outRmsPre = DSP.rmsDb(this.processedChannelData);
      const inPeak = DSP.peakAbs(this.inputChannelData);
      const outPeakPre = DSP.peakAbs(this.processedChannelData);
      const silIn = DSP.silenceEdges(this.inputChannelData, this.inputBuffer.sampleRate);
      const silOut = DSP.silenceEdges(this.processedChannelData, this.inputBuffer.sampleRate);
      // 同响度对照所需补偿：让输出 RMS 对齐原声 RMS（相对压缩后电平）
      const loudnessMatchDb = inRms - outRmsPre;

      this.stats = {
        inRms,
        outRmsPre,
        inPeakDb: DSP.gainToDb(inPeak),
        outPeakPreDb: DSP.gainToDb(outPeakPre),
        outPeakPre: outPeakPre,
        silIn,
        silOut,
        maxGr: this.result.maxGrDb,
        loudnessMatchDb,
      };
    },

    currentMakeupDb() {
      if (this.params.loudnessMatch) return this.stats.loudnessMatchDb;
      return this.params.makeupDb;
    },

    refreshMakeupDependent() {
      if (!this.result) return;
      this.effectiveMakeupDb = this.currentMakeupDb();

      // 同响度对照提示
      const matchEl = $('matchInfo');
      if (this.params.loudnessMatch) {
        matchEl.textContent =
          `已自动补偿 ${this.effectiveMakeupDb >= 0 ? '+' : ''}${this.effectiveMakeupDb.toFixed(1)} dB（补偿滑块已停用）`;
        $('makeupVal').textContent = `${this.effectiveMakeupDb.toFixed(1)} dB`;
      } else {
        matchEl.textContent = '';
      }

      this.rebuildOutputPeaks();
      this.updateClipWarning();
      this.updateStatsUI();
    },

    rebuildPeaks() {
      if (!this.inputBuffer) return;
      const w = this.views.input.w;
      this.inputPeaks = Peaks.buildPeaks(this.inputChannelData, w);
      this.views.input.setData(this.inputPeaks, this.inputBuffer.numberOfChannels);
      this.rebuildOutputPeaks();
    },

    rebuildOutputPeaks() {
      if (!this.result) return;
      const w = this.views.output.w;
      const makeup = this.effectiveMakeupDb;
      const g = DSP.dbToGain(makeup);
      // 输出峰值桶按“补偿后”的电平绘制
      const scaled = this.processedChannelData.map((d) => {
        const copy = new Float32Array(d.length);
        for (let i = 0; i < d.length; i++) copy[i] = d[i] * g;
        return copy;
      });
      this.outputPeaks = Peaks.buildPeaks(scaled, w);
      this.views.output.setData(this.outputPeaks, this.inputBuffer.numberOfChannels);
      this.rebuildClipBuckets(scaled, w);
    },

    rebuildClipBuckets(scaledData, widthPx) {
      const n = scaledData[0].length;
      const buckets = Math.max(50, Math.min(widthPx | 0, n));
      const bucketSize = n / buckets;
      this.clipBuckets = scaledData.map((data) => {
        const flags = new Uint8Array(buckets);
        for (let b = 0; b < buckets; b++) {
          const start = Math.floor(b * bucketSize);
          const end = Math.min(n, Math.floor((b + 1) * bucketSize) || start + 1);
          for (let i = start; i < end; i++) {
            if (Math.abs(data[i]) >= 1) { flags[b] = 1; break; }
          }
        }
        return flags;
      });
      this.views.output.setClipBuckets(this.clipBuckets);
      $('clipLegend').classList.toggle('hidden',
        !this.clipBuckets.some((arr) => arr.some(Boolean)));
    },

    refreshGainView() {
      this.views.gain.setData(
        this.result.gainCurve,
        this.inputBuffer.numberOfChannels,
        this.result.maxGrDb,
        this.params.linked
      );
    },

    updateClipWarning() {
      clearTimeout(this.clipTimer);
      this.clipTimer = setTimeout(() => {
        const cs = DSP.clipStats(
          this.processedChannelData,
          this.inputBuffer.sampleRate,
          this.effectiveMakeupDb
        );
        const el = $('clipWarning');
        el.classList.remove('hidden', 'serious', 'near', 'ok');
        if (cs.clips > 0) {
          el.classList.add('serious');
          const sign = this.effectiveMakeupDb >= 0 ? '+' : '';
          el.innerHTML =
            `⚠ <strong>会削波</strong>：当前补偿 ${sign}${this.effectiveMakeupDb.toFixed(1)} dB 下，` +
            `共 <strong>${cs.clips}</strong> 个样本超出 0 dBFS，首次出现在 ${Views.formatTime(cs.firstSec)}。` +
            `导出 WAV 时这些位置会被硬限幅，请降低补偿增益${this.params.loudnessMatch ? '或关闭同响度对照' : ''}。`;
        } else if (cs.nearClips > 0) {
          el.classList.add('near');
          el.textContent =
            `接近削波：${cs.nearClips} 个样本高于 -1 dBFS（未超过 0 dBFS，不会硬削波），建议留一点余量。`;
        } else {
          el.classList.add('ok');
          el.textContent = `✓ 当前补偿 ${this.effectiveMakeupDb.toFixed(1)} dB 下不会削波。`;
        }
      }, 60);
    },

    updateStatsUI() {
      if (!this.stats) return;
      const s = this.stats;
      $('statIn').textContent =
        `${s.inRms.toFixed(1)} dB / ${s.inPeakDb.toFixed(1)} dBFS`;
      const outRms = s.outRmsPre + this.effectiveMakeupDb;
      const outPeak = s.outPeakPreDb + this.effectiveMakeupDb;
      $('statOut').textContent =
        `${outRms.toFixed(1)} dB / ${outPeak.toFixed(1)} dBFS`;
      $('statGr').textContent = `${s.maxGr.toFixed(1)} dB`;
      $('statSilence').textContent =
        `${s.silIn.headSec.toFixed(2)}+${s.silIn.tailSec.toFixed(2)}` +
        ` → ${s.silOut.headSec.toFixed(2)}+${s.silOut.tailSec.toFixed(2)}`;
    },

    // ---------------- 实时表（播放头位置的增益/电平） ----------------

    refreshMeters() {
      if (!this.result) return;
      const t = this.currentPlaybackTime();
      this.renderMeters(t);
    },

    renderMeters(t) {
      if (!this.result) return;
      const sr = this.inputBuffer.sampleRate;
      const idx = Math.max(0, Math.min(this.inputBuffer.length - 1, Math.floor(t * sr)));
      const numCh = this.inputBuffer.numberOfChannels;
      const ids = ['grL', 'grR'];
      const lvlIds = ['lvlL', 'lvlR'];
      for (let c = 0; c < numCh; c++) {
        const grDb = this.result.gainDb[c][idx];
        $(ids[c]).textContent = `${grDb.toFixed(1)} dB`;
        const inLvl = DSP.gainToDb(Math.abs(this.inputChannelData[c][idx]));
        $(lvlIds[c]).textContent = `峰值 ${isFinite(inLvl) ? inLvl.toFixed(1) : '-∞'}`;
      }
    },

    // ---------------- 播放引擎 ----------------

    currentPlaybackTime() {
      if (!this.inputBuffer) return 0;
      if (this.playing) {
        const t = this.sourceOffset + (this.audioCtx.currentTime - this.sourceStartedAt);
        return Math.min(t, this.inputBuffer.duration);
      }
      return this.sourceOffset;
    },

    startPlayback() {
      if (!this.inputBuffer || this.playing) return;
      const ctx = this.ensureCtx();
      const offset = Math.min(this.sourceOffset, this.inputBuffer.duration);

      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.listenMode === 'original'
        ? 1
        : DSP.dbToGain(this.effectiveMakeupDb);
      this.gainNode.connect(ctx.destination);

      this.source = ctx.createBufferSource();
      this.source.buffer = this.listenMode === 'original'
        ? this.inputBuffer
        : this.bufferFromProcessed();
      this.naturalStop = false;
      this.source.connect(this.gainNode);
      this.source.onended = () => {
        if (this.naturalStop) {
          this.playing = false;
          this.sourceOffset = 0;
          this.afterPlaybackStopped();
        }
      };
      this.source.start(0, offset);
      this.sourceStartedAt = ctx.currentTime;
      this.sourceOffset = offset;
      this.playing = true;
      this.afterPlaybackStarted();

      const tick = () => {
        if (!this.playing) return;
        const t = this.currentPlaybackTime();
        this.updatePlayhead(t);
        this.renderMeters(t);
        if (t >= this.inputBuffer.duration - 1e-4) {
          // onended 会处理收尾，这里仅停表
          return;
        }
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    },

    // 把压缩后的 Float32Array[] 包成 AudioBuffer（不含补偿，补偿走 GainNode）
    bufferFromProcessed() {
      const buf = this.audioCtx.createBuffer(
        this.processedChannelData.length,
        this.processedChannelData[0].length,
        this.inputBuffer.sampleRate
      );
      for (let c = 0; c < this.processedChannelData.length; c++) {
        buf.copyToChannel(this.processedChannelData[c], c);
      }
      return buf;
    },

    stopPlayback() {
      if (!this.playing) return;
      this.sourceOffset = this.currentPlaybackTime();
      this.naturalStop = false;
      try { this.source.stop(); } catch (_) { /* 已结束 */ }
      this.playing = false;
      this.afterPlaybackStopped();
    },

    seek(t) {
      const wasPlaying = this.playing;
      if (wasPlaying) {
        this.naturalStop = false;
        try { this.source.stop(); } catch (_) {}
        this.playing = false;
      }
      this.sourceOffset = Math.max(0, Math.min(t, this.inputBuffer.duration));
      this.updatePlayhead(this.sourceOffset);
      this.renderMeters(this.sourceOffset);
      if (wasPlaying) this.startPlayback();
    },

    switchListen(mode) {
      if (mode === this.listenMode || !this.inputBuffer) return;
      const wasPlaying = this.playing;
      if (wasPlaying) {
        this.naturalStop = false;
        try { this.source.stop(); } catch (_) {}
        this.playing = false;
      }
      this.listenMode = mode;
      this.updateSegmentedButtons();
      if (wasPlaying) this.startPlayback();
      this.setStatus(mode === 'original' ? '正在试听原声。' : '正在试听处理结果。');
    },

    updateSegmentedButtons() {
      $('listenOriginal').classList.toggle('active', this.listenMode === 'original');
      $('listenProcessed').classList.toggle('active', this.listenMode === 'processed');
    },

    afterPlaybackStarted() {
      $('playBtn').textContent = '暂停';
      $('stopBtn').disabled = false;
    },

    afterPlaybackStopped() {
      cancelAnimationFrame(this.rafId);
      if (this.gainNode) {
        try { this.gainNode.disconnect(); } catch (_) {}
      }
      this.source = null;
      this.gainNode = null;
      $('playBtn').textContent = '播放';
      this.updatePlayhead(this.sourceOffset);
      this.renderMeters(this.sourceOffset);
    },

    updatePlayhead(t) {
      for (const v of Object.values(this.views)) v.setPlayhead(t);
      $('timeReadout').textContent =
        `${t.toFixed(2)} / ${this.inputBuffer.duration.toFixed(2)} s`;
    },

    // ---------------- 预设 ----------------

    savePreset(slot) {
      if (!this.result) return;
      this.presets[slot] = {
        params: { ...this.params },
        result: this.result,
        signature: this.compressSignature(),
      };
      this.updatePresetUI();
      this.setStatus(`已把当前参数存入设置 ${slot}。`);
    },

    loadPreset(slot) {
      const preset = this.presets[slot];
      if (!preset) return;
      const p = preset.params;
      $('threshold').value = p.thresholdDb;
      $('ratio').value = p.ratio;
      $('attack').value = p.attackMs;
      $('release').value = p.releaseMs;
      $('makeup').value = p.makeupDb;
      $('linked').checked = p.linked;
      $('loudnessMatch').checked = p.loudnessMatch;
      $('makeup').disabled = p.loudnessMatch;
      this.updateParamLabels();
      this.params = this.readControls();

      // 命中缓存则零计算切换；否则正常重算
      if (preset.result) this.cache.set(preset.signature, preset.result);
      this.reprocess();
      this.setStatus(`已调出设置 ${slot}，可与另一套在同一素材上快速对照。`);
    },

    updatePresetUI() {
      for (const slot of ['A', 'B']) {
        const preset = this.presets[slot];
        const info = $(`preset${slot}Info`);
        const loadBtn = $(`load${slot}`);
        if (preset) {
          const p = preset.params;
          info.textContent =
            `阈${p.thresholdDb.toFixed(0)} 比1:${p.ratio.toFixed(1)} ` +
            `A${p.attackMs.toFixed(0)} R${p.releaseMs.toFixed(0)}`;
          loadBtn.disabled = false;
        } else {
          info.textContent = '空';
          loadBtn.disabled = true;
        }
      }
    },

    // ---------------- 导出 ----------------

    exportWav() {
      if (!this.result) return;
      const cs = DSP.clipStats(
        this.processedChannelData,
        this.inputBuffer.sampleRate,
        this.effectiveMakeupDb
      );
      if (cs.clips > 0 &&
          !window.confirm(
            `当前补偿增益会导致 ${cs.clips} 个样本削波，导出时将被硬限幅。仍要导出吗？`
          )) {
        return;
      }
      const blob = DSP.encodeWav16(
        this.processedChannelData,
        this.inputBuffer.sampleRate,
        this.effectiveMakeupDb
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const base = this.isSynthetic ? 'builtin-sample' :
        this.fileName.replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = `${base}-compressed.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.setStatus(
        `已导出 WAV（${this.inputBuffer.numberOfChannels} 声道，` +
        `${this.inputBuffer.sampleRate} Hz，${this.inputBuffer.length} 采样，长度与原素材一致）。`
      );
    },

    // ---------------- 杂项 ----------------

    setStatus(msg, isError) {
      const el = $('statusLine');
      el.textContent = msg;
      el.style.color = isError ? 'var(--clip)' : '';
    },
  };

  document.addEventListener('DOMContentLoaded', () => App.init());
})();
