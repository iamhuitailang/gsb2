/* global CubeCore, Samples */
'use strict';
/*
 * app.js — 界面、渲染与交互
 *
 * 数据模型：
 *   state.faces[id] = { tex:{data,width,height}, rot, flipH, name, fileName } 或 null
 *
 * 采样与几何全部交给 CubeCore（纯函数），本文件只负责 DOM、Canvas 与事件。
 */
(function () {
  const C = CubeCore;
  const $ = (s) => document.querySelector(s);

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------
  const KIND = {
    aligned: { color: '#4fd08a', text: '已吻合' },
    reversed: { color: '#ffb648', text: '颜色顺序反了' },
    turnable: { color: '#ffb648', text: '只需转向' },
    paired: { color: '#b592ff', text: '两面配合' },
    content: { color: '#ff6b78', text: '颜色接不上' },
    missing: { color: '#55627a', text: '缺图' },
  };
  const MEMORY_KEY = 'cube-env-checker/orientation-memory/v1';
  const EQUIRECT_W = 2048;

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const state = {
    faces: {},
    view: Object.assign({}, C.DEFAULT_VIEW),
    tab: 'cube',
    selectedFace: 4,
    probe: null, // { faceId, u, v, px, py, source:'cube'|'net'|'equirect', lon, lat }
    activeSeam: null,
    seamResults: null,
    diag: null,
    showSeams: true,
    showLabels: true,
    showPoles: true,
    dragging: false,
    dragMoved: false,
    importedEquirect: null, // { tex, name }
    eqCache: null,
    eqCacheKey: '',
    netInfo: null,
    cubeInfo: null,
    helpOpen: false,
  };
  for (const f of C.FACES) state.faces[f.id] = null;

  const thumbCache = new Map();
  let toastEl = null;
  let toastTimer = 0;
  let rafPending = false;
  let paintPending = false;
  let heavyBusy = false;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const el = {
    canvas: $('#view'),
    wrap: $('#canvas-wrap'),
    statusbar: $('#statusbar'),
    diagList: $('#diag-list'),
    diagPill: $('#diag-pill'),
    faceList: $('#face-list'),
    seamList: $('#seam-list'),
    seamDetail: $('#seam-detail'),
    probeCanvas: $('#probe-canvas'),
    probeInfo: $('#probe-info'),
    badge: $('#view-badge'),
    loading: $('#loading'),
    fileFaces: $('#file-faces'),
    fileEquirect: $('#file-equirect'),
    fileProject: $('#file-project'),
    help: $('#help-dialog'),
  };
  const ctx = el.canvas.getContext('2d');
  const probeCtx = el.probeCanvas.getContext('2d');
  const tmp = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d');

  // ---------------------------------------------------------------------------
  // 通用工具
  // ---------------------------------------------------------------------------
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast' + (isError ? ' error' : '');
    }, 3600);
  }
  function setBusy(on) {
    heavyBusy = on;
    el.loading.hidden = !on;
  }
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }
  // 只重绘视图（拖动视角时用，避免每帧重建面卡/接缝）
  function requestPaint() {
    if (paintPending) return;
    paintPending = true;
    requestAnimationFrame(() => {
      paintPending = false;
      paintView();
    });
  }
  function debounce(fn, ms) {
    let t = 0;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  }
  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function fmt(n, d) {
    return Number(n).toFixed(d == null ? 1 : d);
  }
  function faceName(id) {
    return '#' + id + ' ' + C.FACE_BY_ID[id].cn + '面';
  }
  function faceFull(id) {
    return faceName(id) + ' (' + C.FACE_BY_ID[id].name + ')';
  }

  // ---------------------------------------------------------------------------
  // 纹理 / 图像
  // ---------------------------------------------------------------------------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function texFromImageData(img) {
    return {
      data: img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data),
      width: img.width,
      height: img.height,
    };
  }

  async function texFromBlob(blob) {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = makeCanvas(bmp.width, bmp.height);
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const img = cx.getImageData(0, 0, c.width, c.height);
    try { bmp.close(); } catch (e) { /* ignore */ }
    return texFromImageData(img);
  }

  function texFromDataURL(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const c = makeCanvas(im.naturalWidth, im.naturalHeight);
        const cx = c.getContext('2d');
        cx.drawImage(im, 0, 0);
        resolve(texFromImageData(cx.getImageData(0, 0, c.width, c.height)));
      };
      im.onerror = () => reject(new Error('图像解码失败'));
      im.src = url;
    });
  }

  function texToCanvas(tex, w, h) {
    const c = makeCanvas(w || tex.width, h || tex.height);
    const cx = c.getContext('2d');
    const id = new ImageData(new Uint8ClampedArray(tex.data), tex.width, tex.height);
    const t = makeCanvas(tex.width, tex.height);
    t.getContext('2d').putImageData(id, 0, 0);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(t, 0, 0, c.width, c.height);
    return c;
  }

  function texToDataURL(tex) {
    return texToCanvas(tex).toDataURL('image/png');
  }

  // 把某张面按 rot/flip 摆正后烘焙成方形纹理（结果可直接以 rot=0 使用）
  function bakeFace(tex, rot, flipH, outW, outH) {
    const W = outW || tex.width;
    const H = outH || tex.height;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const v = 1 - (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const p = C.uvToSourcePixel(rot, flipH, u, v, tex.width, tex.height);
        const c = C.sampleTexture(tex, p.su, p.sv, false, true) || [0, 0, 0, 255];
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    }
    return { data, width: W, height: H };
  }

  // ---------------------------------------------------------------------------
  // 数据视图（供 CubeCore 使用）
  // ---------------------------------------------------------------------------
  function coreFaces() {
    const out = {};
    for (const f of C.FACES) {
      const s = state.faces[f.id];
      if (s && s.tex) out[f.id] = { tex: s.tex, rot: s.rot, flipH: s.flipH, label: s.name };
    }
    return out;
  }
  function anyFace() {
    return C.FACES.some((f) => state.faces[f.id]);
  }
  function configKey() {
    return C.FACES.map((f) => {
      const s = state.faces[f.id];
      return s ? s.tex.width + 'x' + s.tex.height + ':' + s.rot + ':' + (s.flipH ? 1 : 0) + ':' + (s.name || '') : '-';
    }).join('|');
  }

  // ---------------------------------------------------------------------------
  // 朝向记忆（同名同尺寸图片自动套用上次的旋转）
  // ---------------------------------------------------------------------------
  function readMemory() {
    try {
      return JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function writeMemory(mem) {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
    } catch (e) {
      /* quota / 隐私模式，忽略 */
    }
  }
  function memoryKeyOf(name, tex) {
    return (name || '') + '|' + tex.width + 'x' + tex.height;
  }
  function rememberOrientation(name, tex, rot, flipH) {
    const mem = readMemory();
    mem[memoryKeyOf(name, tex)] = { rot, flipH, savedAt: new Date().toISOString() };
    writeMemory(mem);
  }
  function lookupOrientation(name, tex) {
    const mem = readMemory();
    return mem[memoryKeyOf(name, tex)] || null;
  }

  // ---------------------------------------------------------------------------
  // 载入面
  // ---------------------------------------------------------------------------
  function setFace(id, tex, name, cfg) {
    const mem = lookupOrientation(name, tex);
    const use = cfg || mem || { rot: 0, flipH: false };
    state.faces[id] = {
      tex,
      rot: ((use.rot || 0) % 4 + 4) % 4,
      flipH: !!use.flipH,
      name: name || 'face-' + id + '.png',
      fileName: name || 'face-' + id + '.png',
    };
    markDirty();
  }

  function markDirty() {
    state.eqCache = null;
    state.eqCacheKey = '';
    state.seamResults = null;
    state.diag = null;
    state.netInfo = null;
    requestRender();
  }

  async function assignFiles(files, forcedFaceId) {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp)$/i.test(f.name));
    if (!list.length) {
      toast('没有可用的图片文件', true);
      return;
    }
    const entries = [];
    for (const file of list) {
      try {
        const tex = await texFromBlob(file);
        entries.push({ file, tex });
      } catch (e) {
        toast('读取失败：' + file.name, true);
      }
    }
    if (!entries.length) return;

    if (forcedFaceId != null && entries.length === 1) {
      setFace(forcedFaceId, entries[0].tex, entries[0].file.name);
      state.selectedFace = forcedFaceId;
      toast('已把 ' + entries[0].file.name + ' 放到 ' + faceName(forcedFaceId));
      render();
      return;
    }

    // 一张 → 当前选中面；多张 → 按文件名猜
    if (entries.length === 1) {
      setFace(state.selectedFace, entries[0].tex, entries[0].file.name);
      toast('已把 ' + entries[0].file.name + ' 放到 ' + faceName(state.selectedFace));
      render();
      return;
    }

    let assigned = 0;
    const unmatched = [];
    for (const e of entries) {
      const id = C.guessFaceFromName(e.file.name);
      if (id != null) {
        setFace(id, e.tex, e.file.name);
        assigned++;
      } else {
        unmatched.push(e);
      }
    }
    // 没猜出来的，填到还空着的面
    for (const e of unmatched) {
      const empty = C.FACES.find((f) => !state.faces[f.id]);
      if (!empty) break;
      setFace(empty.id, e.tex, e.file.name);
      assigned++;
    }
    render();
    if (assigned) toast('已载入 ' + assigned + ' 张面图' + (unmatched.length ? '（有 ' + unmatched.length + ' 张按文件名没认出来，已补到空位）' : ''));
    else toast('没有可放置的图片', true);
  }

  async function loadSampleFaces() {
    setBusy(true);
    try {
      let manifest = null;
      try {
        const res = await fetch('/samples/manifest.json', { cache: 'no-store' });
        if (res.ok) manifest = await res.json();
      } catch (e) {
        manifest = null;
      }
      if (manifest && manifest.faces) {
        for (const f of C.FACES) {
          const info = manifest.faces[f.id];
          if (!info) continue;
          const res = await fetch('/samples/' + info.file, { cache: 'no-store' });
          if (!res.ok) throw new Error('取样例失败: ' + info.file);
          const blob = await res.blob();
          const tex = await texFromBlob(blob);
          state.faces[f.id] = {
            tex,
            rot: info.rot || 0,
            flipH: !!info.flipH,
            name: info.file,
            fileName: info.file,
            builtin: true,
          };
        }
      } else {
        // 没有预生成文件就在浏览器里现生成
        const sample = Samples.makeSampleFaces({ size: 512, equirectWidth: 1024 });
        for (const f of C.FACES) {
          const cfg = sample.configs[f.id];
          state.faces[f.id] = {
            tex: sample.faces[f.id].tex,
            rot: cfg.rot,
            flipH: cfg.flipH,
            name: 'sample-' + f.id + '-' + C.FACE_BY_ID[f.id].name.toLowerCase() + '.png',
            fileName: 'sample-' + f.id + '-' + C.FACE_BY_ID[f.id].name.toLowerCase() + '.png',
            builtin: true,
          };
        }
      }
      state.selectedFace = 0;
      state.probe = null;
      markDirty();
      render();
      const wrong = state.faces[0] && state.faces[0].rot !== 0;
      toast(
        wrong
          ? '样例已载入：0 号右面被故意转了 90°，看下方接缝面板的“只需转向”。'
          : '样例已载入。'
      );
    } catch (err) {
      toast('载入内置样例失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 诊断
  // ---------------------------------------------------------------------------
  function computeDiagnostics() {
    const faces = coreFaces();
    const d = C.diagnose(faces);
    const present = Object.keys(faces).length;
    const turns = state.seamResults ? state.seamResults.filter((r) => r.kind === 'turnable' || r.kind === 'reversed' || r.kind === 'paired') : [];
    const bad = state.seamResults ? state.seamResults.filter((r) => r.kind === 'content') : [];
    d.summary = {
      present,
      total: 6,
      fixable: turns.length,
      content: bad.length,
    };
    return d;
  }

  function renderDiagnostics() {
    const d = computeDiagnostics();
    state.diag = d;
    el.diagPill.className = 'pill ' + (d.ok ? 'ok' : 'warn');
    el.diagPill.textContent = d.ok ? '六面齐全' : d.present + '/6 就绪';

    const frag = document.createDocumentFragment();
    if (!d.messages.length) {
      const div = document.createElement('div');
      div.className = 'diag-msg ok';
      div.textContent = '六面图齐全且尺寸一致。若接缝有提示，按“只需转向”修正即可。';
      frag.appendChild(div);
    }
    for (const m of d.messages) {
      const div = document.createElement('div');
      div.className = 'diag-msg ' + (m.severity || 'warn');
      div.appendChild(document.createTextNode(m.text));
      if (m.faces && m.faces.length) {
        const tags = document.createElement('div');
        tags.className = 'diag-faces';
        for (const id of m.faces) {
          const b = document.createElement('button');
          b.className = 'face-tag';
          b.textContent = '#' + id + ' ' + C.FACE_BY_ID[id].short;
          b.title = '选中 ' + faceFull(id);
          b.onclick = () => selectFace(id);
          tags.appendChild(b);
        }
        div.appendChild(tags);
      }
      frag.appendChild(div);
    }

    // 接缝层面的概览
    if (state.seamResults && d.summary.present === 6) {
      const s = d.summary;
      const div = document.createElement('div');
      div.className = 'diag-msg ' + (s.fixable || s.content ? 'warn' : 'ok');
      if (!s.fixable && !s.content) {
        div.textContent = '12 条棱全部色带吻合，方向正确。';
      } else {
        div.textContent =
          '接缝检查：' + s.fixable + ' 条只需调整朝向即可吻合' +
          (s.content ? '，' + s.content + ' 条颜色确实接不上（非转向问题）' : '') + '。';
        const btn = document.createElement('button');
        btn.className = 'ghost small';
        btn.textContent = '自动修正朝向';
        btn.onclick = autoFixOrientations;
        div.appendChild(btn);
      }
      frag.appendChild(div);
    }
    el.diagList.replaceChildren(frag);
  }

  // ---------------------------------------------------------------------------
  // 面列表
  // ---------------------------------------------------------------------------
  function orientedThumb(id, size) {
    const s = state.faces[id];
    if (!s) return null;
    if (!s.tex._id) s.tex._id = 'tex' + Math.random().toString(36).slice(2);
    const key = id + ':' + s.tex._id + ':' + s.rot + ':' + (s.flipH ? 1 : 0) + ':' + size;
    const hit = thumbCache.get(key);
    if (hit) return hit;
    const baked = bakeFace(s.tex, s.rot, s.flipH, size, size);
    const c = makeCanvas(size, size);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(baked.data), size, size), 0, 0);
    if (thumbCache.size > 80) thumbCache.clear();
    thumbCache.set(key, c);
    return c;
  }

  function renderFaceCards() {
    const frag = document.createDocumentFragment();
    for (const f of C.FACES) {
      const s = state.faces[f.id];
      const card = document.createElement('div');
      card.className = 'face-card' + (state.selectedFace === f.id ? ' selected' : '') + (s ? '' : ' missing');
      card.dataset.face = f.id;

      const thumb = document.createElement('div');
      thumb.className = 'face-thumb';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '#' + f.id + ' ' + f.cn;
      thumb.appendChild(tag);

      if (s) {
        const c = orientedThumb(f.id, 160);
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.objectFit = 'contain';
        c.className = 'thumb-canvas';
        thumb.appendChild(c);
        const dims = document.createElement('span');
        dims.className = 'dims';
        dims.textContent = s.tex.width + '×' + s.tex.height;
        thumb.appendChild(dims);
        const diag = state.diag;
        if (diag && diag.nonSquare.some((x) => x.id === f.id)) {
          const dot = document.createElement('span');
          dot.className = 'warn-dot';
          dot.title = '不是正方形';
          thumb.appendChild(dot);
        }
        if (state.probe && state.probe.faceId === f.id) {
          const mark = document.createElement('span');
          mark.className = 'warn-dot';
          mark.style.background = '#6fd0e0';
          mark.style.boxShadow = '0 0 0 3px rgba(111,208,224,.18)';
          mark.title = '当前取样点所在面';
          thumb.appendChild(mark);
        }
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty-face';
        empty.innerHTML = '缺这张<br><small>点击选择图片</small>';
        thumb.appendChild(empty);
      }
      thumb.title = '点击将该面设为当前面；再点“换图”替换图片';
      thumb.onclick = () => selectFace(f.id);
      card.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'face-meta';
      const nm = document.createElement('div');
      nm.className = 'face-name';
      nm.textContent = s ? s.name : '— 未选择 —';
      nm.title = s ? s.name : '';
      meta.appendChild(nm);

      if (s) {
        const rot = document.createElement('div');
        rot.className = 'face-rot';
        const ccw = document.createElement('button');
        ccw.textContent = '⟲';
        ccw.title = '逆时针 90°';
        ccw.onclick = (ev) => { ev.stopPropagation(); rotateFace(f.id, -1); };
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = C.orientationLabel(s.rot, s.flipH);
        val.title = '当前朝向';
        const cw = document.createElement('button');
        cw.textContent = '⟳';
        cw.title = '顺时针 90°';
        cw.onclick = (ev) => { ev.stopPropagation(); rotateFace(f.id, 1); };
        const fl = document.createElement('button');
        fl.textContent = '⇋';
        fl.title = '水平镜像';
        fl.className = s.flipH ? 'primary' : '';
        fl.onclick = (ev) => { ev.stopPropagation(); flipFace(f.id); };
        rot.append(ccw, val, cw, fl);
        meta.appendChild(rot);
        const fname = document.createElement('div');
        fname.className = 'face-file';
        fname.textContent = s.fileName;
        fname.title = s.fileName;
        meta.appendChild(fname);
      }

      const repick = document.createElement('button');
      repick.className = 'ghost small';
      repick.textContent = s ? '换图' : '选择图片';
      repick.onclick = (ev) => {
        ev.stopPropagation();
        state.selectedFace = f.id;
        el.fileFaces.dataset.target = String(f.id);
        el.fileFaces.click();
      };
      meta.appendChild(repick);
      card.appendChild(meta);
      frag.appendChild(card);
    }
    el.faceList.replaceChildren(frag);
  }

  function selectFace(id) {
    state.selectedFace = id;
    renderFaceCards();
    const s = state.faces[id];
    if (s) {
      // 视角转向该面，便于直接看
      const f = C.FACE_BY_ID[id];
      state.view.yaw = Math.atan2(f.n[0], f.n[2]);
      state.view.pitch = Math.asin(clamp(f.n[1], -1, 1));
      if (state.tab !== 'cube') state.tab = 'cube';
      syncTabs();
    }
    requestRender();
  }

  function rotateFace(id, delta) {
    const s = state.faces[id];
    if (!s) return;
    s.rot = ((s.rot + delta) % 4 + 4) % 4;
    rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
    markDirty();
    render();
  }
  function flipFace(id) {
    const s = state.faces[id];
    if (!s) return;
    s.flipH = !s.flipH;
    rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
    markDirty();
    render();
  }

  // ---------------------------------------------------------------------------
  // 接缝
  // ---------------------------------------------------------------------------
  function ensureSeams() {
    if (state.seamResults) return state.seamResults;
    const faces = coreFaces();
    state.seamResults = C.classifyAllSeams(faces);
    return state.seamResults;
  }

  function seamTitle(r) {
    const a = r.seam.faceA;
    const b = r.seam.faceB;
    return (
      '#' + a + C.FACE_BY_ID[a].short + '·' + C.SIDE_CN[r.seam.sideA] +
      '  ↔  #' + b + C.FACE_BY_ID[b].short + '·' + C.SIDE_CN[r.seam.sideB]
    );
  }

  function renderSeamList() {
    const results = ensureSeams();
    const frag = document.createDocumentFragment();
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'seam-row' + (state.activeSeam === r.seam.key ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'seam-dot';
      dot.style.background = KIND[r.kind].color;
      const label = document.createElement('span');
      label.className = 'seam-label';
      label.textContent = seamTitle(r);
      const kind = document.createElement('span');
      kind.className = 'seam-kind';
      kind.textContent = r.label;
      const tag = document.createElement('span');
      tag.className = 'seam-tag';
      if (r.kind === 'missing') tag.textContent = '缺图';
      else if (r.seam === C.BAND_WRAP_SEAM) tag.textContent = '横带首尾';
      else if (C.netPhysical(r.seam)) tag.textContent = '可直拼';
      else tag.textContent = '需折叠';
      row.append(dot, label, kind, tag);
      row.onclick = () => {
        state.activeSeam = r.seam.key;
        renderSeamList();
        renderSeamDetail(r);
      };
      frag.appendChild(row);
    }
    el.seamList.replaceChildren(frag);
  }

  function seamStripsCanvas(a, b, labelA, labelB) {
    const wrap = document.createElement('div');
    wrap.className = 'seam-strips';
    const mk = (colors, label) => {
      const fig = document.createElement('figure');
      const cap = document.createElement('figcaption');
      cap.textContent = label;
      const c = makeCanvas(Math.max(64, colors.length), 1);
      const cx = c.getContext('2d');
      const idat = cx.createImageData(colors.length, 1);
      for (let i = 0; i < colors.length; i++) {
        idat.data[i * 4] = colors[i][0];
        idat.data[i * 4 + 1] = colors[i][1];
        idat.data[i * 4 + 2] = colors[i][2];
        idat.data[i * 4 + 3] = 255;
      }
      cx.putImageData(idat, 0, 0);
      c.style.height = '30px';
      fig.append(cap, c);
      return fig;
    };
    wrap.append(mk(a, labelA), mk(b, labelB));
    return wrap;
  }

  function renderSeamDetail(r) {
    const seam = r.seam;
    const frag = document.createDocumentFragment();
    const h = document.createElement('h3');
    h.textContent = seamTitle(r);
    frag.appendChild(h);

    const verdict = document.createElement('div');
    verdict.className = 'verdict ' + r.kind;
    const strong = document.createElement('b');
    strong.textContent = KIND[r.kind].text + '：';
    verdict.appendChild(strong);
    verdict.appendChild(document.createTextNode(r.detail || r.label));
    frag.appendChild(verdict);

    // 色带
    const faces = coreFaces();
    const strips = C.sampleSeamColors(faces, seam, 96);
    frag.appendChild(
      seamStripsCanvas(
        strips.a,
        strips.b,
        '#' + seam.faceA + ' ' + C.SIDE_CN[seam.sideA] + ' 边（沿 P0→P1）',
        '#' + seam.faceB + ' ' + C.SIDE_CN[seam.sideB] + ' 边（沿 P0→P1）'
      )
    );

    // 数值
    const stats = document.createElement('div');
    stats.className = 'kv';
    const mkRow = (k, v) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      d.append(dt, dd);
      return d;
    };
    if (isFinite(r.direct)) {
      stats.append(
        mkRow('正向色差', fmt(r.direct) + '  （阈值 ' + C.ROTATION_ONLY_MEAN + '）'),
        mkRow('反向色差', fmt(r.reversed))
      );
    }
    const netNote = document.createElement('div');
    netNote.className = 'net-badge ' + (seam === C.BAND_WRAP_SEAM ? 'wrap' : C.netPhysical(seam) ? 'physical' : '');
    netNote.textContent =
      seam === C.BAND_WRAP_SEAM
        ? '十字展开图里是横带首尾相接'
        : C.netPhysical(seam)
        ? '十字展开图里两格直接相邻'
        : '十字展开图里被切开，需折成立方体才相接';
    stats.appendChild(netNote);
    frag.appendChild(stats);

    // 角点对应
    const cornerInfo = C.seamCornerInfo(faces, seam);
    const table = document.createElement('table');
    table.className = 'seam-corner-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>端点</th><th>面</th><th>角名</th><th>面内 UV</th><th>原图像素</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const end of cornerInfo) {
      end.faces.forEach((fc, i) => {
        const tr = document.createElement('tr');
        const cells = [
          i === 0 ? end.end + ' ' + coordStr(end.P) : '',
          '#' + fc.faceId + ' ' + C.FACE_BY_ID[fc.faceId].cn,
          fc.corner,
          '(' + fmt(fc.u, 3) + ', ' + fmt(fc.v, 3) + ')',
          fc.px + ', ' + fc.py,
        ];
        cells.forEach((txt, ci) => {
          const td = document.createElement('td');
          td.textContent = txt;
          if (ci === 3 || ci === 4) td.className = 'mono';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    frag.appendChild(table);

    // 操作
    const actions = document.createElement('div');
    actions.className = 'seam-actions';
    if (r.kind === 'turnable' && r.fix) {
      const b = document.createElement('button');
      b.className = 'primary small';
      b.textContent = '修正 ' + faceName(r.fix.faceId) + ' 为 ' + C.orientationLabel(r.fix.cfg.rot, r.fix.cfg.flipH);
      b.onclick = () => {
        const s = state.faces[r.fix.faceId];
        if (!s) return;
        s.rot = r.fix.cfg.rot;
        s.flipH = r.fix.cfg.flipH;
        rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
        markDirty();
        render();
        toast('已修正 ' + faceName(r.fix.faceId));
      };
      actions.appendChild(b);
    }
    if (r.kind === 'reversed') {
      for (const id of [seam.faceA, seam.faceB]) {
        const b = document.createElement('button');
        b.className = 'ghost small';
        b.textContent = '镜像 ' + faceName(id);
        b.onclick = () => flipFace(id);
        actions.appendChild(b);
      }
    }
    if (r.kind === 'paired' && r.fix) {
      const b = document.createElement('button');
      b.className = 'primary small';
      b.textContent = '同时应用两面朝向';
      b.onclick = () => {
        for (const [id, cfg] of [[seam.faceA, r.fix.a], [seam.faceB, r.fix.b]]) {
          const s = state.faces[id];
          if (!s) continue;
          s.rot = cfg.rot;
          s.flipH = cfg.flipH;
          rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
        }
        markDirty();
        render();
        toast('已应用两面朝向');
      };
      actions.appendChild(b);
    }
    for (const id of [seam.faceA, seam.faceB]) {
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = '转到 ' + faceName(id);
      b.onclick = () => selectFace(id);
      actions.appendChild(b);
    }
    frag.appendChild(actions);

    el.seamDetail.replaceChildren(frag);
  }

  function coordStr(P) {
    const s = (v) => (v > 0 ? '+' : '') + v;
    return '(' + s(P[0]) + ', ' + s(P[1]) + ', ' + s(P[2]) + ')';
  }

  function autoFixOrientations() {
    const faces = coreFaces();
    const present = Object.keys(faces).length;
    if (present < 2) {
      toast('至少要两张以上的面才能推断朝向', true);
      return;
    }
    setBusy(true);
    setTimeout(() => {
      try {
        const res = C.suggestOrientations(faces);
        for (const f of C.FACES) {
          if (!state.faces[f.id]) continue;
          const cfg = res.configs[f.id];
          if (!cfg) continue;
          const s = state.faces[f.id];
          if (s.rot !== cfg.rot || s.flipH !== cfg.flipH) {
            s.rot = cfg.rot;
            s.flipH = cfg.flipH;
            rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
          }
        }
        markDirty();
        render();
        toast(res.changed.length ? '已调整 ' + res.changed.length + ' 个面的朝向' : '当前朝向已是局部最优');
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  // ---------------------------------------------------------------------------
  // 视图尺寸
  // ---------------------------------------------------------------------------
  function canvasSize() {
    const r = el.wrap.getBoundingClientRect();
    const scale = state.dragging ? 0.55 : 1;
    let W = Math.round(Math.max(320, r.width) * scale);
    let H = Math.round(Math.max(300, r.height) * scale);
    const cap = 1180;
    if (W > cap) {
      H = Math.round(H * (cap / W));
      W = cap;
    }
    return { W, H };
  }

  function blitImageData(img, dx, dy, dw, dh) {
    tmp.width = img.width;
    tmp.height = img.height;
    tmpCtx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, img.width, img.height, dx, dy, dw, dh);
  }

  // ---------------------------------------------------------------------------
  // 主渲染
  // ---------------------------------------------------------------------------
  function render() {
    ensureSeams(); // 先算接缝
    renderDiagnostics(); // 诊断要用接缝结果，且面卡要用 nonSquare
    renderFaceCards();
    renderSeamList();
    if (state.activeSeam) {
      const r = state.seamResults.find((x) => x.seam.key === state.activeSeam);
      if (r) renderSeamDetail(r);
    }
    paintView();
    paintProbe();
  }

  function paintView() {
    const { W, H } = canvasSize();
    if (el.canvas.width !== W || el.canvas.height !== H) {
      el.canvas.width = W;
      el.canvas.height = H;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(0, 0, W, H);
    if (state.tab === 'cube') paintCube(W, H);
    else if (state.tab === 'net') paintNet(W, H);
    else paintEquirect(W, H);
    el.badge.textContent =
      state.tab === 'cube'
        ? C.viewLabel(state.view.yaw, state.view.pitch) + ' · FOV ' + Math.round(state.view.fovDeg) + '°'
        : state.tab === 'net'
        ? '十字展开图 · 4×3'
        : '经纬展开图 · 2:1';
  }

  // ---------- 立方体内部 ----------
  function paintCube(W, H) {
    const faces = coreFaces();
    const basis = C.cameraBasis(state.view.yaw, state.view.pitch);
    const img = C.renderCubeView({
      width: W,
      height: H,
      yaw: state.view.yaw,
      pitch: state.view.pitch,
      fovDeg: state.view.fovDeg,
      faces,
    });
    blitImageData(img, 0, 0, W, H);
    state.cubeInfo = { width: W, height: H, basis, fovDeg: state.view.fovDeg };

    // 棱线（按接缝结论着色）
    if (state.showSeams) {
      const results = ensureSeams();
      ctx.lineWidth = Math.max(1.5, W / 520);
      for (const r of results) {
        const p0 = C.projectPoint(r.seam.P0, W, H, basis, state.view.fovDeg);
        const p1 = C.projectPoint(r.seam.P1, W, H, basis, state.view.fovDeg);
        if (!p0 || !p1) continue;
        ctx.strokeStyle = KIND[r.kind].color;
        ctx.globalAlpha = r.kind === 'aligned' ? 0.42 : 0.95;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 面号
    if (state.showLabels) {
      for (const f of C.FACES) {
        const p = C.projectPoint(f.n, W, H, basis, state.view.fovDeg);
        if (!p) continue;
        const label = '#' + f.id + ' ' + f.cn;
        drawChip(p.x, p.y, label, f.id === state.selectedFace ? '#ffbe55' : 'rgba(230,236,245,.82)');
      }
    }

    // 取样点
    if (state.probe && state.probe.source === 'cube' && state.probe.dir) {
      const p = C.projectPoint(state.probe.dir, W, H, basis, state.view.fovDeg);
      if (p) {
        ctx.strokeStyle = '#6fd0e0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(7, W / 130), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - 12, p.y);
        ctx.lineTo(p.x + 12, p.y);
        ctx.moveTo(p.x, p.y - 12);
        ctx.lineTo(p.x, p.y + 12);
        ctx.stroke();
      }
    }
  }

  function drawChip(x, y, text, color) {
    ctx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = 'rgba(8,11,16,.72)';
    roundRect(x - w / 2, y - 11, w, 22, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(38,48,65,.9)';
    ctx.lineWidth = 1;
    roundRect(x - w / 2, y - 11, w, 22, 6);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 0.5);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 十字展开图 ----------
  function paintNet(W, H) {
    const cell = Math.max(72, Math.floor(Math.min((W - 40) / 4, (H - 40) / 3)));
    const img = C.renderNet({ faces: coreFaces(), cell, gap: Math.round(cell * 0.03), pad: 10 });
    const scale = Math.min(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    blitImageData(img, dx, dy, dw, dh);
    state.netInfo = { img, rects: img.rects, dx, dy, scale, cell: img.cell };

    const results = ensureSeams();
    // 每格边框 + 面号
    for (const f of C.FACES) {
      const rect = img.rects[f.id];
      if (!rect) continue;
      const x = dx + rect.x * scale;
      const y = dy + rect.y * scale;
      const w = rect.w * scale;
      const h = rect.h * scale;
      ctx.strokeStyle = f.id === state.selectedFace ? 'rgba(255,190,85,.9)' : 'rgba(70,86,110,.75)';
      ctx.lineWidth = f.id === state.selectedFace ? 2.5 : 1.2;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      if (state.showLabels) drawChip(x + w / 2, y + h / 2, '#' + f.id + ' ' + f.cn, '#e6ecf5');
    }

    // 相邻缝：在展开图上画出实际相邻的边（按结论着色）
    if (state.showSeams) {
      ctx.lineWidth = Math.max(2, 4 * scale);
      for (const r of results) {
        if (!C.netPhysical(r.seam)) continue;
        const seg = netEdgeSegment(img, r.seam.faceA, r.seam.sideA, dx, dy, scale);
        if (!seg) continue;
        ctx.strokeStyle = KIND[r.kind].color;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 横带首尾：用虚线连接 后5 右边 与 左1 左边
      const wrap = C.BAND_WRAP_SEAM;
      if (wrap) {
        const a = netEdgeSegment(img, wrap.faceA, wrap.sideA, dx, dy, scale);
        const b = netEdgeSegment(img, wrap.faceB, wrap.sideB, dx, dy, scale);
        if (a && b) {
          const ax = (a[0] + a[2]) / 2;
          const ay = (a[1] + a[3]) / 2;
          const bx = (b[0] + b[2]) / 2;
          const by = (b[1] + b[3]) / 2;
          const wrapRes = results.find((x) => x.seam === wrap);
          ctx.save();
          ctx.setLineDash([6, 6]);
          ctx.strokeStyle = KIND[wrapRes ? wrapRes.kind : 'missing'].color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.restore();
          ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
          ctx.fillStyle = 'rgba(230,236,245,.8)';
          ctx.textAlign = 'center';
          ctx.fillText('首尾接缝', (ax + bx) / 2, Math.min(ay, by) - 8);
        }
      }
    }

    // 取样点
    if (state.probe && state.probe.source === 'net') {
      const rect = img.rects[state.probe.faceId];
      if (rect) {
        const x = dx + (rect.x + state.probe.u * rect.w) * scale;
        const y = dy + (rect.y + (1 - state.probe.v) * rect.h) * scale;
        ctx.strokeStyle = '#6fd0e0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // 展开图中某面某边的像素线段
  function netEdgeSegment(img, faceId, side, dx, dy, scale) {
    const rect = img.rects[faceId];
    if (!rect) return null;
    const e = C.EDGES[faceId + ':' + side];
    const toPx = (uv) => [
      dx + (rect.x + uv[0] * rect.w) * scale,
      dy + (rect.y + (1 - uv[1]) * rect.h) * scale,
    ];
    const p0 = toPx(e.uv0);
    const p1 = toPx(e.uv1);
    return [p0[0], p0[1], p1[0], p1[1]];
  }

  // ---------- 经纬展开图 ----------
  function currentEquirect() {
    const key = configKey();
    if (state.importedEquirect) return state.importedEquirect;
    if (state.eqCache && state.eqCacheKey === key) return state.eqCache;
    const width = 1400;
    const height = 700;
    const img = C.renderEquirectFromFaces({
      width,
      height,
      faces: coreFaces(),
      bilinear: false,
    });
    state.eqCache = { tex: { data: img.data, width, height }, width, height, derived: true };
    state.eqCacheKey = key;
    return state.eqCache;
  }

  function paintEquirect(W, H) {
    const eq = currentEquirect();
    const dw = Math.min(W, H * 2);
    const dh = dw / 2;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    blitImageData({ width: eq.width, height: eq.height, data: eq.tex ? eq.tex.data : eq.data }, dx, dy, dw, dh);
    state.eqInfo = { dx, dy, dw, dh, width: eq.width, height: eq.height, imported: !!state.importedEquirect };

    const px = (u) => dx + u * dw;
    const py = (v) => dy + v * dh;

    // 面边界与面号（把立方体面投影到经纬图上）
    if (state.showLabels) {
      ctx.lineWidth = 1.2;
      for (const f of C.FACES) {
        ctx.strokeStyle = f.id === state.selectedFace ? 'rgba(255,190,85,.95)' : 'rgba(90,110,140,.65)';
        drawEquirectFaceOutline(f.id, px, py, dw, dh);
        const c = C.dirToEquirectPixel(C.FACE_BY_ID[f.id].n, eq.width, eq.height);
        // 注意：经纬图已按 2:1 映射，这里是像素坐标 → 归一化
        const u = (c.x + 0.5) / eq.width;
        const v = (c.y + 0.5) / eq.height;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          drawChip(px(u), py(v), '#' + f.id + ' ' + f.cn, f.id === state.selectedFace ? '#ffbe55' : 'rgba(230,236,245,.85)');
        }
      }
      ctx.lineWidth = 1;
    }

    // 首尾接缝
    if (state.showSeams) {
      ctx.save();
      ctx.strokeStyle = '#ffb648';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 5]);
      for (const x of [dx + 0.5, dx + dw - 0.5]) {
        ctx.beginPath();
        ctx.moveTo(x, dy);
        ctx.lineTo(x, dy + dh);
        ctx.stroke();
      }
      ctx.restore();
      ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = '#ffb648';
      ctx.textAlign = 'left';
      ctx.fillText('首尾接缝 (lon=±180°)', dx + 6, dy + 16);
      ctx.textAlign = 'right';
      ctx.fillText('首尾接缝', dx + dw - 6, dy + 16);
    }

    // 极区标记
    if (state.showPoles) {
      const vTop = 0.5 - C.EQ_POLE_LAT / Math.PI;
      const vBot = 0.5 + C.EQ_POLE_LAT / Math.PI;
      ctx.save();
      ctx.strokeStyle = 'rgba(126,224,240,.7)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      for (const v of [vTop, vBot]) {
        ctx.beginPath();
        ctx.moveTo(dx, py(v));
        ctx.lineTo(dx + dw, py(v));
        ctx.stroke();
      }
      ctx.restore();
      ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = 'rgba(126,224,240,.95)';
      ctx.textAlign = 'center';
      ctx.fillText('▲ 北极区（+Y 上）—— 立方体顶面覆盖', dx + dw / 2, dy + 14);
      ctx.fillText('▼ 南极区（-Y 下）—— 立方体底面覆盖', dx + dw / 2, dy + dh - 6);
      // 中心方向箭头
      ctx.strokeStyle = 'rgba(255,224,140,.9)';
      ctx.fillStyle = 'rgba(255,224,140,.95)';
      ctx.lineWidth = 2;
      for (const f of C.FACES) {
        if (f.id === 2 || f.id === 3) continue;
        const c = C.dirToEquirectPixel(f.n, eq.width, eq.height);
        const u = (c.x + 0.5) / eq.width;
        const v = (c.y + 0.5) / eq.height;
        const x = px(u);
        const y = py(v) + 18;
        const len = Math.min(26, dh * 0.06);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - len);
        ctx.moveTo(x - 4, y - len + 6);
        ctx.lineTo(x, y - len);
        ctx.lineTo(x + 4, y - len + 6);
        ctx.stroke();
      }
    }

    // 取样点
    if (state.probe && state.probe.source === 'equirect' && state.probe.lon != null) {
      const u = (state.probe.lon + Math.PI) / (Math.PI * 2);
      const v = (Math.PI / 2 - state.probe.lat) / Math.PI;
      const x = px(u);
      const y = py(v);
      ctx.strokeStyle = '#6fd0e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 把立方体某个面的四条边画到经纬图上（在 ±180 处断开）
  function drawEquirectFaceOutline(faceId, px, py, dw, dh) {
    const N = 24;
    const pts = [];
    const sides = ['right', 'top', 'left', 'bottom'];
    for (const side of sides) {
      const e = C.EDGES[faceId + ':' + side];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const u = e.uv0[0] + (e.uv1[0] - e.uv0[0]) * t;
        const v = e.uv0[1] + (e.uv1[1] - e.uv0[1]) * t;
        const ll = C.faceUVToLonLat(faceId, u, v);
        const xu = (ll.lon + Math.PI) / (Math.PI * 2);
        const yv = (Math.PI / 2 - ll.lat) / Math.PI;
        pts.push([px(xu), py(yv)]);
      }
    }
    ctx.beginPath();
    let prev = null;
    for (const p of pts) {
      if (!prev || Math.abs(p[0] - prev[0]) > dw * 0.5) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
      prev = p;
    }
    ctx.stroke();
  }

  // ---------------------------------------------------------------------------
  // 取样
  // ---------------------------------------------------------------------------
  function setProbe(info) {
    state.probe = info;
    if (info) {
      const s = state.faces[info.faceId];
      if (s) rememberProbe(info);
    }
    paintProbe();
    renderStatus();
    renderFaceCards();
    paintView();
  }

  let lastRememberedProbe = '';
  function rememberProbe() {
    /* 预留：目前不持久化取样点，避免文件过大 */
  }

  function probeFromCube(x, y) {
    const info = state.cubeInfo;
    if (!info) return null;
    const ray = C.viewRay(x, y, info.width, info.height, info.basis, info.fovDeg);
    const hit = C.dirToFace(ray);
    const s = state.faces[hit.faceId];
    const p = s ? C.uvToSourcePixel(s.rot, s.flipH, hit.u, hit.v, s.tex.width, s.tex.height) : { x: 0, y: 0 };
    const ll = C.lonLatFromDir(C.norm(ray));
    return {
      faceId: hit.faceId,
      u: hit.u,
      v: hit.v,
      px: p.x,
      py: p.y,
      dir: C.norm(ray),
      source: 'cube',
      lon: ll.lon,
      lat: ll.lat,
      corner: C.cornerName(hit.u, hit.v),
    };
  }

  function probeFromNet(x, y) {
    const n = state.netInfo;
    if (!n) return null;
    for (const f of C.FACES) {
      const rect = n.rects[f.id];
      if (!rect) continue;
      const cx = n.dx + rect.x * n.scale;
      const cy = n.dy + rect.y * n.scale;
      const cw = rect.w * n.scale;
      const ch = rect.h * n.scale;
      if (x < cx || y < cy || x > cx + cw || y > cy + ch) continue;
      const u = (x - cx) / cw;
      const v = 1 - (y - cy) / ch;
      const s = state.faces[f.id];
      const p = s ? C.uvToSourcePixel(s.rot, s.flipH, u, v, s.tex.width, s.tex.height) : { x: 0, y: 0 };
      const ll = C.faceUVToLonLat(f.id, u, v);
      return {
        faceId: f.id,
        u,
        v,
        px: p.x,
        py: p.y,
        source: 'net',
        lon: ll.lon,
        lat: ll.lat,
        corner: C.cornerName(u, v),
      };
    }
    return null;
  }

  function probeFromEquirect(x, y) {
    const e = state.eqInfo;
    if (!e) return null;
    if (x < e.dx || y < e.dy || x > e.dx + e.dw || y > e.dy + e.dh) return null;
    const u = (x - e.dx) / e.dw;
    const v = (y - e.dy) / e.dh;
    const lon = u * Math.PI * 2 - Math.PI;
    const lat = Math.PI / 2 - v * Math.PI;
    const dir = C.dirFromLonLat(lon, lat);
    const hit = C.dirToFace(dir);
    const s = state.faces[hit.faceId];
    const p = s ? C.uvToSourcePixel(s.rot, s.flipH, hit.u, hit.v, s.tex.width, s.tex.height) : { x: 0, y: 0 };
    return {
      faceId: hit.faceId,
      u: hit.u,
      v: hit.v,
      px: p.x,
      py: p.y,
      source: 'equirect',
      lon,
      lat,
      corner: C.cornerName(hit.u, hit.v),
    };
  }

  function renderStatus() {
    const p = state.probe;
    if (!p) {
      el.statusbar.innerHTML = '<span class="status-empty">点击视图任意位置，这里会显示所属面编号与原图像素位置。</span>';
      return;
    }
    const s = state.faces[p.faceId];
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = '面 <b>#' + p.faceId + ' ' + C.FACE_BY_ID[p.faceId].cn + '</b>';
    const uv = document.createElement('span');
    uv.className = 'chip';
    uv.innerHTML = 'UV <b>' + fmt(p.u, 3) + ', ' + fmt(p.v, 3) + '</b> · ' + p.corner;
    const src = document.createElement('span');
    src.className = 'chip';
    src.innerHTML = s
      ? '原图像素 <b>' + Math.round(p.px) + ', ' + Math.round(p.py) + '</b> / ' + s.tex.width + '×' + s.tex.height
      : '原图 <b>缺失</b>';
    const geo = document.createElement('span');
    geo.className = 'chip';
    geo.innerHTML = 'lon/lat <b>' + fmt((p.lon * 180) / Math.PI, 1) + '°, ' + fmt((p.lat * 180) / Math.PI, 1) + '°</b>';
    el.statusbar.replaceChildren(c, uv, src, geo);
  }

  function paintProbe() {
    const cv = el.probeCanvas;
    const cx = probeCtx;
    const p = state.probe;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#0b0f16';
    cx.fillRect(0, 0, cv.width, cv.height);
    if (!p) {
      cx.fillStyle = '#55627a';
      cx.font = '12px -apple-system, "PingFang SC", sans-serif';
      cx.textAlign = 'center';
      cx.fillText('点击视图取样', cv.width / 2, cv.height / 2);
      el.probeInfo.innerHTML = '<div><dt>位置</dt><dd class="status-empty">尚未取样</dd></div>';
      return;
    }
    const s = state.faces[p.faceId];
    if (s) {
      const thumb = orientedThumb(p.faceId, 160);
      cx.drawImage(thumb, 0, 0, cv.width, cv.height);
      // 十字线（显示坐标 u,v）
      const x = p.u * cv.width;
      const y = (1 - p.v) * cv.height;
      cx.strokeStyle = 'rgba(111,208,224,.95)';
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.moveTo(x, 0);
      cx.lineTo(x, cv.height);
      cx.moveTo(0, y);
      cx.lineTo(cv.width, y);
      cx.stroke();
      cx.beginPath();
      cx.arc(x, y, 7, 0, Math.PI * 2);
      cx.stroke();
      cx.strokeStyle = 'rgba(9,12,18,.85)';
      cx.lineWidth = 3;
      cx.beginPath();
      cx.arc(x, y, 9, 0, Math.PI * 2);
      cx.stroke();
    }
    const rows = [
      ['面', '#' + p.faceId + ' ' + C.FACE_BY_ID[p.faceId].cn + ' / ' + C.FACE_BY_ID[p.faceId].name],
      ['角区', p.corner],
      ['面内 UV', fmt(p.u, 4) + ', ' + fmt(p.v, 4)],
      ['原图像素', s ? Math.round(p.px) + ', ' + Math.round(p.py) : '—'],
      ['朝向', s ? C.orientationLabel(s.rot, s.flipH) : '—'],
    ];
    el.probeInfo.innerHTML = rows
      .map((r) => '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>')
      .join('');
  }

  // ---------------------------------------------------------------------------
  // 事件：画布
  // ---------------------------------------------------------------------------
  function canvasPoint(ev) {
    const r = el.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * el.canvas.width,
      y: ((ev.clientY - r.top) / r.height) * el.canvas.height,
    };
  }

  let dragStart = null;

  el.canvas.addEventListener('pointerdown', (ev) => {
    // 立方体视图支持拖动旋转；展开图/经纬图只接受点击取样
    if (state.tab === 'cube') {
      el.canvas.setPointerCapture(ev.pointerId);
      dragStart = { x: ev.clientX, y: ev.clientY, yaw: state.view.yaw, pitch: state.view.pitch };
      state.dragging = true;
      state.dragMoved = false;
      el.canvas.classList.add('dragging');
    } else {
      // 记录起点，松手时若未移动就取样
      el.canvas.setPointerCapture(ev.pointerId);
      dragStart = { x: ev.clientX, y: ev.clientY, static: true };
      state.dragMoved = false;
    }
  });

  el.canvas.addEventListener('pointermove', (ev) => {
    if (!dragStart) return;
    if (dragStart.static) {
      if (Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y) > 4) state.dragMoved = true;
      return;
    }
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    if (!state.dragMoved && Math.hypot(dx, dy) > 4) state.dragMoved = true;
    if (!state.dragMoved) return;
    const sensitivity = 0.0052;
    state.view.yaw = dragStart.yaw - dx * sensitivity;
    state.view.pitch = clamp(dragStart.pitch + dy * sensitivity, -1.35, 1.35);
    requestPaint();
  });

  function endDrag(ev) {
    if (!dragStart) return;
    const wasMoved = state.dragMoved;
    dragStart = null;
    state.dragging = false;
    state.dragMoved = false;
    el.canvas.classList.remove('dragging');
    if (!wasMoved) {
      const pt = canvasPoint(ev);
      const p =
        state.tab === 'cube'
          ? probeFromCube(pt.x, pt.y)
          : state.tab === 'net'
          ? probeFromNet(pt.x, pt.y)
          : probeFromEquirect(pt.x, pt.y);
      setProbe(p);
    } else {
      requestPaint();
    }
  }
  el.canvas.addEventListener('pointerup', endDrag);
  el.canvas.addEventListener('pointercancel', () => {
    dragStart = null;
    state.dragging = false;
    state.dragMoved = false;
    el.canvas.classList.remove('dragging');
    requestPaint();
  });

  el.canvas.addEventListener(
    'wheel',
    (ev) => {
      if (state.tab !== 'cube') return;
      ev.preventDefault();
      state.view.fovDeg = clamp(state.view.fovDeg + Math.sign(ev.deltaY) * 3.5, 34, 118);
      requestPaint();
    },
    { passive: false }
  );

  el.canvas.addEventListener('dblclick', () => resetView());

  function resetView() {
    state.view = Object.assign({}, C.DEFAULT_VIEW);
    requestPaint();
  }

  // ---------------------------------------------------------------------------
  // 事件：键盘
  // ---------------------------------------------------------------------------
  window.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
    if (el.help.open) return;
    const k = ev.key;
    if (k >= '1' && k <= '6') {
      selectFace(Number(k) - 1);
      ev.preventDefault();
      return;
    }
    if (k === '[') { rotateFace(state.selectedFace, -1); ev.preventDefault(); return; }
    if (k === ']') { rotateFace(state.selectedFace, 1); ev.preventDefault(); return; }
    if (k === 'f' || k === 'F') { flipFace(state.selectedFace); ev.preventDefault(); return; }
    if (k === 'r' || k === 'R') { resetView(); ev.preventDefault(); return; }
    if (k === 'ArrowLeft') { state.view.yaw -= 0.12; requestRender(); ev.preventDefault(); return; }
    if (k === 'ArrowRight') { state.view.yaw += 0.12; requestRender(); ev.preventDefault(); return; }
    if (k === 'ArrowUp') { state.view.pitch = clamp(state.view.pitch + 0.1, -1.35, 1.35); requestRender(); ev.preventDefault(); return; }
    if (k === 'ArrowDown') { state.view.pitch = clamp(state.view.pitch - 0.1, -1.35, 1.35); requestRender(); ev.preventDefault(); return; }
  });

  // ---------------------------------------------------------------------------
  // 事件：工具栏
  // ---------------------------------------------------------------------------
  function syncTabs() {
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    $('#wrap-poles').style.display = state.tab === 'equirect' ? 'flex' : 'none';
    const showEq = state.tab === 'equirect' ? '' : 'none';
    $('#btn-extract').style.display = showEq;
    $('#btn-save-eq').style.display = showEq;
    // 经纬模式下拖动没有意义，提示改为“点击取样”
    $('#view-hint').textContent =
      state.tab === 'cube'
        ? '拖动旋转 · 滚轮缩放 · 点击取样 · 双击重置'
        : '点击任意位置取样 · 上方页签切换视图';
  }

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      state.probe = null;
      syncTabs();
      requestRender();
      renderStatus();
    };
  });

  $('#opt-seams').onchange = (e) => { state.showSeams = e.target.checked; requestRender(); };
  $('#opt-labels').onchange = (e) => { state.showLabels = e.target.checked; requestRender(); };
  $('#opt-poles').onchange = (e) => { state.showPoles = e.target.checked; requestRender(); };
  $('#btn-fit').onclick = resetView;
  $('#btn-refresh').onclick = () => { thumbCache.clear(); markDirty(); render(); };
  $('#btn-samples').onclick = loadSampleFaces;
  $('#btn-suggest').onclick = autoFixOrientations;
  $('#btn-clear').onclick = () => {
    if (!confirm('清空当前六面图与朝向？（不影响已保存的项目文件）')) return;
    for (const f of C.FACES) state.faces[f.id] = null;
    state.probe = null;
    state.importedEquirect = null;
    markDirty();
    render();
    renderStatus();
  };
  $('#btn-help').onclick = () => el.help.showModal();
  $('#btn-extract').onclick = extractFromEquirect;
  $('#btn-save-eq').onclick = () => exportEquirect();

  // 菜单
  document.querySelectorAll('.menu').forEach((menu) => {
    const btn = menu.querySelector('button');
    btn.onclick = (ev) => {
      ev.stopPropagation();
      document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
      menu.classList.toggle('open');
    };
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
  });

  document.querySelectorAll('#import-menu button').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'faces') el.fileFaces.click();
      else if (act === 'equirect') el.fileEquirect.click();
      else if (act === 'project') el.fileProject.click();
      else if (act === 'samples') loadSampleFaces();
    };
  });
  document.querySelectorAll('#export-menu button').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'equirect') exportEquirect();
      else if (act === 'net') exportNet();
      else if (act === 'faces-corrected') exportBakedFaces();
      else if (act === 'project') exportProject();
      else if (act === 'config') exportConfig();
      else if (act === 'cube-shot') exportCubeShot();
    };
  });

  // 文件输入
  el.fileFaces.onchange = async (e) => {
    const raw = el.fileFaces.dataset.target;
    el.fileFaces.dataset.target = '';
    const forced = raw === '' || raw == null ? null : Number(raw);
    const forcedId = Number.isInteger(forced) ? forced : null;
    await assignFiles(e.target.files, forcedId);
    e.target.value = '';
  };
  el.fileEquirect.onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const tex = await texFromBlob(f);
      state.importedEquirect = { tex, name: f.name, width: tex.width, height: tex.height };
      state.tab = 'equirect';
      state.probe = null;
      syncTabs();
      markDirty();
      render();
      renderStatus();
      toast('已载入经纬图 ' + f.name + '（' + tex.width + '×' + tex.height + '），可点“抽取六面”。');
    } catch (err) {
      toast('载入经纬图失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };
  el.fileProject.onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    await loadProject(f);
  };

  // 拖放
  ['dragover', 'dragenter'].forEach((t) => {
    document.addEventListener(t, (ev) => {
      ev.preventDefault();
      document.body.style.outline = '2px dashed rgba(255,190,85,.5)';
      document.body.style.outlineOffset = '-8px';
    });
  });
  ['dragleave', 'drop'].forEach((t) => {
    document.addEventListener(t, (ev) => {
      ev.preventDefault();
      document.body.style.outline = '';
      document.body.style.outlineOffset = '';
    });
  });
  document.addEventListener('drop', async (ev) => {
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (!files || !files.length) return;
    const arr = Array.from(files);
    const json = arr.find((f) => /\.json$/i.test(f.name));
    if (json) {
      await loadProject(json);
      return;
    }
    const images = arr.filter((f) => f.type.startsWith('image/'));
    if (images.length === 1 && (state.tab === 'equirect' || /equirect|panorama|360|pano/i.test(images[0].name))) {
      setBusy(true);
      try {
        const tex = await texFromBlob(images[0]);
        state.importedEquirect = { tex, name: images[0].name, width: tex.width, height: tex.height };
        state.tab = 'equirect';
        syncTabs();
        markDirty();
        render();
        toast('已把 ' + images[0].name + ' 作为经纬图载入');
      } catch (err) {
        toast('读取失败：' + err.message, true);
      } finally {
        setBusy(false);
      }
      return;
    }
    await assignFiles(images, null);
  });

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  }
  function downloadCanvas(canvas, name) {
    return new Promise((resolve) => {
      canvas.toBlob((b) => {
        if (b) downloadBlob(b, name);
        resolve();
      }, 'image/png');
    });
  }
  function imageDataToCanvas(img) {
    const c = makeCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportEquirect() {
    if (!anyFace()) {
      toast('还没有载入任何面图', true);
      return;
    }
    setBusy(true);
    setTimeout(async () => {
      try {
        const width = EQUIRECT_W;
        const height = EQUIRECT_W / 2;
        const img = C.renderEquirectFromFaces({ width, height, faces: coreFaces(), bilinear: true });
        state.lastExportEq = img;
        await downloadCanvas(imageDataToCanvas(img), 'equirect-' + stamp() + '.png');
        toast('已导出经纬展开图 ' + width + '×' + height);
      } catch (err) {
        toast('导出失败：' + err.message, true);
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  function exportNet() {
    if (!anyFace()) return toast('还没有载入任何面图', true);
    const cell = 512;
    const img = C.renderNet({ faces: coreFaces(), cell, gap: 8, pad: 12 });
    const c = imageDataToCanvas(img);
    const cx = c.getContext('2d');
    cx.font = '600 22px -apple-system, "PingFang SC", sans-serif';
    cx.fillStyle = 'rgba(230,236,245,.9)';
    cx.textAlign = 'center';
    for (const f of C.FACES) {
      const r = img.rects[f.id];
      if (!r) continue;
      cx.fillText('#' + f.id + ' ' + C.FACE_BY_ID[f.id].cn + ' ' + C.FACE_BY_ID[f.id].name, r.x + r.w / 2, r.y + r.h - 18);
    }
    downloadCanvas(c, 'net-' + stamp() + '.png');
    toast('已导出十字展开图');
  }

  function exportBakedFaces() {
    if (!anyFace()) return toast('还没有载入任何面图', true);
    const size = C.commonSize(coreFaces());
    const side = Math.max(size.width, size.height);
    let i = 0;
    const next = () => {
      const ids = C.FACES.map((f) => f.id).filter((id) => state.faces[id]);
      if (i >= ids.length) {
        toast('已导出 ' + ids.length + ' 张已摆正的面图');
        return;
      }
      const id = ids[i++];
      const s = state.faces[id];
      const baked = bakeFace(s.tex, s.rot, s.flipH, side, side);
      const c = imageDataToCanvas(baked);
      downloadCanvas(c, 'face-' + id + '-' + C.FACE_BY_ID[id].name.toLowerCase() + '-' + stamp() + '.png');
      setTimeout(next, 320);
    };
    next();
  }

  function exportCubeShot() {
    if (state.tab !== 'cube') {
      state.tab = 'cube';
      syncTabs();
      render();
    }
    const c = makeCanvas(el.canvas.width, el.canvas.height);
    c.getContext('2d').drawImage(el.canvas, 0, 0);
    downloadCanvas(c, 'cube-view-' + stamp() + '.png');
    toast('已导出当前立方体视图');
  }

  function buildProject() {
    const faces = {};
    for (const f of C.FACES) {
      const s = state.faces[f.id];
      faces[f.id] = s
        ? {
            name: s.name,
            fileName: s.fileName,
            width: s.tex.width,
            height: s.tex.height,
            rot: s.rot,
            flipH: s.flipH,
            dataUrl: texToDataURL(s.tex),
          }
        : null;
    }
    return {
      format: 'cube-env-checker/project',
      version: 1,
      savedAt: new Date().toISOString(),
      note: '面顺序固定为 0..5 = +X 右 / -X 左 / +Y 上 / -Y 下 / +Z 前 / -Z 后；rot 为顺时针 90° 次数，flipH 为水平镜像。',
      view: { yaw: state.view.yaw, pitch: state.view.pitch, fovDeg: state.view.fovDeg },
      faces,
    };
  }

  function exportProject() {
    if (!anyFace()) return toast('还没有载入任何面图', true);
    const proj = buildProject();
    const blob = new Blob([JSON.stringify(proj, null, 1)], { type: 'application/json' });
    downloadBlob(blob, 'cube-project-' + stamp() + '.json');
    toast('已保存项目（含图片与朝向），下次直接打开即可恢复');
  }

  function exportConfig() {
    const faces = {};
    for (const f of C.FACES) {
      const s = state.faces[f.id];
      faces[f.id] = s ? { fileName: s.fileName, rot: s.rot, flipH: s.flipH, width: s.tex.width, height: s.tex.height } : null;
    }
    const cfg = {
      format: 'cube-env-checker/config',
      version: 1,
      savedAt: new Date().toISOString(),
      faces,
      view: { yaw: state.view.yaw, pitch: state.view.pitch, fovDeg: state.view.fovDeg },
    };
    downloadBlob(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }), 'cube-config-' + stamp() + '.json');
    toast('已导出方向配置（不含图片）');
  }

  async function loadProject(file) {
    setBusy(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || (data.format !== 'cube-env-checker/project' && data.format !== 'cube-env-checker/config')) {
        throw new Error('不是本工具的项目文件');
      }
      if (data.view) {
        state.view = Object.assign({}, C.DEFAULT_VIEW, {
          yaw: data.view.yaw != null ? data.view.yaw : C.DEFAULT_VIEW.yaw,
          pitch: data.view.pitch != null ? data.view.pitch : C.DEFAULT_VIEW.pitch,
          fovDeg: data.view.fovDeg != null ? data.view.fovDeg : C.DEFAULT_VIEW.fovDeg,
        });
      }
      if (data.format === 'cube-env-checker/config') {
        // 只恢复朝向：按文件名/尺寸匹配当前已有的面
        let applied = 0;
        for (const f of C.FACES) {
          const rec = data.faces && data.faces[f.id];
          if (!rec) continue;
          const s = state.faces[f.id];
          if (!s) continue;
          s.rot = ((rec.rot || 0) % 4 + 4) % 4;
          s.flipH = !!rec.flipH;
          rememberOrientation(s.fileName, s.tex, s.rot, s.flipH);
          applied++;
        }
        markDirty();
        render();
        toast(applied ? '已套用 ' + applied + ' 个面的方向配置' : '当前没有可匹配的面，请先载入图片再套用配置', !applied);
        return;
      }
      // 完整项目：还原图片与朝向
      if (!data.faces) throw new Error('项目缺少 faces 字段');
      const newFaces = {};
      for (const f of C.FACES) {
        const rec = data.faces[f.id];
        if (!rec || !rec.dataUrl) {
          newFaces[f.id] = null;
          continue;
        }
        const tex = await texFromDataURL(rec.dataUrl);
        newFaces[f.id] = {
          tex,
          rot: ((rec.rot || 0) % 4 + 4) % 4,
          flipH: !!rec.flipH,
          name: rec.name || rec.fileName || 'face-' + f.id,
          fileName: rec.fileName || rec.name || 'face-' + f.id,
        };
      }
      for (const f of C.FACES) state.faces[f.id] = newFaces[f.id];
      state.importedEquirect = null;
      state.probe = null;
      state.selectedFace = state.faces[4] ? 4 : C.FACES.find((f) => state.faces[f.id]).id;
      markDirty();
      render();
      renderStatus();
      toast('项目已恢复：六面图与朝向均已还原');
    } catch (err) {
      toast('打开项目失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 经纬图 → 六面
  // ---------------------------------------------------------------------------
  function extractFromEquirect() {
    const eq = currentEquirect();
    const tex = eq.tex || { data: eq.data, width: eq.width, height: eq.height };
    if (!tex || !tex.data) {
      toast('当前没有可抽取的经纬图', true);
      return;
    }
    setBusy(true);
    setTimeout(() => {
      try {
        const size = 1024;
        const out = C.extractFacesFromEquirect({ equirect: tex, size, bilinear: true });
        for (const f of C.FACES) {
          const t = out[f.id];
          state.faces[f.id] = {
            tex: { data: t.data, width: size, height: size },
            rot: 0,
            flipH: false,
            name: 'extracted-' + f.id + '-' + C.FACE_BY_ID[f.id].name.toLowerCase() + '.png',
            fileName: 'extracted-' + f.id + '-' + C.FACE_BY_ID[f.id].name.toLowerCase() + '.png',
          };
        }
        state.probe = null;
        markDirty();
        render();
        renderStatus();
        toast('已从经纬图抽取六面（1024×1024），可在“六个面”里逐张导出或继续检查接缝');
      } catch (err) {
        toast('抽取失败：' + err.message, true);
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  function boot() {
    syncTabs();
    render();
    renderStatus();
    $('#build-info').textContent = '核心：CubeCore · ' + C.SEAMS.length + ' 条接缝已建模';
    const params = new URLSearchParams(location.search);
    if (params.get('samples') === '1') loadSampleFaces();
    if (params.get('tab')) {
      state.tab = params.get('tab');
      syncTabs();
      requestRender();
    }
  }

  new ResizeObserver(() => {
    if (!heavyBusy) requestRender();
  }).observe(el.wrap);

  window.addEventListener('resize', () => requestRender());

  boot();
})();
