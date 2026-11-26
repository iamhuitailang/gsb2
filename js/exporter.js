/* 导出：透明 PNG 序列 ZIP、MediaRecorder 透明视频、当前帧 PNG */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const { downloadBlob, tick } = G.util;

  function makeCanvas(project) {
    const canvas = document.createElement('canvas');
    canvas.width = project.width;
    canvas.height = project.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    return { canvas, ctx };
  }

  function canvasToPNGBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('PNG 编码失败'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }

  function frameCount(project) {
    return Math.max(1, Math.round(project.duration * project.fps));
  }

  function safeName(name) {
    return String(name || 'motion-title').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'motion-title';
  }

  /** 逐帧渲染并打成 ZIP Blob（供下载或发送给本地编码服务） */
  async function renderPNGZip(project, handlers) {
    handlers = handlers || {};
    const onProgress = handlers.onProgress || function () {};
    await G.Renderer.ensureProjectImages(project);

    const total = frameCount(project);
    const { canvas, ctx } = makeCanvas(project);
    const files = [];
    const pad = Math.max(4, String(total).length);

    for (let i = 0; i < total; i++) {
      const t = i / project.fps;
      G.Renderer.renderFrame(ctx, project, t);
      const bytes = await canvasToPNGBytes(canvas);
      const no = String(i + 1).padStart(pad, '0');
      files.push({ name: `frames/frame_${no}.png`, bytes });
      onProgress(i + 1, total, `渲染第 ${i + 1}/${total} 帧`);
      // 每帧让出主线程，进度条才能刷新
      await tick(0);
    }

    const info =
      `灵动标题工坊 - 透明 PNG 图片序列\n` +
      `工程: ${project.name}\n` +
      `分辨率: ${project.width}x${project.height}\n` +
      `帧率: ${project.fps} fps\n` +
      `时长: ${project.duration} 秒\n` +
      `总帧数: ${total}（帧时间 0 … ${(total - 1) / project.fps}s）\n\n` +
      `合成透明视频（需本地安装 ffmpeg，https://ffmpeg.org）：\n` +
      `1) ProRes 4444 .mov（推荐，剪辑软件兼容性好）:\n` +
      `ffmpeg -framerate ${project.fps} -i frames/frame_%0${pad}d.png ` +
      `-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le output.mov\n\n` +
      `2) VP9 .webm（网页透明背景）:\n` +
      `ffmpeg -framerate ${project.fps} -i frames/frame_%0${pad}d.png ` +
      `-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 output.webm\n\n` +
      `3) QuickTime 动画 .mov（无损 alpha）:\n` +
      `ffmpeg -framerate ${project.fps} -i frames/frame_%0${pad}d.png ` +
      `-c:v qtrle -pix_fmt argb output_qtrle.mov\n`;
    files.push({
      name: 'README_导出说明.txt',
      bytes: new TextEncoder().encode(info),
    });

    onProgress(total, total, '正在打包 ZIP…');
    await tick(20);
    const blob = G.Zip.createZip(files);
    return { blob, total, pad };
  }

  /** 导出透明 PNG 序列并下载 zip；帧数 = round(时长 × 帧率) */
  async function exportPNGSequence(project, handlers) {
    const { blob, total } = await renderPNGZip(project, handlers);
    const filename = `${safeName(project.name)}_PNG序列_${project.width}x${project.height}_${project.fps}fps_${total}帧.zip`;
    downloadBlob(blob, filename);
    return { filename, total };
  }

  /* ---------- 本地 ffmpeg 编码服务（tools/studio_server.py） ---------- */
  let healthCache = null;
  async function checkHelper(force) {
    if (healthCache && !force) return healthCache;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch('/api/health', { signal: ctrl.signal });
      if (!r.ok) throw new Error('no');
      healthCache = await r.json();
    } catch (e) {
      healthCache = { ok: false, ffmpeg: null };
    }
    return healthCache;
  }

  /** 把 PNG 序列 ZIP 发给本地服务，返回带 alpha 的视频 Blob */
  async function encodeWithHelper(project, fmt, handlers) {
    const h = await checkHelper(true);
    if (!h.ffmpeg) throw new Error('本地编码服务未找到 ffmpeg');
    const { blob: zipBlob, total } = await renderPNGZip(project, handlers);
    handlers?.onProgress?.(total, total, '已渲染全部帧，ffmpeg 合成中…');
    const r = await fetch(`/api/encode?fps=${project.fps}&fmt=${fmt}`, {
      method: 'POST',
      body: zipBlob,
      headers: { 'Content-Type': 'application/zip' },
    });
    if (!r.ok) {
      let msg = `编码服务返回 ${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    const ext = fmt === 'mov' ? 'mov' : 'webm';
    const filename = `${safeName(project.name)}_透明_${project.width}x${project.height}_${project.fps}fps.${ext}`;
    downloadBlob(blob, filename);
    return { filename, total, bytes: blob.size, fmt };
  }

  /** 导出当前时刻单帧 PNG */
  async function exportCurrentFrame(project, time) {
    await G.Renderer.ensureProjectImages(project);
    const { canvas, ctx } = makeCanvas(project);
    G.Renderer.renderFrame(ctx, project, time);
    const bytes = await canvasToPNGBytes(canvas);
    const blob = new Blob([bytes], { type: 'image/png' });
    const filename = `${safeName(project.name)}_t${time.toFixed(2)}s.png`;
    downloadBlob(blob, filename);
    return { filename };
  }

  function pickVideoMime() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=h264',
      'video/mp4',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) return c;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function alphaLikelySupported(mime) {
    return /webm|vp8|vp9/i.test(mime || '');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 实时录制 Canvas 流。按帧表定时渲染 + requestFrame，
   * 节奏对齐 1/fps，使容器时长 ≈ duration、帧率 = fps。
   * 透明通道仅在支持 alpha 的 WebM(VP8/VP9) 录制器中保留（推荐桌面 Chrome）。
   */
  async function exportVideo(project, handlers) {
    handlers = handlers || {};
    const onProgress = handlers.onProgress || function () {};
    await G.Renderer.ensureProjectImages(project);

    const mime = pickVideoMime();
    if (!mime) throw new Error('当前浏览器不支持 MediaRecorder 视频录制，请改用 PNG 序列导出');

    const { canvas, ctx } = makeCanvas(project);
    // captureStream(0) + 手动 requestFrame，保证一帧不多一帧不少
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 20_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

    const total = frameCount(project);
    const frameMs = 1000 / project.fps;

    recorder.start(); // 不传 timeslice，WebM 尾部才会写完整 duration
    await tick(60);

    const startWall = performance.now();
    for (let i = 0; i < total; i++) {
      const target = startWall + i * frameMs;
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
      G.Renderer.renderFrame(ctx, project, i / project.fps);
      if (track.requestFrame) track.requestFrame();
      onProgress(i + 1, total, `录制第 ${i + 1}/${total} 帧（实时）`);
    }
    // 让最后一帧持续一个帧间隔，保证总时长 = total / fps
    await sleep(Math.max(20, startWall + total * frameMs - performance.now()));
    recorder.stop();
    await stopped;

    const ext = /mp4/i.test(mime) ? 'mp4' : 'webm';
    const type = /mp4/i.test(mime) ? 'video/mp4' : 'video/webm';
    const blob = new Blob(chunks, { type });
    const filename = `${safeName(project.name)}_${project.width}x${project.height}_${project.fps}fps.${ext}`;
    downloadBlob(blob, filename);
    return { filename, total, mime, alpha: alphaLikelySupported(mime), bytes: blob.size };
  }

  G.Exporter = {
    exportPNGSequence,
    exportCurrentFrame,
    exportVideo,
    renderPNGZip,
    checkHelper,
    encodeWithHelper,
    pickVideoMime,
    alphaLikelySupported,
    frameCount,
  };
})();
