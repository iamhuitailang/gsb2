/* Canvas2D 渲染器：舞台预览与逐帧导出共用 renderFrame，导出顺序天然一致 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const M = G.Model;
  const I = G.Interpolate;

  const imageCache = new Map(); // src -> { img, status: 'loading'|'ok'|'error' }
  let imagesChangedHandler = null;

  function getImage(src) {
    if (!src) return null;
    let rec = imageCache.get(src);
    if (rec) return rec;
    rec = { img: null, status: 'loading' };
    imageCache.set(src, rec);
    const img = new Image();
    img.onload = () => {
      rec.img = img;
      rec.status = 'ok';
      if (imagesChangedHandler) imagesChangedHandler();
    };
    img.onerror = () => { rec.status = 'error'; };
    img.src = src;
    return rec;
  }

  function ensureProjectImages(project) {
    const srcs = [];
    M.flatten(project.children).forEach(({ layer }) => {
      if (layer.type === 'image' && layer.src) srcs.push(layer.src);
    });
    return Promise.all(srcs.map((src) => G.util.loadImage(src).catch(() => null)));
  }

  function setImagesChangedHandler(fn) {
    imagesChangedHandler = fn;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (r <= 0.01) {
      ctx.rect(x, y, w, h);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 按字符断行（兼容中英混排），返回每行字符数组与宽度 */
  function wrapText(ctx, text, maxWidth, letterSpacing) {
    const paragraphs = String(text == null ? '' : text).split('\n');
    const lines = [];
    paragraphs.forEach((para) => {
      const chars = Array.from(para);
      let line = [];
      let lineW = 0;
      for (const ch of chars) {
        const cw = ctx.measureText(ch).width;
        const addW = cw + (line.length > 0 ? letterSpacing : 0);
        if (lineW + addW > maxWidth && line.length > 0) {
          lines.push(line);
          line = [ch];
          lineW = cw;
        } else {
          line.push(ch);
          lineW += addW;
        }
      }
      lines.push(line);
    });
    return lines;
  }

  function lineWidth(ctx, chars, letterSpacing) {
    let w = 0;
    chars.forEach((ch, i) => {
      w += ctx.measureText(ch).width + (i > 0 ? letterSpacing : 0);
    });
    return w;
  }

  function drawTextLayer(ctx, layer, st) {
    const fs = layer.fontSize;
    const lh = fs * (layer.lineHeight || 1.25);
    const ls = layer.letterSpacing || 0;
    ctx.font = `${layer.fontWeight || 700} ${fs}px ${layer.fontFamily || 'sans-serif'}`;
    ctx.fillStyle = layer.color || '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const pad = 8;
    const maxW = Math.max(20, st.w - pad * 2);
    const lines = wrapText(ctx, layer.text, maxW, ls);
    const blockH = lines.length * lh;
    const align = layer.align || 'center';

    lines.forEach((chars, i) => {
      const lw = lineWidth(ctx, chars, ls);
      let x0;
      if (align === 'left') x0 = -st.w / 2 + pad;
      else if (align === 'right') x0 = st.w / 2 - pad - lw;
      else x0 = -lw / 2;
      const y = -blockH / 2 + lh / 2 + i * lh;
      let x = x0;
      chars.forEach((ch, ci) => {
        ctx.fillText(ch, x, y);
        x += ctx.measureText(ch).width + ls;
      });
    });
  }

  function drawRectLayer(ctx, layer, st) {
    const r = layer.radius || 0;
    roundRectPath(ctx, -st.w / 2, -st.h / 2, st.w, st.h, r);
    if (layer.fill && layer.fill !== 'none') {
      ctx.fillStyle = layer.fill;
      ctx.fill();
    }
    if (layer.strokeWidth > 0 && layer.strokeColor) {
      ctx.lineWidth = layer.strokeWidth;
      ctx.strokeStyle = layer.strokeColor;
      ctx.stroke();
    }
  }

  function drawImageLayer(ctx, layer, st) {
    const rec = getImage(layer.src);
    const img = rec && rec.img;
    if (!img) {
      // 占位框，避免空白让用户以为图层丢失
      roundRectPath(ctx, -st.w / 2, -st.h / 2, st.w, st.h, 8);
      ctx.fillStyle = 'rgba(110,139,255,0.14)';
      ctx.fill();
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(140,162,255,0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(220,228,255,0.85)';
      ctx.font = '600 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rec && rec.status === 'error' ? '图片加载失败' : '图片加载中…', 0, 0);
      return;
    }
    const iw = layer.imgW || img.naturalWidth || img.width;
    const ih = layer.imgH || img.naturalHeight || img.height;
    const fit = layer.fit || 'contain';

    if (fit === 'fill') {
      ctx.drawImage(img, -st.w / 2, -st.h / 2, st.w, st.h);
      return;
    }
    if (fit === 'cover') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-st.w / 2, -st.h / 2, st.w, st.h);
      ctx.clip();
      const s = Math.max(st.w / iw, st.h / ih);
      const dw = iw * s;
      const dh = ih * s;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }
    // contain
    const s = Math.min(st.w / iw, st.h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  }

  function applyShadow(ctx, layer) {
    const sh = layer.shadow;
    if (sh && sh.enabled) {
      ctx.shadowColor = sh.color || 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = sh.blur || 0;
      ctx.shadowOffsetX = sh.offsetX || 0;
      ctx.shadowOffsetY = sh.offsetY || 0;
    }
  }

  function renderLayer(ctx, layer, time) {
    if (!I.isActiveAt(layer, time)) return;
    const st = I.sampleLayer(layer, time);
    if (st.opacity <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = st.opacity / 100;
    ctx.translate(st.x, st.y);
    ctx.rotate((st.rotation * Math.PI) / 180);
    ctx.scale(
      Math.max(0.0001, st.scaleX / 100),
      Math.max(0.0001, st.scaleY / 100)
    );
    applyShadow(ctx, layer);

    if (layer.type === 'text') drawTextLayer(ctx, layer, st);
    else if (layer.type === 'rect') drawRectLayer(ctx, layer, st);
    else if (layer.type === 'image') drawImageLayer(ctx, layer, st);

    ctx.restore();
  }

  /** 渲染整帧（透明背景：只 clear，不铺底色）。预览与导出共用 */
  function renderFrame(ctx, project, time) {
    ctx.clearRect(0, 0, project.width, project.height);
    const list = M.paintList(project.children); // 面板顶→底
    for (let i = list.length - 1; i >= 0; i--) {
      renderLayer(ctx, list[i].layer, time);
    }
  }

  /** 安全区 / 三分线（仅舞台 overlay 使用，不进入导出） */
  function drawGuides(ctx, project, viewScale) {
    const W = project.width;
    const H = project.height;
    const lw = 1.5 / (viewScale || 1);

    if (project.safeArea) {
      // 动作安全区 93%（边距 3.5%）标签在左上；标题安全区 90%（边距 5%）标签在左下，避免重叠
      const boxes = [
        { ratio: 0.93, color: 'rgba(140,162,255,0.95)', label: '动作安全区 93%', vAlign: 'top' },
        { ratio: 0.9, color: 'rgba(255,206,84,0.98)', label: '标题安全区 90%', vAlign: 'bottom' },
      ];
      boxes.forEach((b) => {
        const w = W * b.ratio;
        const h = H * b.ratio;
        const x = (W - w) / 2;
        const y = (H - h) / 2;
        const u = 1 / (viewScale || 1);
        ctx.save();
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5 * u;
        ctx.setLineDash([14 * u, 9 * u]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        const fs = 22 * u;
        const pad = 10 * u;
        ctx.font = `700 ${fs}px -apple-system, "PingFang SC", sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(b.label).width;
        const boxW = tw + 22 * u;
        const boxH = fs * 1.55;
        const bx = x + 10 * u;
        const by = b.vAlign === 'top' ? y + 10 * u : y + h - 10 * u - boxH;
        ctx.fillStyle = 'rgba(15,18,28,0.78)';
        roundRectPath(ctx, bx, by, boxW, boxH, 6 * u);
        ctx.fill();
        ctx.fillStyle = b.color;
        ctx.fillText(b.label, bx + 11 * u, by + boxH / 2 + 1 * u);
        ctx.restore();
      });
    }

    if (project.thirds) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = lw;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo((W / 3) * i, 0);
        ctx.lineTo((W / 3) * i, H);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, (H / 3) * i);
        ctx.lineTo(W, (H / 3) * i);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  G.Renderer = {
    renderFrame,
    drawGuides,
    getImage,
    ensureProjectImages,
    setImagesChangedHandler,
    roundRectPath,
  };
})();
