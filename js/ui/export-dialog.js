/* 导出弹窗：PNG 序列 ZIP / 透明视频（本地 ffmpeg 引擎或浏览器录制）/ 当前帧 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const h = G.util.h;

  let mode = 'seq';
  let videoFmt = 'webm';
  let running = false;
  let helper = null; // null=检测中, {ffmpeg:...}|{ok:false}

  function open(initialMode) {
    mode = initialMode || 'seq';
    const modal = document.getElementById('exportModal');
    modal.hidden = false;
    helper = null;
    render();
    G.Exporter.checkHelper(true).then((info) => {
      helper = info;
      if (!document.getElementById('exportModal').hidden && !running) render();
    });
  }
  function close() {
    if (running) return;
    document.getElementById('exportModal').hidden = true;
  }

  function render() {
    const p = G.App.state.project;
    const total = G.Exporter.frameCount(p);
    const mime = G.Exporter.pickVideoMime();
    const alpha = G.Exporter.alphaLikelySupported(mime);
    const body = document.getElementById('exportBody');
    document.getElementById('exportTitle').textContent = '导出 · 透明背景';
    body.innerHTML = '';

    const summary = h('div', { class: 'export-summary' }, [
      h('div', { class: 'summary-card' }, [h('div', { class: 'v' }, `${p.width}×${p.height}`), h('div', { class: 'k' }, '分辨率（像素）')]),
      h('div', { class: 'summary-card' }, [h('div', { class: 'v' }, `${p.fps}`), h('div', { class: 'k' }, '帧率 fps')]),
      h('div', { class: 'summary-card' }, [h('div', { class: 'v' }, `${total}`), h('div', { class: 'k' }, `总帧数 · ${p.duration}s`)]),
    ]);

    const cards = h('div', { class: 'radio-cards', style: { marginTop: '16px' } });
    cards.appendChild(h('div', {
      class: `radio-card ${mode === 'seq' ? 'selected' : ''}`,
      onclick: () => { if (!running) { mode = 'seq'; render(); } },
    }, [
      h('div', { class: 'rc-title' }, '透明 PNG 图片序列 (.zip)'),
      h('div', { class: 'rc-desc' }, `逐帧渲染 ${total} 张 RGBA PNG（含 alpha 透明通道），按 帧率×时长 精确生成，最稳妥的交付方式。`),
    ]));
    cards.appendChild(h('div', {
      class: `radio-card ${mode === 'video' ? 'selected' : ''}`,
      onclick: () => { if (!running) { mode = 'video'; render(); } },
    }, [
      h('div', { class: 'rc-title' }, '透明视频 (WebM / MOV)'),
      h('div', { class: 'rc-desc' }, '优先调用本地 ffmpeg 由逐帧 PNG 合成，alpha、帧率、时长都精确；无本地服务时回退到浏览器实时录制。'),
    ]));

    body.appendChild(h('div', { class: 'export-opts' }, [summary, cards]));

    if (mode === 'seq') body.appendChild(seqNote(total));
    else body.appendChild(videoEngineBlock(mime, alpha));

    const progressWrap = h('div', { id: 'exportProgress', style: { marginTop: '16px', display: 'none' } }, [
      h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill', id: 'exportProgressFill' })),
      h('div', { class: 'progress-label' }, [h('span', { id: 'exportProgressText' }, '准备中…'), h('span', { id: 'exportProgressPct' }, '0%')]),
    ]);
    body.appendChild(progressWrap);
    body.appendChild(h('div', { id: 'exportResult' }));

    const actionLabel = mode === 'seq'
      ? `导出 ${total} 张 PNG (ZIP)`
      : (helper && helper.ffmpeg
          ? `用本地 ffmpeg 导出透明 ${videoFmt.toUpperCase()}`
          : `浏览器录制 ${p.duration}s WebM`);

    const actions = h('div', { class: 'modal-actions' }, [
      h('button', { class: 'btn', id: 'btnFramePng', onclick: exportFrame }, '仅导出当前帧 PNG'),
      h('span', { class: 'flex1' }),
      h('button', { class: 'btn', onclick: close }, '取消'),
      h('button', { class: 'btn btn-accent-solid', id: 'btnDoExport', onclick: doExport }, actionLabel),
    ]);
    body.appendChild(actions);
  }

  function seqNote(total) {
    return h('div', { class: 'export-warn', style: { marginTop: '12px' } },
      `ZIP 内为 frames/frame_0001.png …（共 ${total} 帧），并附带 ffmpeg 透明视频合成命令。导出期间请保持本页面在前台。`);
  }

  function videoEngineBlock(mime, alpha) {
    const box = h('div', { style: { marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' } });

    if (helper === null) {
      box.appendChild(h('div', { class: 'export-warn' }, '正在检测本地 ffmpeg 编码服务…'));
      return box;
    }

    if (helper.ffmpeg) {
      const fmtSel = h('select', { class: 'input', style: { width: '260px' } }, [
        h('option', { value: 'webm' }, 'VP9 WebM · 网页透明背景'),
        h('option', { value: 'mov' }, 'ProRes 4444 MOV · 剪辑软件'),
      ]);
      fmtSel.value = videoFmt;
      fmtSel.addEventListener('change', () => { videoFmt = fmtSel.value; render(); });

      box.appendChild(h('div', { class: 'export-result', style: { marginTop: '0' } },
        `✅ 已连接本地编码服务并找到 ffmpeg（${helper.version ? helper.version.split(' ').slice(0, 3).join(' ') : ''}）。` +
        '将由逐帧 PNG 直接编码，透明通道、帧率与时长严格保留。'));
      box.appendChild(h('div', { class: 'insp-row' }, [
        (() => { const l = document.createElement('label'); l.className = 'field-label'; l.style.width = '64px'; l.textContent = '格式'; return l; })(),
        fmtSel,
      ]));
      return box;
    }

    box.appendChild(h('div', { class: 'export-warn' },
      '未检测到本地 ffmpeg 编码服务（若用 python3 -m http.server 或直接打开 index.html 即会如此）。' +
      '当前可使用浏览器录制，但 Chrome 的 MediaRecorder 通常不会写入 alpha 通道（背景可能变黑）。' +
      '想一键得到真正透明、帧率时长精确的视频，请取消后改用 ' +
      '「python3 tools/studio_server.py 8123」或双击「启动工具.command」启动，再回到此页导出；' +
      '也可以先导出 PNG 序列，用 README 中的 ffmpeg 命令合成。'));
    box.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--txt-3)' } },
      `浏览器录制编码：${mime || '不可用'}（alpha 支持不确定：${alpha ? '可能保留' : '大概率不保留'}）`));
    return box;
  }

  function setProgress(done, total, text) {
    const wrap = document.getElementById('exportProgress');
    if (!wrap) return;
    wrap.style.display = 'block';
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById('exportProgressFill').style.width = `${pct}%`;
    document.getElementById('exportProgressPct').textContent = `${pct}%`;
    document.getElementById('exportProgressText').textContent = text || `${done}/${total}`;
  }

  function showResult(html, isError) {
    const el = document.getElementById('exportResult');
    if (!el) return;
    el.className = isError ? 'export-warn' : 'export-result';
    el.style.marginTop = '14px';
    el.innerHTML = html;
  }

  async function doExport() {
    if (running) return;
    running = true;
    const btn = document.getElementById('btnDoExport');
    if (btn) btn.disabled = true;
    const result = document.getElementById('exportResult');
    if (result) result.innerHTML = '';
    G.App.pause();

    try {
      const p = G.App.state.project;
      if (mode === 'seq') {
        const r = await G.Exporter.exportPNGSequence(p, { onProgress: setProgress });
        showResult(`✅ 已导出 <b>${r.filename}</b>，共 ${r.total} 帧透明 PNG。浏览器下载可能需要几秒。`);
        G.toast('PNG 序列导出完成', 'success');
      } else if (helper && helper.ffmpeg) {
        const r = await G.Exporter.encodeWithHelper(p, videoFmt, { onProgress: setProgress });
        setProgress(1, 1, '完成');
        showResult(`✅ 本地 ffmpeg 已合成 <b>${r.filename}</b>（${(r.bytes / 1024 / 1024).toFixed(1)} MB），alpha/帧率/时长精确保留。`);
        G.toast('透明视频导出完成', 'success');
      } else {
        setProgress(0, 100, '开始录制…');
        const r = await G.Exporter.exportVideo(p, {
          onProgress: (i, total, text) => setProgress(i, total, text),
        });
        setProgress(r.total, r.total, '录制完成，正在封装下载…');
        showResult(`✅ 已导出 <b>${r.filename}</b>（${(r.bytes / 1024 / 1024).toFixed(1)} MB，编码 ${r.mime}）。` +
          (r.alpha ? '若播放背景为黑色，说明浏览器未写入 alpha，请改用 PNG 序列 + ffmpeg。'
                  : '当前浏览器大概率未保留 alpha，透明交付请使用 PNG 序列 + ffmpeg 或本地编码服务。'));
        G.toast('视频导出完成', 'success');
      }
    } catch (err) {
      console.error(err);
      showResult(`❌ 导出失败：${err.message || err}`, true);
      G.toast('导出失败：' + (err.message || err), 'error', 4000);
    } finally {
      running = false;
      const b = document.getElementById('btnDoExport');
      if (b) b.disabled = false;
    }
  }

  async function exportFrame() {
    try {
      G.App.pause();
      const r = await G.Exporter.exportCurrentFrame(G.App.state.project, G.App.state.time);
      G.toast(`已导出 ${r.filename}`, 'success');
    } catch (err) {
      G.toast('导出失败：' + err.message, 'error');
    }
  }

  G.UI = G.UI || {};
  G.UI.ExportDialog = { open, close };
})();
