'use strict';

/* ================= 状态 ================= */

const ATLAS_SIZES = [128, 256, 512, 1024, 2048, 4096];
const GUTTER = 1; // 图集中单元格之间的间隔，防止采样串色

const state = {
  projectName: '未命名字体',
  glyphs: new Map(), // char -> glyph
  diagnostics: [],   // {level:'err'|'warn'|'ok', text}
  settings: {
    charSpacing: 1,      // 字符间距（附加在每个前进宽度之后）
    lineHeight: 40,      // 行高
    baseline: 32,        // 全局基线：行顶到基线的距离
    edgePadding: 4,      // 图集边缘留白
    atlasSize: 512,
    fallbackAdvance: 16, // 缺字占位宽度
  },
  packing: null, // {size, placements: Map<char,{x,y,w,h}>, unplaced:[char], occupancy}
  previewWidth: 360,
  showGuides: true,
};

// glyph = { char, code, fileName, dataUrl, img, w, h, blank,
//           padding, baseline, advance }

/* ================= 工具 ================= */

const $ = (id) => document.getElementById(id);

function codeOf(ch) { return ch.codePointAt(0); }

function displayChar(ch) {
  if (ch === ' ') return '␣';
  if (ch === '\n') return '↵';
  return ch;
}

function isCJK(ch) {
  return /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function isBlankImage(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

function baseName(name) {
  return name.split(/[\\/]/).pop();
}

// 从文件名推断字符：A.png → A；U+4E2D.png → 中；space.png → 空格
function charFromFileName(name) {
  const stem = baseName(name).replace(/\.[^.]+$/, '');
  const m = /^U\+([0-9A-Fa-f]{4,6})$/.exec(stem);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (stem.toLowerCase() === 'space') return ' ';
  if ([...stem].length === 1) return stem;
  return null;
}

/* ================= 诊断 ================= */

function diag(level, text) { state.diagnostics.push({ level, text }); }

function renderDiagnostics() {
  const ul = $('diagnostics');
  ul.innerHTML = '';
  if (!state.diagnostics.length) {
    ul.innerHTML = '<li class="ok">未发现问题</li>';
    return;
  }
  for (const d of state.diagnostics) {
    const li = document.createElement('li');
    li.className = d.level;
    li.textContent = d.text;
    ul.appendChild(li);
  }
}

/* ================= 导入 ================= */

async function parseMappingFile(file) {
  const text = await file.text();
  const entries = []; // {char, file}
  if (file.name.endsWith('.json')) {
    const obj = JSON.parse(text);
    for (const [char, f] of Object.entries(obj)) entries.push({ char, file: String(f) });
  } else {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf(',');
      if (idx < 0) continue;
      const char = line.slice(0, idx).trim();
      const f = line.slice(idx + 1).trim();
      if (char && f) entries.push({ char, file: f });
    }
  }
  return entries;
}

// 待导入的图片缓存：fileName -> {dataUrl, img}
const imagePool = new Map();
let mappingEntries = null; // null 表示未提供映射表

async function importImages(files) {
  for (const file of files) {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('读取失败: ' + file.name));
      r.readAsDataURL(file);
    });
    const img = await loadImage(dataUrl);
    imagePool.set(baseName(file.name), { dataUrl, img });
  }
  rebuildGlyphs();
}

function makeGlyph(char, fileName, dataUrl, img) {
  const blank = isBlankImage(img);
  return {
    char, code: codeOf(char), fileName, dataUrl, img,
    w: img.naturalWidth, h: img.naturalHeight, blank,
    padding: 1,
    baseline: img.naturalHeight, // 默认字形底边贴基线
    advance: img.naturalWidth,
  };
}

function rebuildGlyphs() {
  state.diagnostics = [];
  const prev = state.glyphs;
  const next = new Map();
  const usedFiles = new Map(); // fileName -> [char,...]

  const adopt = (char, fileName, source) => {
    const rec = imagePool.get(fileName);
    if (!rec) return false;
    if (next.has(char)) {
      diag('err', `重复映射：字符 "${displayChar(char)}" 被多次映射（来源 ${fileName}），已保留先出现的`);
      return true;
    }
    const old = prev.get(char);
    const g = (old && old.fileName === fileName) ? old : makeGlyph(char, fileName, rec.dataUrl, rec.img);
    next.set(char, g);
    (usedFiles.get(fileName) || usedFiles.set(fileName, []).get(fileName)).push(char);
    return true;
  };

  if (mappingEntries) {
    // 按映射表解析
    for (const { char, file } of mappingEntries) {
      const f = baseName(file);
      if (!imagePool.has(f)) {
        diag('err', `缺字：映射表要求字符 "${displayChar(char)}" → ${f}，但未导入该图片`);
        continue;
      }
      adopt(char, f, 'mapping');
    }
    // 映射表之外的图片：尝试按文件名推断
    const mappedFiles = new Set(mappingEntries.map((e) => baseName(e.file)));
    for (const fileName of imagePool.keys()) {
      if (mappedFiles.has(fileName)) continue;
      const char = charFromFileName(fileName);
      if (char === null) {
        diag('warn', `未映射文件：${fileName}（不在映射表中，且无法从文件名推断字符）`);
        continue;
      }
      adopt(char, fileName, 'filename');
    }
  } else {
    // 无映射表：全部按文件名推断
    for (const fileName of imagePool.keys()) {
      const char = charFromFileName(fileName);
      if (char === null) {
        diag('warn', `未映射文件：${fileName}（文件名应为 A.png / U+4E2D.png / space.png 形式）`);
        continue;
      }
      adopt(char, fileName, 'filename');
    }
  }

  // 一图多字
  for (const [fileName, chars] of usedFiles) {
    if (chars.length > 1) {
      diag('warn', `重复映射：图片 ${fileName} 同时映射到 ${chars.map(displayChar).join('、')}`);
    }
  }
  // 空白字形
  for (const g of next.values()) {
    if (g.blank) {
      if (g.char === ' ') diag('ok', `空白字形：空格（${g.fileName}）为透明图，属预期`);
      else diag('warn', `空白字形：字符 "${displayChar(g.char)}"（${g.fileName}）完全透明`);
    }
  }
  if (!next.size && !state.diagnostics.length) {
    diag('ok', '尚未导入任何文件');
  }

  state.glyphs = next;
  refreshAll();
}

/* ================= 字形表 ================= */

function renderGlyphTable() {
  const tbody = $('glyphTable').querySelector('tbody');
  tbody.innerHTML = '';
  const glyphs = [...state.glyphs.values()].sort((a, b) => a.code - b.code);
  for (const g of glyphs) {
    const tr = document.createElement('tr');

    const tdChar = document.createElement('td');
    tdChar.className = 'char-cell';
    tdChar.textContent = displayChar(g.char);
    tdChar.title = `U+${g.code.toString(16).toUpperCase().padStart(4, '0')}`;
    tr.appendChild(tdChar);

    const tdThumb = document.createElement('td');
    const cv = document.createElement('canvas');
    cv.className = 'glyph-thumb';
    cv.width = g.w; cv.height = g.h;
    cv.style.maxWidth = '48px'; cv.style.maxHeight = '48px';
    cv.getContext('2d').drawImage(g.img, 0, 0);
    tdThumb.appendChild(cv);
    if (g.blank) {
      const flag = document.createElement('div');
      flag.className = 'blank-flag';
      flag.textContent = '空白';
      tdThumb.appendChild(flag);
    }
    tr.appendChild(tdThumb);

    const tdSize = document.createElement('td');
    tdSize.textContent = `${g.w}×${g.h}`;
    tr.appendChild(tdSize);

    for (const [key, min] of [['padding', 0], ['baseline', 0], ['advance', 1]]) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number'; input.min = min; input.step = 1;
      input.value = g[key];
      input.addEventListener('change', () => {
        g[key] = Math.max(min, Math.round(Number(input.value) || 0));
        input.value = g[key];
        if (key === 'padding') repack();
        renderPreview();
        renderAtlas();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    const tdSrc = document.createElement('td');
    tdSrc.textContent = g.fileName;
    tr.appendChild(tdSrc);

    tbody.appendChild(tr);
  }
}

/* ================= 排版预览 ================= */

function advanceOf(ch) {
  const g = state.glyphs.get(ch);
  return g ? g.advance : state.settings.fallbackAdvance;
}

// 单元宽度 = 前进宽度 + 字符间距（测量与渲染共用，保证一致）
function cellW(ch) {
  return advanceOf(ch) + state.settings.charSpacing;
}

function tokenize(text) {
  const tokens = [];
  let buf = '', w = 0;
  const flush = () => {
    if (buf) { tokens.push({ text: buf, width: w, kind: 'word' }); buf = ''; w = 0; }
  };
  for (const ch of text) {
    if (ch === '\n') { flush(); tokens.push({ kind: 'newline' }); }
    else if (ch === ' ') { flush(); tokens.push({ text: ' ', width: cellW(' '), kind: 'space' }); }
    else if (isCJK(ch)) { flush(); tokens.push({ text: ch, width: cellW(ch), kind: 'cjk' }); }
    else { buf += ch; w += cellW(ch); }
  }
  flush();
  return tokens;
}

// 贪心换行：空格与中日韩字符为断点；超长单词按字硬拆
function layoutText(text, maxWidth) {
  const lines = [];
  let cur = { tokens: [], width: 0 };
  const newline = () => { lines.push(cur); cur = { tokens: [], width: 0 }; };
  for (const t of tokenize(text)) {
    if (t.kind === 'newline') { newline(); continue; }
    if (cur.tokens.length && cur.width + t.width > maxWidth) {
      newline();
      if (t.kind === 'space') continue; // 丢弃行首空格
    }
    if (t.kind === 'word' && t.width > maxWidth) {
      for (const ch of t.text) {
        const w = cellW(ch);
        if (cur.tokens.length && cur.width + w > maxWidth) newline();
        cur.tokens.push({ text: ch, width: w, kind: 'char' });
        cur.width += w;
      }
      continue;
    }
    cur.tokens.push(t);
    cur.width += t.width;
  }
  newline();
  return lines;
}

function renderPreview() {
  const text = $('previewText').value;
  const maxWidth = Math.max(20, state.previewWidth);
  const { lineHeight, baseline } = state.settings;
  const lines = layoutText(text, maxWidth);

  const cv = $('previewCanvas');
  const dpr = window.devicePixelRatio || 1;
  const height = Math.max(lineHeight, lines.length * lineHeight);
  cv.width = maxWidth * dpr;
  cv.height = height * dpr;
  cv.style.width = maxWidth + 'px';
  cv.style.height = height + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, maxWidth, height);

  if (state.showGuides) {
    ctx.strokeStyle = 'rgba(120,150,200,0.25)';
    for (let i = 0; i < lines.length; i++) {
      const top = i * lineHeight, base = top + baseline;
      ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(maxWidth, top + 0.5); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,120,120,0.45)';
      ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(maxWidth, base + 0.5); ctx.stroke();
      ctx.strokeStyle = 'rgba(120,150,200,0.25)';
    }
  }

  lines.forEach((line, li) => {
    const top = li * lineHeight;
    let penX = 0;
    for (const t of line.tokens) {
      for (const ch of t.text) {
        const g = state.glyphs.get(ch);
        if (g && !g.blank) {
          ctx.drawImage(g.img, penX, top + baseline - g.baseline);
        } else if (!g && ch !== ' ') {
          // 缺字占位
          ctx.strokeStyle = '#e05555';
          ctx.strokeRect(penX + 0.5, top + baseline - lineHeight * 0.7 + 0.5,
            state.settings.fallbackAdvance - 2, lineHeight * 0.7);
          ctx.fillStyle = '#e05555';
          ctx.font = '10px monospace';
          ctx.fillText('?', penX + state.settings.fallbackAdvance / 2 - 3, top + baseline - 4);
        }
        penX += cellW(ch);
      }
    }
  });
}

/* ================= 图集排布 ================= */

// 架式（shelf）排布：按高度降序，确定性结果；只写位置，不动度量
function packGlyphs(size) {
  const edge = state.settings.edgePadding;
  const cells = [...state.glyphs.values()]
    .map((g) => ({ char: g.char, w: g.w + g.padding * 2, h: g.h + g.padding * 2 }))
    .sort((a, b) => b.h - a.h || b.w - a.w || codeOf(a.char) - codeOf(b.char));

  const placements = new Map();
  const unplaced = [];
  let x = edge, y = edge, shelfH = 0;
  const limit = size - edge;

  for (const c of cells) {
    if (c.w > limit - edge || c.h > limit - edge) { unplaced.push(c.char); continue; }
    if (x + c.w > limit) {
      x = edge; y += shelfH + GUTTER; shelfH = 0;
    }
    if (y + c.h > limit) { unplaced.push(c.char); continue; }
    placements.set(c.char, { x, y, w: c.w, h: c.h });
    x += c.w + GUTTER;
    shelfH = Math.max(shelfH, c.h);
  }

  const usedArea = cells.filter((c) => placements.has(c.char))
    .reduce((s, c) => s + c.w * c.h, 0);
  return { size, placements, unplaced, occupancy: usedArea / (size * size) };
}

function repack() {
  state.packing = packGlyphs(state.settings.atlasSize);
}

function renderAtlas() {
  if (!state.packing || state.packing.size !== state.settings.atlasSize) repack();
  const p = state.packing;
  const cv = $('atlasCanvas');
  const size = p.size;
  const scale = Math.min(1, 560 / size);
  cv.width = size * scale; cv.height = size * scale;
  cv.style.width = size * scale + 'px';
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = false;

  for (const g of state.glyphs.values()) {
    const pl = p.placements.get(g.char);
    if (!pl) continue;
    ctx.drawImage(g.img, pl.x + g.padding, pl.y + g.padding);
    ctx.strokeStyle = 'rgba(110,160,255,0.35)';
    ctx.strokeRect(pl.x + 0.5, pl.y + 0.5, pl.w - 1, pl.h - 1);
  }
  ctx.restore();

  $('packStatus').textContent =
    `已排入 ${p.placements.size}/${state.glyphs.size} 个字形，占用率 ${(p.occupancy * 100).toFixed(1)}%`;

  const div = $('unplacedList');
  if (p.unplaced.length) {
    div.textContent = '无法放入的字形：' +
      p.unplaced.map((ch) => `"${displayChar(ch)}"（${state.glyphs.get(ch).fileName}）`).join('、');
  } else {
    div.textContent = '';
  }

  renderSizeTable();
}

function renderSizeTable() {
  const tbody = $('sizeTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const size of ATLAS_SIZES) {
    const p = packGlyphs(size);
    const tr = document.createElement('tr');
    if (size === state.settings.atlasSize) tr.className = 'current';
    for (const text of [
      `${size}×${size}`,
      (p.occupancy * 100).toFixed(1) + '%',
      p.unplaced.length ? `${p.unplaced.length} 个` : '无',
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => {
      state.settings.atlasSize = size;
      $('atlasSize').value = String(size);
      repack();
      renderAtlas();
    });
    tbody.appendChild(tr);
  }
}

/* ================= 导出 ================= */

function metricsData() {
  const p = state.packing;
  const s = state.settings;
  const chars = [...state.glyphs.values()]
    .sort((a, b) => a.code - b.code)
    .map((g) => {
      const pl = p.placements.get(g.char);
      return {
        id: g.code,
        char: g.char,
        x: pl ? pl.x + g.padding : -1,
        y: pl ? pl.y + g.padding : -1,
        width: g.w,
        height: g.h,
        xoffset: 0,
        yoffset: s.baseline - g.baseline, // 行顶到字形顶端的距离
        xadvance: g.advance,
        padding: g.padding,
        placed: Boolean(pl),
        source: g.fileName,
      };
    });
  return {
    info: { face: state.projectName, size: s.lineHeight },
    common: {
      lineHeight: s.lineHeight,
      base: s.baseline,
      scaleW: p.size,
      scaleH: p.size,
      pages: 1,
      charSpacing: s.charSpacing,
    },
    chars,
  };
}

function exportAtlas() {
  if (!state.packing) repack();
  const p = state.packing;
  const cv = document.createElement('canvas');
  cv.width = p.size; cv.height = p.size;
  const ctx = cv.getContext('2d');
  for (const g of state.glyphs.values()) {
    const pl = p.placements.get(g.char);
    if (pl) ctx.drawImage(g.img, pl.x + g.padding, pl.y + g.padding);
  }
  cv.toBlob((blob) => download(blob, `${state.projectName}-atlas-${p.size}.png`), 'image/png');
}

function exportMetrics() {
  const json = JSON.stringify(metricsData(), null, 2);
  download(new Blob([json], { type: 'application/json' }), `${state.projectName}-metrics.json`);
}

function exportFnt() {
  const m = metricsData();
  const placed = m.chars.filter((c) => c.placed);
  const lines = [
    `info face="${m.info.face}" size=${m.info.size}`,
    `common lineHeight=${m.common.lineHeight} base=${m.common.base} scaleW=${m.common.scaleW} scaleH=${m.common.scaleH} pages=1`,
    `page id=0 file="${state.projectName}-atlas-${m.common.scaleW}.png"`,
    `chars count=${placed.length}`,
    ...placed.map((c) =>
      `char id=${c.id} x=${c.x} y=${c.y} width=${c.width} height=${c.height} ` +
      `xoffset=${c.xoffset} yoffset=${c.yoffset} xadvance=${c.xadvance} page=0`),
  ];
  download(new Blob([lines.join('\n')], { type: 'text/plain' }), `${state.projectName}.fnt`);
}

/* ================= 工程保存 / 导入 ================= */

function saveProject() {
  const data = {
    version: 1,
    projectName: state.projectName,
    settings: state.settings,
    previewText: $('previewText').value,
    previewWidth: state.previewWidth,
    mapping: mappingEntries,
    glyphs: [...state.glyphs.values()].map((g) => ({
      char: g.char, fileName: g.fileName, dataUrl: g.dataUrl,
      padding: g.padding, baseline: g.baseline, advance: g.advance,
    })),
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }),
    `${state.projectName}.bfproj.json`);
}

async function loadProject(file) {
  const data = JSON.parse(await file.text());
  state.projectName = data.projectName || '未命名字体';
  Object.assign(state.settings, data.settings || {});
  mappingEntries = data.mapping || null;
  imagePool.clear();
  state.glyphs = new Map();
  state.diagnostics = [];

  for (const rec of data.glyphs || []) {
    const img = await loadImage(rec.dataUrl);
    imagePool.set(rec.fileName, { dataUrl: rec.dataUrl, img });
    const g = makeGlyph(rec.char, rec.fileName, rec.dataUrl, img);
    g.padding = rec.padding ?? g.padding;
    g.baseline = rec.baseline ?? g.baseline;
    g.advance = rec.advance ?? g.advance;
    state.glyphs.set(rec.char, g);
  }
  $('projectName').value = state.projectName;
  $('previewText').value = data.previewText ?? $('previewText').value;
  state.previewWidth = data.previewWidth ?? state.previewWidth;
  $('previewWidth').value = state.previewWidth;
  syncSettingsInputs();
  diag('ok', `已导入工程「${state.projectName}」：${state.glyphs.size} 个字形，可继续修改`);
  repack();
  refreshAll();
}

/* ================= 刷新与事件 ================= */

function refreshAll() {
  renderDiagnostics();
  renderGlyphTable();
  repack();
  renderPreview();
  renderAtlas();
}

function syncSettingsInputs() {
  $('setCharSpacing').value = state.settings.charSpacing;
  $('setLineHeight').value = state.settings.lineHeight;
  $('setBaseline').value = state.settings.baseline;
  $('setFallbackAdvance').value = state.settings.fallbackAdvance;
  $('setEdgePadding').value = state.settings.edgePadding;
  $('atlasSize').value = String(state.settings.atlasSize);
}

function bindNumber(id, get, set, after) {
  $(id).addEventListener('change', () => {
    set(Math.round(Number($(id).value) || 0));
    $(id).value = get();
    after();
  });
}

function init() {
  const sizeSel = $('atlasSize');
  for (const s of ATLAS_SIZES) {
    const opt = document.createElement('option');
    opt.value = String(s); opt.textContent = `${s}×${s}`;
    sizeSel.appendChild(opt);
  }
  syncSettingsInputs();

  $('projectName').addEventListener('change', () => {
    state.projectName = $('projectName').value.trim() || '未命名字体';
    $('projectName').value = state.projectName;
  });

  $('btnImportMapping').addEventListener('click', () => $('fileMapping').click());
  $('fileMapping').addEventListener('change', async (e) => {
    if (e.target.files[0]) mappingEntries = await parseMappingFile(e.target.files[0]);
    rebuildGlyphs();
    e.target.value = '';
  });
  $('btnImportImages').addEventListener('click', () => $('fileImages').click());
  $('fileImages').addEventListener('change', async (e) => {
    await importImages([...e.target.files]);
    e.target.value = '';
  });

  bindNumber('setCharSpacing', () => state.settings.charSpacing,
    (v) => { state.settings.charSpacing = v; }, renderPreview);
  bindNumber('setLineHeight', () => state.settings.lineHeight,
    (v) => { state.settings.lineHeight = Math.max(1, v); }, renderPreview);
  bindNumber('setBaseline', () => state.settings.baseline,
    (v) => { state.settings.baseline = v; }, renderPreview);
  bindNumber('setFallbackAdvance', () => state.settings.fallbackAdvance,
    (v) => { state.settings.fallbackAdvance = Math.max(1, v); }, renderPreview);
  bindNumber('setEdgePadding', () => state.settings.edgePadding,
    (v) => { state.settings.edgePadding = Math.max(0, v); }, renderAtlas);
  bindNumber('previewWidth', () => state.previewWidth,
    (v) => { state.previewWidth = Math.max(20, v); }, renderPreview);

  $('atlasSize').addEventListener('change', () => {
    state.settings.atlasSize = Number($('atlasSize').value);
    repack();
    renderAtlas();
  });
  $('btnRepack').addEventListener('click', () => { repack(); renderAtlas(); });
  $('previewText').addEventListener('input', renderPreview);
  $('showGuides').addEventListener('change', () => {
    state.showGuides = $('showGuides').checked;
    renderPreview();
  });

  $('btnExportAtlas').addEventListener('click', exportAtlas);
  $('btnExportMetrics').addEventListener('click', exportMetrics);
  $('btnExportFnt').addEventListener('click', exportFnt);
  $('btnSaveProject').addEventListener('click', saveProject);
  $('btnLoadProject').addEventListener('click', () => $('fileProject').click());
  $('fileProject').addEventListener('change', async (e) => {
    if (e.target.files[0]) await loadProject(e.target.files[0]);
    e.target.value = '';
  });

  refreshAll();
}

init();
