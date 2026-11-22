/* 边缘去底色工具 UI 逻辑。依赖 processor.js（window.EdgeUnmix）。 */
(function () {
  "use strict";
  const P = window.EdgeUnmix;

  // ---------- 常量 ----------
  const BG_SWATCHES = [
    { name: "近白 #f5f6f7", hex: "#f5f6f7" },
    { name: "浅灰 #c8ccd2", hex: "#c8ccd2" },
    { name: "中灰 #6b7078", hex: "#6b7078" },
    { name: "深灰 #2c2f36", hex: "#2c2f36" },
    { name: "近黑 #0e0f12", hex: "#0e0f12" },
  ];
  const MAT_PRESETS = ["#ffffff", "#f2f2f2", "#e8e8e8", "#d9d9d9", "#000000"];
  const STORAGE_KEY = "edge-unmix-v1";
  const $ = (id) => document.getElementById(id);

  // ---------- 全局状态 ----------
  const state = {
    images: [], // {id,name,width,height,imgCanvas,maskCanvas,settings,result,stats,flags}
    currentId: null,
    tool: "inspect", // inspect | protect | erase
    brush: 6,
    zoom: 1,
    panX: 0,
    panY: 0,
    bgHex: "#2c2f36",
    viewMode: "after", // after | before
    showLowConf: true,
    showMask: true,
    inspector: null, // {x,y}
    holdCompare: false,
    spaceDown: false,
  };

  let idSeq = 1;

  // ---------- 小工具 ----------
  function current() {
    return state.images.find((im) => im.id === state.currentId) || null;
  }

  function cloneSettings(s) {
    return JSON.parse(JSON.stringify(s));
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          bgHex: state.bgHex,
          showLowConf: state.showLowConf,
          showMask: state.showMask,
          shared: state.images.length ? current()?.settings : null,
        })
      );
    } catch (e) {
      /* 存储不可用时静默 */
    }
  }

  // ---------- 加载图像 ----------
  // 优先用字节级 PNG 解码，得到 straight-alpha 的原始 RGBA（无损）；
  // 不支持的 PNG 格式回退到浏览器解码，但会标记为非无损。
  async function decodeFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let rgba, width, height, lossless = true;
    try {
      const d = await window.PngCodec.decodePngAsync(bytes);
      rgba = d.data;
      width = d.width;
      height = d.height;
    } catch (err) {
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("无法解码：" + file.name));
          im.src = url;
        });
        width = img.naturalWidth;
        height = img.naturalHeight;
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        rgba = g.getImageData(0, 0, width, height).data;
        lossless = false;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return { name: file.name, width, height, rgba: new Uint8ClampedArray(rgba), lossless };
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.png$/i.test(f.name));
    if (!files.length) return;
    // Promise.all 保持与文件选择一致的顺序
    const decoded = await Promise.all(files.map(decodeFile));
    const wasEmpty = state.images.length === 0;
    decoded.forEach((d) => addImageEntry(d));
    if (wasEmpty) selectImage(state.images[0].id);
  }

  function addImageEntry(decoded) {
    const { name, width, height, rgba, lossless } = decoded;
    if (!lossless) {
      console.warn(name + " 不是 8-bit RGBA PNG，已用浏览器解码，导出无法保证逐字节无损");
    }
    const persisted = loadPersisted();
    const settings = cloneSettings(
      current()?.settings || persisted?.shared || P.defaultSettings()
    );

    // 显示用 canvas（仅用于屏幕渲染；处理与导出只认 srcBytes）
    const imgCanvas = document.createElement("canvas");
    imgCanvas.width = width;
    imgCanvas.height = height;
    imgCanvas
      .getContext("2d", { willReadFrequently: true })
      .putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    maskCanvas.getContext("2d", { willReadFrequently: true });

    // 字节级原始 RGBA：处理与导出都以此为准，绕开 canvas 预乘 alpha 的回读舍入
    const srcBytes = new Uint8ClampedArray(rgba);

    // 透明区提示层：仅在全透明像素位置画极淡白色，加载时一次性生成
    const transparentCanvas = document.createElement("canvas");
    transparentCanvas.width = width;
    transparentCanvas.height = height;
    {
      const tg = transparentCanvas.getContext("2d");
      const td = tg.createImageData(width, height);
      for (let p = 0; p < width * height; p++) {
        if (srcBytes[p * 4 + 3] === 0) {
          td.data[p * 4] = 255;
          td.data[p * 4 + 1] = 255;
          td.data[p * 4 + 2] = 255;
          td.data[p * 4 + 3] = 28;
        }
      }
      tg.putImageData(td, 0, 0);
    }
    const entry = {
      id: idSeq++,
      name,
      width,
      height,
      imgCanvas,
      maskCanvas,
      transparentCanvas,
      srcBytes,
      mask: new Uint8Array(width * height),
      lossless,
      settings,
      result: null,
      resultBytes: null,
      flags: null,
      stats: null,
    };
    state.images.push(entry);
    reprocess(entry);
    renderImageList();
    updateExportButtons();
  }

  // 把掩码数组同步到用于显示的 maskCanvas
  function syncMaskCanvas(im) {
    const g = im.maskCanvas.getContext("2d", { willReadFrequently: true });
    const img = g.createImageData(im.width, im.height);
    for (let p = 0; p < im.mask.length; p++) {
      if (im.mask[p] === 255) {
        img.data[p * 4] = 110;
        img.data[p * 4 + 1] = 168;
        img.data[p * 4 + 2] = 254;
        img.data[p * 4 + 3] = 230;
      }
    }
    g.putImageData(img, 0, 0);
  }

  // ---------- 核心处理 ----------
  function reprocess(im) {
    const r = P.unmixEdges({
      width: im.width,
      height: im.height,
      src: im.srcBytes,
      mask: im.mask,
      settings: im.settings,
    });
    // resultBytes 是导出用的无损字节；result canvas 仅用于屏幕显示
    im.resultBytes = r.data;
    im.flags = r.flags;
    im.stats = r.stats;
    const out = new ImageData(new Uint8ClampedArray(r.data), im.width, im.height);
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    c.getContext("2d", { willReadFrequently: true }).putImageData(out, 0, 0);
    im.result = c;
    persist();
  }

  // 防抖重处理绑定到“触发时的那张图”，避免切图后 current() 变化写错对象
  let pendingImage = null;
  let debounceTimer = null;
  function scheduleReprocess(im) {
    const target = im || current();
    if (!target) return;
    pendingImage = target;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (pendingImage) {
        reprocess(pendingImage);
        if (current() === pendingImage) renderAll();
      }
      pendingImage = null;
    }, 60);
  }
  function flushReprocess() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingImage) {
      reprocess(pendingImage);
      pendingImage = null;
    }
  }

  // ---------- 视图变换 ----------
  const view = $("view");
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = view.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    render();
  }
  window.addEventListener("resize", resizeCanvas);

  function fitZoom() {
    const im = current();
    if (!im) return;
    const r = view.getBoundingClientRect();
    const pad = 24;
    state.zoom = Math.min((r.width - pad * 2) / im.width, (r.height - pad * 2) / im.height, 8);
    state.zoom = Math.max(0.05, state.zoom);
    centerImage();
  }

  function centerImage() {
    const im = current();
    if (!im) return;
    const r = view.getBoundingClientRect();
    state.panX = (r.width - im.width * state.zoom) / 2;
    state.panY = (r.height - im.height * state.zoom) / 2;
  }

  function setZoom(z, cx, cy) {
    const old = state.zoom;
    state.zoom = Math.min(32, Math.max(0.05, z));
    if (cx !== undefined) {
      const ratio = state.zoom / old;
      state.panX = cx - (cx - state.panX) * ratio;
      state.panY = cy - (cy - state.panY) * ratio;
    }
    render();
    updateZoomLabel();
  }

  function updateZoomLabel() {
    $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  }

  // 屏幕坐标 → 原图整数坐标（放大后仍精确对应原图像素）
  function eventToImagePixel(e) {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const ix = Math.floor((sx - state.panX) / state.zoom);
    const iy = Math.floor((sy - state.panY) / state.zoom);
    return { sx, sy, ix, iy };
  }

  // ---------- 渲染 ----------
  function render() {
    const im = current();
    const r = view.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    if (!im) {
      $("empty").style.display = "flex";
      return;
    }
    $("empty").style.display = "none";

    const w = im.width * state.zoom;
    const h = im.height * state.zoom;
    const x = state.panX;
    const y = state.panY;

    // 1) 底色层（仅图像矩形区域）
    ctx.fillStyle = state.bgHex;
    ctx.fillRect(x, y, w, h);

    // 2) 图像：原图或修复后
    const srcCanvas = state.viewMode === "before" || state.holdCompare ? im.imgCanvas : im.result;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, x, y, w, h);

    // 3) 透明区轻提示（覆盖层在加载时已缓存，直接缩放绘制）
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.drawImage(im.transparentCanvas, x, y, w, h);
    ctx.restore();

    // 4) 低可信像素红斜纹
    if (state.showLowConf && state.viewMode === "after" && !state.holdCompare) {
      drawFlagOverlay(im, x, y, w, h);
    }

    // 5) 保护区蓝叠加
    if (state.showMask) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(im.maskCanvas, x, y, w, h);
      ctx.restore();
    }

    // 6) 图像边框
    ctx.strokeStyle = "#555b66";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

    // 7) 取点标记（屏幕空间，固定尺寸）
    if (state.inspector) {
      const px = x + state.inspector.x * state.zoom;
      const py = y + state.inspector.y * state.zoom;
      ctx.strokeStyle = "#ffd23d";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px, py, Math.max(1, state.zoom), Math.max(1, state.zoom));
      ctx.beginPath();
      ctx.arc(px + Math.max(1, state.zoom) / 2, py + Math.max(1, state.zoom) / 2, Math.max(5, state.zoom * 0.8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawFlagOverlay(im, x, y, w, h) {
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    const g = c.getContext("2d");
    const img = g.createImageData(im.width, im.height);
    for (let p = 0; p < im.flags.length; p++) {
      if (im.flags[p]) {
        img.data[p * 4] = 229;
        img.data[p * 4 + 1] = 120;
        img.data[p * 4 + 2] = 108;
        img.data[p * 4 + 3] = 150;
      }
    }
    g.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.drawImage(c, x, y, w, h);
    ctx.restore();
  }

  function renderAll() {
    render();
    renderStrip();
    renderStats();
    renderInspector();
  }

  // ---------- 底部多底色预览条 ----------
  function renderStrip() {
    const strip = $("strip");
    const im = current();
    strip.innerHTML = "";
    if (!im) return;
    const size = 118;
    BG_SWATCHES.forEach((sw) => {
      const cell = document.createElement("div");
      cell.className = "cell" + (sw.hex === state.bgHex ? " sel" : "");
      const cv = document.createElement("canvas");
      cv.width = cv.height = size;
      const g = cv.getContext("2d");
      g.fillStyle = sw.hex;
      g.fillRect(0, 0, size, size);
      const scale = Math.min(size / im.width, size / im.height);
      const dw = im.width * scale,
        dh = im.height * scale;
      const src = state.viewMode === "before" || state.holdCompare ? im.imgCanvas : im.result;
      g.imageSmoothingEnabled = false;
      g.drawImage(src, (size - dw) / 2, (size - dh) / 2, dw, dh);
      cv.title = "点击把主画布底色切换为 " + sw.name;
      cv.addEventListener("click", () => {
        state.bgHex = sw.hex;
        renderAll();
        persist();
      });
      cell.appendChild(cv);
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = sw.name;
      cell.appendChild(cap);
      const mode = document.createElement("div");
      mode.className = "mode";
      mode.textContent = state.viewMode === "before" || state.holdCompare ? "原图" : "修复后";
      cell.appendChild(mode);
      strip.appendChild(cell);
    });
  }

  // ---------- 统计 ----------
  function renderStats() {
    const im = current();
    const t = $("statsTable");
    if (!im) {
      t.innerHTML = "";
      return;
    }
    const s = im.stats;
    const rows = [
      ["图像尺寸", `${im.width} × ${im.height}`],
      ["全不透明像素", s.opaque],
      ["全透明像素", s.fullyTransparent],
      ["半透明像素", s.semiTransparent],
      ["实际处理", s.processed],
      ["保护区跳过", s.protectedPixels],
      ["低可信像素", s.lowConfidence],
      ["└ 邻色填充", s.lowAlphaFilled],
      ["└ 保留/无参考", s.lowAlphaKept],
      ["逆推越界裁剪", s.clipped],
    ];
    t.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  }

  // ---------- 像素检查器 ----------
  function renderInspector() {
    const im = current();
    const box = $("inspectorBody");
    const empty = $("inspectorEmpty");
    if (!im || !state.inspector) {
      box.style.display = "none";
      empty.style.display = "block";
      return;
    }
    const { x, y } = state.inspector;
    if (x < 0 || y < 0 || x >= im.width || y >= im.height) {
      box.style.display = "none";
      empty.style.display = "block";
      empty.textContent = "该点在图像范围外。";
      return;
    }
    empty.style.display = "none";
    box.style.display = "block";

    const p = y * im.width + x;
    const i = p * 4;
    const src = im.srcBytes;
    const fixed = im.resultBytes;
    const mask = im.mask[p];
    const a = src[i + 3];

    const swatch = (rgb) =>
      `<span class="swatchline"><span class="colorswatch" style="background:rgb(${rgb[0]},${rgb[1]},${rgb[2]})"></span>rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})</span>`;

    const rows = [
      ["坐标", `(${x}, ${y})`],
      ["原图 RGBA", swatch([src[i], src[i + 1], src[i + 2]]) + ` α=${a} (${(a / 255 * 100).toFixed(1)}%)`],
      ["校正后 RGB", swatch([fixed[i], fixed[i + 1], fixed[i + 2]])],
      ["校正后 α", `${fixed[i + 3]}（与原图一致）`],
      ["RGB 变化 Δ", `(${fixed[i] - src[i]}, ${fixed[i + 1] - src[i + 1]}, ${fixed[i + 2] - src[i + 2]})`],
      ["是否保护区", mask === 255 ? "是（原样保留）" : "否"],
    ];
    $("inspectorTable").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

    // 标签与说明
    const tags = [];
    const note = [];
    if (a === 0) {
      tags.push(`<span class="tag ok">全透明 · 保持透明</span>`);
      note.push("该像素完全透明，工具不改动它。");
    } else if (a === 255) {
      tags.push(`<span class="tag ok">不透明 · 一律保留</span>`);
      note.push("完全不透明像素不参与去底色，纯白高光等真实细节不会被误伤。");
    } else {
      const f = im.flags[p];
      if (mask === 255) tags.push(`<span class="tag prot">保护区</span>`);
      if (f & P.FLAG_LOW_ALPHA) {
        tags.push(`<span class="tag low">低 α · 颜色不可可靠恢复</span>`);
        note.push(
          `α=${a} 过小：逆推要除以 α/255，8bit 量化误差被放大约 ${Math.round(127.5 / a)} 倍，真实颜色已无法从数据中恢复。` +
            (im.settings.lowAlphaMode === "neighbor"
              ? "已改用周围高可信像素的颜色填充，alpha 保持不变。"
              : "当前设置为保留观测色，未强行逆推（避免反色）。")
        );
      }
      if (f & P.FLAG_CLIPPED) {
        tags.push(`<span class="tag clip">逆推越界 · 已裁剪</span>`);
        note.push("按所选底色逆推出的颜色超出 0–255，说明底色假设可能不适用该像素；结果已裁剪，不会出现反色。");
      }
      if (f & P.FLAG_NO_REFERENCE) {
        tags.push(`<span class="tag low">无高可信邻居</span>`);
        note.push("周围没有可参考的高可信像素，只能保留观测色。");
      }
      if (!f && mask !== 255) {
        tags.push(`<span class="tag ok">高可信逆推</span>`);
        note.push("α 足够大，逆推结果在合法范围内，属于可靠校正。");
      }
    }
    $("inspectorTags").innerHTML = tags.join("");
    $("inspectorNote").innerHTML = note.join("<br/>");
  }

  // ---------- 画保护区（直接操作字节掩码，再同步显示层）----------
  function paintMaskAt(ix, iy, erase) {
    const im = current();
    if (!im) return;
    const r = state.brush / 2;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(ix - r));
    const x1 = Math.min(im.width - 1, Math.ceil(ix + r));
    const y0 = Math.max(0, Math.floor(iy - r));
    const y1 = Math.min(im.height - 1, Math.ceil(iy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - ix;
        const dy = y + 0.5 - iy;
        if (dx * dx + dy * dy <= r2) im.mask[y * im.width + x] = erase ? 0 : 255;
      }
    }
    syncMaskCanvas(im);
  }

  // ---------- 指针交互 ----------
  let drawing = false;
  let panning = false;
  let panStart = null;

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const { ix, iy, sx, sy } = eventToImagePixel(e);
    if (e.button === 1 || state.spaceDown) {
      panning = true;
      panStart = { x: sx, y: sy, px: state.panX, py: state.panY };
      return;
    }
    if (e.button !== 0) return;
    if (state.tool === "inspect") {
      state.inspector = { x: ix, y: iy };
      render();
      renderInspector();
    } else {
      drawing = true;
      paintMaskAt(ix, iy, state.tool === "erase");
      scheduleReprocess();
      render();
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const { ix, iy, sx, sy } = eventToImagePixel(e);
    if (panning && panStart) {
      state.panX = panStart.px + (sx - panStart.x);
      state.panY = panStart.py + (sy - panStart.y);
      render();
      return;
    }
    if (drawing) {
      paintMaskAt(ix, iy, state.tool === "erase");
      render();
      scheduleReprocess();
    }
  });

  const endPointer = () => {
    drawing = false;
    panning = false;
    panStart = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { sx, sy } = eventToImagePixel(e);
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      setZoom(state.zoom * factor, sx, sy);
    },
    { passive: false }
  );

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------- 拖放加载 ----------
  ["dragenter", "dragover"].forEach((ev) =>
    view.addEventListener(ev, (e) => {
      e.preventDefault();
      view.classList.add("dropping");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    view.addEventListener(ev, (e) => {
      e.preventDefault();
      view.classList.remove("dropping");
    })
  );
  view.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
  });

  // ---------- 图像列表 ----------
  function renderImageList() {
    const ul = $("imageList");
    ul.innerHTML = "";
    state.images.forEach((im) => {
      const li = document.createElement("li");
      li.className = im.id === state.currentId ? "sel" : "";
      const cv = document.createElement("canvas");
      cv.width = cv.height = 34;
      const g = cv.getContext("2d");
      g.fillStyle = "#33373f";
      g.fillRect(0, 0, 34, 34);
      const sc = Math.min(34 / im.width, 34 / im.height);
      g.drawImage(im.imgCanvas, (34 - im.width * sc) / 2, (34 - im.height * sc) / 2, im.width * sc, im.height * sc);
      const meta = document.createElement("div");
      meta.className = "meta";
      const badge = im.lossless ? "" : ` <span style="color:var(--warn)" title="非 8-bit RGBA，浏览器解码，导出不保证逐字节无损">⚠非无损</span>`;
      meta.innerHTML = `<div class="name" title="${im.name}">${im.name}</div><div class="dim">${im.width}×${im.height}${badge}</div>`;
      li.appendChild(cv);
      li.appendChild(meta);
      li.addEventListener("click", () => selectImage(im.id));
      ul.appendChild(li);
    });
  }

  function selectImage(id) {
    flushReprocess(); // 切图前结算挂起的重处理，防止设置落到错误的图像上
    state.currentId = id;
    const im = current();
    state.inspector = null;
    syncControlsFromSettings();
    renderImageList();
    fitZoom();
    renderAll();
    updateZoomLabel();
  }

  function updateExportButtons() {
    const has = state.images.length > 0;
    $("btnExportOne").disabled = !has;
    $("btnExportAll").disabled = !has;
  }

  // ---------- 设置控件 ----------
  function syncControlsFromSettings() {
    const im = current();
    const s = im ? im.settings : P.defaultSettings();
    $("matColorPicker").value = s.matColor;
    $("matColorHex").value = s.matColor;
    $("strength").value = s.strength;
    $("strengthVal").textContent = Math.round(s.strength * 100) + "%";
    $("lowThr").value = s.lowAlphaThreshold;
    $("lowThrVal").textContent = s.lowAlphaThreshold;
    document.querySelectorAll("#lowModeSeg button").forEach((b) => {
      b.classList.toggle("sel", b.dataset.mode === s.lowAlphaMode);
    });
  }

  function updateSetting(key, value) {
    const im = current();
    if (!im) return;
    im.settings[key] = value;
    scheduleReprocess(im);
  }

  $("matColorPicker").addEventListener("input", (e) => {
    $("matColorHex").value = e.target.value;
    updateSetting("matColor", e.target.value);
  });
  $("matColorHex").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      $("matColorPicker").value = v;
      updateSetting("matColor", v.toLowerCase());
    } else {
      syncControlsFromSettings();
    }
  });
  $("strength").addEventListener("input", (e) => {
    $("strengthVal").textContent = Math.round(e.target.value * 100) + "%";
    updateSetting("strength", parseFloat(e.target.value));
  });
  $("lowThr").addEventListener("input", (e) => {
    $("lowThrVal").textContent = e.target.value;
    updateSetting("lowAlphaThreshold", parseInt(e.target.value, 10));
  });
  document.querySelectorAll("#lowModeSeg button").forEach((b) => {
    b.addEventListener("click", () => {
      updateSetting("lowAlphaMode", b.dataset.mode);
      document.querySelectorAll("#lowModeSeg button").forEach((x) =>
        x.classList.toggle("sel", x === b)
      );
    });
  });

  // 底色预设
  const matPresets = $("matPresets");
  MAT_PRESETS.forEach((hex) => {
    const d = document.createElement("div");
    d.className = "swatch";
    d.style.background = hex;
    d.title = hex;
    d.addEventListener("click", () => {
      $("matColorPicker").value = hex;
      $("matColorHex").value = hex;
      updateSetting("matColor", hex);
    });
    matPresets.appendChild(d);
  });

  // 工具切换
  function setTool(tool) {
    state.tool = tool;
    $("toolInspect").classList.toggle("active", tool === "inspect");
    $("toolProtect").classList.toggle("active", tool === "protect");
    $("toolErase").classList.toggle("active", tool === "erase");
    canvas.style.cursor = tool === "inspect" ? "crosshair" : "cell";
  }
  $("toolInspect").addEventListener("click", () => setTool("inspect"));
  $("toolProtect").addEventListener("click", () => setTool("protect"));
  $("toolErase").addEventListener("click", () => setTool("erase"));
  $("brush").addEventListener("input", (e) => {
    state.brush = parseInt(e.target.value, 10);
    $("brushVal").textContent = e.target.value;
  });
  $("btnClearMask").addEventListener("click", () => {
    const im = current();
    if (!im) return;
    im.mask.fill(0);
    syncMaskCanvas(im);
    scheduleReprocess();
    render();
  });
  $("btnProtectAll").addEventListener("click", () => {
    const im = current();
    if (!im) return;
    im.mask.fill(255);
    syncMaskCanvas(im);
    scheduleReprocess();
    render();
  });

  // 视图模式
  document.querySelectorAll("#viewModeSeg button").forEach((b) => {
    b.addEventListener("click", () => {
      state.viewMode = b.dataset.mode;
      document.querySelectorAll("#viewModeSeg button").forEach((x) => x.classList.toggle("sel", x === b));
      renderAll();
    });
  });
  const badge = $("compareBadge");
  function startHold() {
    if (!current()) return;
    state.holdCompare = true;
    badge.style.display = "block";
    renderAll();
  }
  function endHold() {
    state.holdCompare = false;
    badge.style.display = "none";
    renderAll();
  }
  $("btnHoldCompare").addEventListener("pointerdown", startHold);
  $("btnHoldCompare").addEventListener("pointerup", endHold);
  $("btnHoldCompare").addEventListener("pointerleave", endHold);

  // 缩放按钮
  $("zoomIn").addEventListener("click", () => {
    const r = view.getBoundingClientRect();
    setZoom(state.zoom * 1.25, r.width / 2, r.height / 2);
  });
  $("zoomOut").addEventListener("click", () => {
    const r = view.getBoundingClientRect();
    setZoom(state.zoom / 1.25, r.width / 2, r.height / 2);
  });
  $("zoomFit").addEventListener("click", () => {
    fitZoom();
    render();
    updateZoomLabel();
  });
  $("zoom100").addEventListener("click", () => {
    const r = view.getBoundingClientRect();
    setZoom(1, r.width / 2, r.height / 2);
  });

  $("showLowConf").addEventListener("change", (e) => {
    state.showLowConf = e.target.checked;
    render();
    persist();
  });
  $("showMask").addEventListener("change", (e) => {
    state.showMask = e.target.checked;
    render();
    persist();
  });

  // 复用 / 复位
  $("btnApplyAll").addEventListener("click", () => {
    flushReprocess(); // 确保当前图像尚未防抖落地的设置已写入
    const cur = current();
    if (!cur) return;
    const s = cloneSettings(cur.settings);
    state.images.forEach((im) => (im.settings = cloneSettings(s)));
    state.images.forEach(reprocess);
    renderAll();
  });
  $("btnResetCur").addEventListener("click", () => {
    const im = current();
    if (!im) return;
    im.settings = P.defaultSettings();
    im.mask.fill(0);
    syncMaskCanvas(im);
    syncControlsFromSettings();
    reprocess(im);
    renderAll();
  });
  $("btnResetAll").addEventListener("click", () => {
    state.images.forEach((im) => {
      im.settings = P.defaultSettings();
      im.mask.fill(0);
      syncMaskCanvas(im);
    });
    state.images.forEach(reprocess);
    syncControlsFromSettings();
    renderAll();
  });

  // ---------- 加载按钮 ----------
  $("btnLoad").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => {
    loadFiles(e.target.files);
    e.target.value = "";
  });

  // ---------- 导出 ----------
  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function baseName(name) {
    return name.replace(/\.png$/i, "");
  }

  function buildNote(im) {
    const s = im.settings;
    const st = im.stats;
    return [
      "边缘去底色处理说明",
      "==================",
      `源文件：${im.name}`,
      `图像尺寸：${im.width} × ${im.height}`,
      `解码方式：${im.lossless ? "字节级 PNG 直解（未处理像素可逐字节保留）" : "浏览器回退解码（非 8-bit RGBA，不保证逐字节无损）"}`,
      `导出时间：${new Date().toISOString()}`,
      "",
      "处理参数",
      "--------",
      `假定原底色：${s.matColor}`,
      `边缘强度：${Math.round(s.strength * 100)}%`,
      `低透明阈值（alpha）：${s.lowAlphaThreshold}`,
      `低透明像素策略：${s.lowAlphaMode === "neighbor" ? "邻色填充" : "保留观测色"}`,
      "",
      "像素统计",
      "--------",
      `全不透明（未处理，含真实白色高光）：${st.opaque}`,
      `全透明（保持透明）：${st.fullyTransparent}`,
      `半透明：${st.semiTransparent}`,
      `实际参与逆推校正：${st.processed}`,
      `保护区跳过：${st.protectedPixels}`,
      `低可信像素：${st.lowConfidence}（邻色填充 ${st.lowAlphaFilled} / 保留或无参考 ${st.lowAlphaKept}）`,
      `逆推越界裁剪（未产生反色）：${st.clipped}`,
      "",
      "算法与限制",
      "--------",
      "逆推公式：真实色 = (观测色 - (1-alpha)×底色) / alpha，alpha 通道保持不变。",
      "alpha 接近 0 时真实颜色无法从 8bit 数据可靠恢复，本工具不强行逆推，",
      "改用高可信邻居颜色填充或保留观测色，相关像素已在界面标记，请重点复核。",
      "原始文件未被修改；本 PNG 为另存的新文件。",
      "",
    ].join("\n");
  }

  // 用字节级 PNG 编码器导出，避免 canvas.toBlob 的预乘 alpha 舍入
  async function exportOne(im) {
    const blob = await window.PngEncoder.encodePng(im.width, im.height, im.resultBytes);
    downloadBlob(blob, `${baseName(im.name)}_unmixed.png`);
    const noteBlob = new Blob([buildNote(im)], { type: "text/plain;charset=utf-8" });
    await new Promise((r) => setTimeout(r, 200));
    downloadBlob(noteBlob, `${baseName(im.name)}_unmixed_note.txt`);
    await new Promise((r) => setTimeout(r, 250));
  }

  $("btnExportOne").addEventListener("click", () => {
    flushReprocess();
    const im = current();
    if (im) exportOne(im);
  });
  $("btnExportAll").addEventListener("click", async () => {
    flushReprocess();
    for (const im of state.images) {
      await exportOne(im);
    }
  });

  // ---------- 键盘快捷键 ----------
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") {
      e.preventDefault();
      state.spaceDown = true;
      canvas.style.cursor = "grabbing";
    } else if (e.key === "b" || e.key === "B") {
      startHold();
    } else if (e.key === "p" || e.key === "P") {
      setTool("protect");
    } else if (e.key === "e" || e.key === "E") {
      setTool("erase");
    } else if (e.key === "i" || e.key === "I") {
      setTool("inspect");
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      state.spaceDown = false;
      canvas.style.cursor = state.tool === "inspect" ? "crosshair" : "cell";
    } else if (e.key === "b" || e.key === "B") {
      endHold();
    }
  });

  // ---------- 启动 ----------
  function init() {
    const persisted = loadPersisted();
    if (persisted) {
      state.bgHex = persisted.bgHex || state.bgHex;
      state.showLowConf = persisted.showLowConf !== false;
      state.showMask = persisted.showMask !== false;
      $("showLowConf").checked = state.showLowConf;
      $("showMask").checked = state.showMask;
    }
    syncControlsFromSettings();
    setTool("inspect");
    resizeCanvas();
    updateZoomLabel();
    renderAll();
  }
  init();
})();
