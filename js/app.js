/*
 * app.js — UI：时间线、双视图（合成整帧 / 本帧局部）、播放、跳帧、导出与像素对照。
 */
(function () {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  const compositeCanvas = $('compositeCanvas');
  const rawCanvas = $('rawCanvas');
  const timelineEl = $('timeline');

  let state = null; // { parsed, compositor, timeline, name, current, playing, timer }

  // ------------------------------------------------------------ 加载

  function loadBuffer(buf, name) {
    stopPlayback();
    let parsed;
    try {
      parsed = GifCore.parseGif(buf);
    } catch (e) {
      $('globalInfo').textContent = '解析失败：' + e.message;
      return;
    }
    state = {
      parsed: parsed,
      compositor: GifCore.createCompositor(parsed),
      timeline: GifCore.buildTimeline(parsed),
      name: name,
      current: 0,
      playing: false,
      timer: null,
    };
    renderGlobalInfo();
    buildTimeline();
    if (parsed.frames.length > 0) showFrame(0);
    else $('frameInfo').innerHTML = '<tr><td>没有可用帧</td></tr>';
  }

  function renderGlobalInfo() {
    const p = state.parsed, tl = state.timeline;
    const loopDesc = p.loopCount === null ? '未声明（播一次）'
      : p.loopCount === 0 ? '无限循环' : '循环 ' + p.loopCount + ' 次';
    let html = '文件：' + state.name +
      '　画布：' + p.width + '×' + p.height +
      '　帧数：' + p.frames.length +
      '　循环：' + loopDesc +
      '　预览单圈时长：' + tl.totalPlayMs + 'ms（文件原始 ' + tl.totalFileMs + 'ms）' +
      (p.truncated ? '　⚠ 文件被截断' : '');
    if (p.warnings.length) html += '\n警告：' + p.warnings.join('；');
    $('globalInfo').textContent = html;
  }

  // ------------------------------------------------------------ 时间线

  function buildTimeline() {
    const tl = state.timeline;
    timelineEl.innerHTML = '';
    const maxMs = Math.max.apply(null, tl.frames.map(function (f) { return f.playMs; }).concat([1]));
    tl.frames.forEach(function (f) {
      const div = document.createElement('div');
      div.className = 'tl-frame' + (f.disposal === 2 ? ' d2' : f.disposal === 3 ? ' d3' : '') + (f.zeroDelay ? ' zero' : '');
      // 宽度 ∝ 实际播放时长，归一化到 26~160px
      div.style.width = Math.max(26, Math.round(160 * f.playMs / maxMs)) + 'px';
      div.textContent = f.index;
      if (f.transparent) {
        const b = document.createElement('span');
        b.className = 'badge'; b.textContent = 'T';
        div.appendChild(b);
      }
      div.title = '帧 ' + f.index +
        '　区域 (' + f.left + ',' + f.top + ' ' + f.width + '×' + f.height + ')' +
        '　时长 ' + f.delayCs + 'cs' + (f.normalized ? ' → 播放按 ' + f.playMs + 'ms' : '') +
        '　' + f.disposalName + (f.zeroDelay ? '　⚠零时长' : '');
      div.addEventListener('click', function () { pausePlayback(); showFrame(f.index); });
      timelineEl.appendChild(div);
    });
    if (tl.hasLoopSeam) {
      const seam = document.createElement('div');
      seam.className = 'tl-seam';
      seam.title = '循环接缝：末帧播完后回到帧 0（末帧的处置方式会先应用）';
      timelineEl.appendChild(seam);
    }
    $('timelineHint').textContent =
      '块宽度 ∝ 实际播放时长；点击任意帧跳转（随机跳帧与顺序播放结果一致）';
  }

  // ------------------------------------------------------------ 帧显示

  function fitScale(w, h, max) { return Math.max(1, Math.min(8, Math.floor(max / Math.max(w, h)))); }

  function showFrame(n) {
    const p = state.parsed;
    if (n < 0 || n >= p.frames.length) return;
    state.current = n;
    const f = p.frames[n];
    const tf = state.timeline.frames[n];

    // 合成整帧
    const out = state.compositor.renderFrame(n);
    const W = p.width, H = p.height;
    const scale = fitScale(W, H, 320);
    compositeCanvas.width = W * scale;
    compositeCanvas.height = H * scale;
    compositeCanvas.style.width = W * scale + 'px';
    compositeCanvas.style.height = H * scale + 'px';
    const cctx = compositeCanvas.getContext('2d');
    // 先画到离屏再放大，保持像素锐利
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    off.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    cctx.imageSmoothingEnabled = false;
    cctx.clearRect(0, 0, compositeCanvas.width, compositeCanvas.height);
    cctx.drawImage(off, 0, 0, W * scale, H * scale);
    // 本帧区域框
    cctx.strokeStyle = '#ff4dd2';
    cctx.lineWidth = Math.max(1, scale / 4);
    cctx.strokeRect(f.left * scale, f.top * scale, f.width * scale, f.height * scale);

    // 本帧局部数据
    const raw = state.compositor.rawFrameRGBA(n);
    const rscale = fitScale(f.width, f.height, 160);
    rawCanvas.width = f.width * rscale;
    rawCanvas.height = f.height * rscale;
    rawCanvas.style.width = f.width * rscale + 'px';
    rawCanvas.style.height = f.height * rscale + 'px';
    const roff = document.createElement('canvas');
    roff.width = f.width; roff.height = f.height;
    roff.getContext('2d').putImageData(new ImageData(raw, f.width, f.height), 0, 0);
    const rctx = rawCanvas.getContext('2d');
    rctx.imageSmoothingEnabled = false;
    rctx.clearRect(0, 0, rawCanvas.width, rawCanvas.height);
    rctx.drawImage(roff, 0, 0, f.width * rscale, f.height * rscale);

    // 信息表
    const rows = [
      ['帧序号', n + ' / ' + (p.frames.length - 1)],
      ['区域', 'left=' + f.left + ' top=' + f.top + '　' + f.width + '×' + f.height +
        (f.width === W && f.height === H ? '（全帧）' : '（局部帧）')],
      ['文件时长', f.delayCs + ' cs（' + tf.delayMsRaw + ' ms）' + (f.zeroDelay ? ' <span class="flag">⚠ 零时长帧</span>' : '')],
      ['播放时长', tf.playMs + ' ms' + (tf.normalized ? '（浏览器归一化：&lt;20ms 按 100ms）' : '')],
      ['播放起点', '文件时序 ' + tf.startMsFile + ' ms　/　播放时序 ' + tf.startMsPlay + ' ms'],
      ['结束后画布', f.disposal + ' — ' + tf.disposalName],
      ['透明色', f.transparentFlag ? '索引 ' + f.transparentIndex : '无'],
      ['交错', f.interlaced ? '是' : '否'],
      ['局部调色板', f.localColorTable ? '有（' + f.localColorTable.length + ' 色）' : '无（用全局）'],
      ['像素数据', f.decodeComplete ? '完整' : '<span class="flag">不完整（文件截断）</span>'],
    ];
    $('frameInfo').innerHTML = rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }).join('');

    // 时间线高亮
    const nodes = timelineEl.querySelectorAll('.tl-frame');
    nodes.forEach(function (el, i) { el.classList.toggle('current', i === n); });
    if (nodes[n]) nodes[n].scrollIntoView({ block: 'nearest', inline: 'nearest' });

    $('playPos').textContent = '帧 ' + n + ' / ' + (p.frames.length - 1);
  }

  // ------------------------------------------------------------ 播放

  function stopPlayback() {
    if (state && state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state) state.playing = false;
    $('btnPlay').textContent = '▶';
  }
  function pausePlayback() { stopPlayback(); }

  function scheduleNext() {
    if (!state.playing) return;
    const tf = state.timeline.frames[state.current];
    state.timer = setTimeout(function () {
      let next = state.current + 1;
      if (next >= state.parsed.frames.length) next = 0; // 循环接缝：回到帧 0
      showFrame(next);
      scheduleNext();
    }, Math.max(20, tf.playMs));
  }

  function togglePlay() {
    if (!state || state.parsed.frames.length === 0) return;
    if (state.playing) { stopPlayback(); return; }
    state.playing = true;
    $('btnPlay').textContent = '⏸';
    scheduleNext();
  }

  // ------------------------------------------------------------ 导出（zip：PNG 序列 + 时间清单）

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function strBytes(s) { return new TextEncoder().encode(s); }

  // 简易 zip（store，不压缩）
  function buildZip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = strBytes(e.name);
      const crc = crc32(e.data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(14, crc, true);
      head.setUint32(18, e.data.length, true);
      head.setUint32(22, e.data.length, true);
      head.setUint16(26, name.length, true);
      parts.push(new Uint8Array(head.buffer), name, e.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(6, 20, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, e.data.length, true);
      cen.setUint32(24, e.data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + e.data.length;
    }
    const cenSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  function canvasToPngBytes(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error('PNG 编码失败'));
        blob.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); }, reject);
      }, 'image/png');
    });
  }

  async function exportAll() {
    if (!state || state.parsed.frames.length === 0) return;
    pausePlayback();
    const p = state.parsed;
    const status = $('exportStatus');
    status.textContent = '正在导出…';
    const W = p.width, H = p.height;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');

    const entries = [];
    const pngs = [];
    for (let i = 0; i < p.frames.length; i++) {
      const out = state.compositor.renderFrame(i);
      octx.putImageData(new ImageData(out, W, H), 0, 0);
      const bytes = await canvasToPngBytes(off);
      const fname = 'frame_' + String(i).padStart(3, '0') + '.png';
      entries.push({ name: fname, data: bytes });
      pngs.push({ name: fname, bytes: bytes, expected: out });
    }
    const manifest = GifCore.buildTimingManifest(p, state.name);
    entries.push({ name: 'timing.json', data: strBytes(JSON.stringify(manifest, null, 2)) });
    entries.push({ name: 'timing.csv', data: strBytes(GifCore.manifestToCSV(manifest)) });

    const zip = buildZip(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = (state.name || 'gif').replace(/\.gif$/i, '') + '_frames.zip';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);

    // 像素对照：把每张导出的 PNG 解码回来，与预览（合成器输出）逐像素比较
    status.textContent = '已导出 ' + pngs.length + ' 张 PNG + timing.json/csv，正在对照像素…';
    const results = [];
    let mismatch = 0;
    for (const item of pngs) {
      const bmp = await createImageBitmap(new Blob([item.bytes], { type: 'image/png' }));
      const vc = document.createElement('canvas');
      vc.width = W; vc.height = H;
      const vctx = vc.getContext('2d');
      vctx.drawImage(bmp, 0, 0);
      const got = vctx.getImageData(0, 0, W, H).data;
      let diff = 0;
      for (let j = 0; j < got.length; j++) if (got[j] !== item.expected[j]) diff++;
      if (diff > 0) mismatch++;
      results.push({ name: item.name, diff: diff });
      bmp.close();
    }
    status.innerHTML = '导出完成：' + pngs.length + ' 张 PNG + timing.json / timing.csv\n' +
      '像素对照：' + (mismatch === 0
        ? '<span class="ok">全部 ' + pngs.length + ' 张与预览完全一致 ✓</span>'
        : '<span class="bad">' + mismatch + ' 张不一致</span> ' +
          results.filter(function (r) { return r.diff > 0; })
            .map(function (r) { return r.name + '(差异字节 ' + r.diff + ')'; }).join('，'));
  }

  // ------------------------------------------------------------ 事件

  $('fileInput').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { loadBuffer(reader.result, file.name); };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  });

  $('btnPrev').addEventListener('click', function () {
    if (!state) return;
    pausePlayback();
    showFrame((state.current - 1 + state.parsed.frames.length) % state.parsed.frames.length);
  });
  $('btnNext').addEventListener('click', function () {
    if (!state) return;
    pausePlayback();
    showFrame((state.current + 1) % state.parsed.frames.length);
  });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnExport').addEventListener('click', function () {
    exportAll().catch(function (e) { $('exportStatus').textContent = '导出失败：' + e.message; });
  });

  document.addEventListener('keydown', function (e) {
    if (!state || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') $('btnPrev').click();
    else if (e.key === 'ArrowRight') $('btnNext').click();
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });

  // 内置样例
  const samples = GifEncoder.buildSamples();
  const holder = $('sampleButtons');
  samples.forEach(function (s) {
    const b = document.createElement('button');
    b.textContent = s.name.replace(/\.gif$/, '');
    b.title = s.desc + '（点击加载；右键此处无下载，可在加载后导出）';
    b.addEventListener('click', function () {
      loadBuffer(s.bytes.buffer.slice(s.bytes.byteOffset, s.bytes.byteOffset + s.bytes.byteLength), s.name);
    });
    holder.appendChild(b);
  });
})();
