import './styles.css';
import {
  ArcLengthCurve,
  CanvasTextMeasurer,
  CONFIG_STORAGE_KEY,
  MAC_LOCAL_FONT_STACKS,
  buildSvg,
  cloneConfig,
  createDefaultConfig,
  extractEmbeddedConfig,
  layoutText,
  normalizeConfig,
  curveToSvgPath,
  type Point,
  type PresetName,
  type ToolConfig,
} from './core';

const $ = <T extends Element = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
};

const stage = $<SVGSVGElement>('stage');
const textInput = $<HTMLTextAreaElement>('text-input');
const fontFamilyInput = $<HTMLSelectElement>('font-family');
const fontSizeInput = $<HTMLInputElement>('font-size');
const fontSizeValue = $('font-size-value');
const fontWeightInput = $<HTMLSelectElement>('font-weight');
const fontStyleInput = $<HTMLSelectElement>('font-style');
const letterSpacingInput = $<HTMLInputElement>('letter-spacing');
const letterSpacingValue = $('letter-spacing-value');
const startDistanceInput = $<HTMLInputElement>('start-distance');
const startValue = $('start-value');
const forwardButton = $<HTMLButtonElement>('direction-forward');
const backwardButton = $<HTMLButtonElement>('direction-backward');
const uprightInput = $<HTMLInputElement>('orientation-upright');
const avoidOverlapInput = $<HTMLInputElement>('avoid-overlap');
const clearanceInput = $<HTMLInputElement>('overlap-clearance');
const clearanceValue = $('clearance-value');
const fitModeInput = $<HTMLSelectElement>('fit-mode');
const minFontInput = $<HTMLInputElement>('min-font-size');
const minFontValue = $('min-font-value');
const paddingInput = $<HTMLInputElement>('end-padding');
const paddingValue = $('padding-value');
const showBoundsInput = $<HTMLInputElement>('show-bounds');
const closedInput = $<HTMLInputElement>('curve-closed');
const tensionInput = $<HTMLInputElement>('tension');
const tensionValue = $('tension-value');
const deleteAnchorButton = $<HTMLButtonElement>('delete-anchor');
const exportSvgButton = $<HTMLButtonElement>('export-svg');
const statusBadge = $('status-badge');
const statusText = $('status-text');
const reportPanel = $('report-panel');
const toastElement = $('toast');
const fileInput = $<HTMLInputElement>('file-input');

const measurer = new CanvasTextMeasurer();

function loadInitialConfig(): ToolConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) return normalizeConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    console.warn('无法恢复本地配置', error);
  }
  return createDefaultConfig('inflection');
}

let config = loadInitialConfig();
let currentPreset: PresetName = 'inflection';
let curve = ArcLengthCurve.fromAnchors(config.curve);
let layout = layoutText(config, measurer, curve);
let selectedAnchor: number | null = null;
let drag: { kind: 'anchor'; index: number } | { kind: 'start' } | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function displayGrapheme(value: string): string {
  if (/^\s+$/u.test(value)) return '␠';
  return value;
}

function f(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function toast(message: string): void {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 3200);
}

function saveConfig(): void {
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn('配置保存失败', error);
  }
}

function recompute(): void {
  curve = ArcLengthCurve.fromAnchors(config.curve);
  config.layout.startDistance = Math.min(
    curve.length,
    Math.max(0, config.layout.startDistance),
  );
  layout = layoutText(config, measurer, curve);
}

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function populateFonts(): void {
  fontFamilyInput.innerHTML = MAC_LOCAL_FONT_STACKS.map(
    (font) => `<option value="${escapeHtml(font.family)}">${escapeHtml(font.label)}</option>`,
  ).join('');
  if (![...fontFamilyInput.options].some((option) => option.value === config.font.family)) {
    const option = document.createElement('option');
    option.value = config.font.family;
    option.textContent = `当前：${config.font.family.split(',')[0]}`;
    fontFamilyInput.prepend(option);
  }
}

function syncForm(): void {
  textInput.value = config.text;
  fontFamilyInput.value = config.font.family;
  fontSizeInput.value = String(config.font.size);
  fontSizeValue.textContent = `${config.font.size}px`;
  fontWeightInput.value = String(config.font.weight);
  fontStyleInput.value = config.font.style;
  letterSpacingInput.value = String(config.layout.letterSpacing);
  letterSpacingValue.textContent = `${config.layout.letterSpacing}px`;
  startDistanceInput.max = String(curve.length);
  startDistanceInput.value = String(config.layout.startDistance);
  startValue.textContent = `${f(config.layout.startDistance)} / ${f(curve.length)}`;
  uprightInput.checked = config.layout.orientation === 'upright';
  avoidOverlapInput.checked = config.layout.avoidOverlap;
  clearanceInput.value = String(config.layout.overlapClearance);
  clearanceValue.textContent = `${config.layout.overlapClearance}px`;
  fitModeInput.value = config.layout.fit;
  minFontInput.value = String(config.layout.minFontSize);
  minFontValue.textContent = `${config.layout.minFontSize}px`;
  minFontInput.disabled = config.layout.fit !== 'shrink';
  paddingInput.value = String(config.layout.endPadding);
  paddingValue.textContent = `${config.layout.endPadding}px`;
  showBoundsInput.checked = config.layout.showBounds;
  closedInput.checked = config.curve.closed;
  tensionInput.value = String(config.curve.tension ?? 1 / 6);
  tensionValue.textContent = Number(config.curve.tension ?? 1 / 6).toFixed(2);
  forwardButton.classList.toggle('active', config.layout.direction === 'forward');
  backwardButton.classList.toggle('active', config.layout.direction === 'backward');
  deleteAnchorButton.disabled = selectedAnchor === null;
}

function stageTemplate(): string {
  const { width, height, background } = config.canvas;
  const pathD = curveToSvgPath(config.curve);
  const roadWidth = Math.max(34, config.font.size * 1.45);
  const shownGlyphs = layout.status === 'rejected' ? layout.glyphs : layout.placedGlyphs;

  const guides = shownGlyphs
    .map((glyph) => {
      let color: string | null = null;
      if (layout.status === 'rejected' && !glyph.withinLimit) color = '#dc2626';
      else if (layout.limitGlyphIndexes.includes(glyph.index) || !glyph.withinLimit)
        color = '#dc2626';
      else if (layout.seamGlyphIndexes.includes(glyph.index)) color = '#7c3aed';
      else if (glyph.collidesWith.length > 0) color = '#ea580c';
      else if (config.layout.showBounds) color = '#0284c7';

      if (!color) return '';
      const points = glyph.corners.map((p) => `${f(p.x, 2)},${f(p.y, 2)}`).join(' ');
      return `<polygon points="${points}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="1.8" pointer-events="none"/>`;
    })
    .join('');

  const glyphs = shownGlyphs
    .map((glyph) => {
      const transform = `translate(${f(glyph.position.x, 2)} ${f(glyph.position.y, 2)}) rotate(${f(
        glyph.angleDeg,
        2,
      )})`;
      const spaceDot =
        glyph.grapheme.trim().length === 0
          ? `<circle class="space-dot" cx="0" cy="${f(-glyph.fontSize * 0.36, 2)}" r="2.4"/>`
          : '';
      return `<g transform="${transform}">
        ${spaceDot}
        <text class="stage-glyph ${layout.status === 'rejected' ? 'rejected' : ''}"
          text-anchor="middle" dominant-baseline="alphabetic" xml:space="preserve"
          font-family="${escapeHtml(config.font.family)}"
          font-size="${f(glyph.fontSize, 2)}"
          font-weight="${config.font.weight}"
          font-style="${config.font.style}"
          fill="#172033">${escapeHtml(glyph.grapheme)}</text>
      </g>`;
    })
    .join('');

  const anchors = config.curve.anchors
    .map(
      (point, index) =>
        `<circle class="anchor-handle ${selectedAnchor === index ? 'selected' : ''}" data-anchor-index="${index}" cx="${f(
          point.x,
        )}" cy="${f(point.y)}" r="${selectedAnchor === index ? 9 : 7}"><title>拖动锚点 ${index + 1}，双击删除</title></circle>`,
    )
    .join('');

  const startFrame = curve.frameAt(config.layout.startDistance);
  const seam = config.curve.closed
    ? (() => {
        const p = curve.frameAt(0).point;
        return `<rect class="seam-handle" x="${f(p.x - 7)}" y="${f(p.y - 7)}" width="14" height="14" rx="3" transform="rotate(45 ${f(
          p.x,
        )} ${f(p.y)})"><title>封闭接缝（弧长 0 = ${f(curve.length)}）</title></rect>`;
      })()
    : [0, curve.length]
        .map((distance) => {
          const p = curve.frameAt(distance).point;
          return `<circle class="endpoint-handle" cx="${f(p.x)}" cy="${f(p.y)}" r="5"><title>路径端点 ${f(
            distance,
          )}</title></circle>`;
        })
        .join('');

  return `
  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}" rx="14"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${pathD}" stroke="#334155" stroke-width="${f(roadWidth + 8)}"/>
    <path d="${pathD}" stroke="#f8fafc" stroke-width="${f(roadWidth)}"/>
    <path d="${pathD}" stroke="#f59e0b" stroke-width="3" stroke-dasharray="18 16" opacity="0.9"/>
  </g>
  <path d="${pathD}" fill="none" stroke="#2563eb" stroke-width="2" stroke-dasharray="7 7" opacity="0.8"/>
  ${guides}
  <g>${glyphs}</g>
  ${seam}
  ${anchors}
  <circle class="start-handle" data-start-handle="true" cx="${f(startFrame.point.x)}" cy="${f(
    startFrame.point.y,
  )}" r="10"><title>排字起点：弧长 ${f(config.layout.startDistance)}</title></circle>`;
}

function charChips(indexes: number[], kind: 'limit' | 'seam' | 'collision'): string {
  if (indexes.length === 0) return '<span class="hint">无</span>';
  return `<div class="char-list">${indexes
    .map((index) => {
      const glyph = layout.glyphs[index];
      if (!glyph) return '';
      return `<span class="char-chip ${kind}" title="第 ${index + 1} 字 · 弧长 ${f(
        glyph.pathDistance,
      )}">${escapeHtml(displayGrapheme(glyph.grapheme))}</span>`;
    })
    .join('')}</div>`;
}

function renderReport(): void {
  const report = layout.report;
  const boundaryIndexes = layout.glyphs
    .filter(
      (glyph) =>
        !glyph.withinLimit ||
        glyph.touchesLimit ||
        glyph.touchesPathStart ||
        glyph.touchesPathEnd,
    )
    .map((glyph) => glyph.index);
  const collisionIndexes = [...new Set(layout.collisions.flat())];

  const endpointRow =
    report.endpointMargin === null
      ? `<div><span>正向到接缝</span><b>${f(report.seamForwardDistance ?? 0)}</b></div>
         <div><span>反向到接缝</span><b>${f(report.seamBackwardDistance ?? 0)}</b></div>`
      : `<div><span>末端到端点</span><b>${f(report.endpointMargin)}</b></div>
         <div><span>起点到 d=0</span><b>${f(report.startDistance)}</b></div>`;

  reportPanel.innerHTML = `
    <div class="report-grid">
      <div class="metric"><span>曲线总长</span><strong>${f(report.pathLength)}</strong></div>
      <div class="metric"><span>起点弧长 / 模长</span><strong>${f(report.startDistance)} / ${f(
        report.startWrapped,
      )}</strong></div>
      <div class="metric"><span>末字结束 / 展开距离</span><strong>${f(
        report.endWrappedDistance,
      )} / ${f(report.endUnwrappedDistance)}</strong></div>
      <div class="metric"><span>已用 / 可用长度</span><strong>${f(report.requiredLength)} / ${f(
        report.availableLength,
      )}</strong></div>
      <div class="metric"><span>实际字号 / 缩放</span><strong>${f(report.fontSize)}px · ${f(
        report.scale * 100,
      )}%</strong></div>
      <div class="metric"><span>自然字宽总长</span><strong>${f(report.naturalLength)}</strong></div>
      <div class="metric"><span>末端空余</span><strong>${f(report.unusedLength)}</strong></div>
      <div class="metric"><span>字数 / 碰撞对</span><strong>${layout.glyphs.length} · ${
        layout.collisions.length
      }</strong></div>
    </div>
    <div class="report-details">
      <div>
        <h3>可检查的起止距离（SVG 根节点也有 data-*）</h3>
        <div class="kv">
          <span>起点弧长</span><b>${f(report.startDistance)}</b>
          <span>末字结束（闭合取模）</span><b>${f(report.endWrappedDistance)}</b>
          <span>末字结束（跨缝展开）</span><b>${f(report.endUnwrappedDistance)}</b>
          ${endpointRow}
        </div>
      </div>
      <div>
        <h3>触及界限/端点的字</h3>
        ${charChips([...new Set(boundaryIndexes)], 'limit')}
        <h3 style="margin-top:10px">接缝字</h3>
        ${charChips(layout.seamGlyphIndexes, 'seam')}
      </div>
      <div>
        <h3>仍有碰撞的字</h3>
        ${charChips(collisionIndexes, 'collision')}
        <p class="hint">红框=界限/超出，紫框=跨接缝，橙框=碰撞。空格显示为蓝点和 ␠ 标记。</p>
      </div>
    </div>`;
}

function renderStage(): void {
  stage.setAttribute('viewBox', `0 0 ${config.canvas.width} ${config.canvas.height}`);
  stage.style.setProperty('--bg', config.canvas.background);
  stage.innerHTML = stageTemplate();
}

function renderStatus(): void {
  statusBadge.className = `badge ${layout.status}`;
  if (layout.status === 'ready') {
    statusBadge.textContent = '可导出';
    statusText.textContent = `已按本机字体的自身字宽排入 ${layout.placedGlyphs.length} 个字，末端空余 ${f(
      layout.report.unusedLength,
    )}。`;
  } else if (layout.status === 'shrunk') {
    statusBadge.textContent = '已缩字号';
    statusText.textContent = `原字号排不下，已缩到 ${f(layout.report.fontSize)}px（${f(
      layout.report.scale * 100,
    )}%），没有丢字。`;
  } else if (layout.status === 'rejected') {
    statusBadge.textContent = '已拒绝排入';
    statusText.textContent = layout.rejectionReason ?? '路径长度不足。红色虚影仅作定位诊断，不会导出。';
  } else {
    statusBadge.textContent = '没有文字';
    statusText.textContent = '请输入中文、带重音字母或空格。';
  }
  exportSvgButton.disabled = !layout.accepted;
  exportSvgButton.title = layout.accepted ? '导出包含路径和逐字定位的 SVG' : layout.rejectionReason ?? '';
}

function renderAll(): void {
  recompute();
  syncForm();
  renderStage();
  renderReport();
  renderStatus();
  saveConfig();
}

function refreshAfterControlInput(): void {
  recompute();
  renderStage();
  renderReport();
  renderStatus();
  syncFormReadouts();
  saveConfig();
}

function syncFormReadouts(): void {
  fontSizeValue.textContent = `${config.font.size}px`;
  letterSpacingValue.textContent = `${config.layout.letterSpacing}px`;
  startDistanceInput.max = String(curve.length);
  startDistanceInput.value = String(config.layout.startDistance);
  startValue.textContent = `${f(config.layout.startDistance)} / ${f(curve.length)}`;
  clearanceValue.textContent = `${config.layout.overlapClearance}px`;
  minFontValue.textContent = `${config.layout.minFontSize}px`;
  paddingValue.textContent = `${config.layout.endPadding}px`;
  tensionValue.textContent = Number(config.curve.tension ?? 1 / 6).toFixed(2);
  forwardButton.classList.toggle('active', config.layout.direction === 'forward');
  backwardButton.classList.toggle('active', config.layout.direction === 'backward');
  minFontInput.disabled = config.layout.fit !== 'shrink';
  deleteAnchorButton.disabled = selectedAnchor === null;
}

function svgPoint(event: PointerEvent | MouseEvent): Point {
  const ctm = stage.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  return { x: point.x, y: point.y };
}

stage.addEventListener('pointerdown', (event) => {
  const target = event.target as Element;
  const anchorElement = target.closest<SVGCircleElement>('[data-anchor-index]');
  const startElement = target.closest<SVGCircleElement>('[data-start-handle]');

  if (anchorElement) {
    selectedAnchor = Number(anchorElement.dataset.anchorIndex);
    drag = { kind: 'anchor', index: selectedAnchor };
    anchorElement.setPointerCapture?.(event.pointerId);
  } else if (startElement) {
    drag = { kind: 'start' };
    startElement.setPointerCapture?.(event.pointerId);
  } else {
    selectedAnchor = null;
    drag = null;
    renderStage();
    syncFormReadouts();
    return;
  }
  event.preventDefault();
  syncFormReadouts();
});

stage.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const point = svgPoint(event);
  point.x = Math.min(config.canvas.width - 12, Math.max(12, point.x));
  point.y = Math.min(config.canvas.height - 12, Math.max(12, point.y));

  if (drag.kind === 'anchor') {
    const anchor = config.curve.anchors[drag.index];
    if (anchor) {
      anchor.x = point.x;
      anchor.y = point.y;
    }
  } else {
    config.layout.startDistance = curve.nearestDistance(point).distance;
  }

  recompute();
  renderStage();
  renderReport();
  renderStatus();
  syncFormReadouts();
});

function endDrag(): void {
  if (!drag) return;
  drag = null;
  saveConfig();
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('dblclick', (event) => {
  const target = event.target as Element;
  const anchorElement = target.closest<SVGCircleElement>('[data-anchor-index]');
  if (anchorElement) {
    const index = Number(anchorElement.dataset.anchorIndex);
    if (config.curve.anchors.length <= 2) {
      toast('至少保留两个锚点');
      return;
    }
    config.curve.anchors.splice(index, 1);
    selectedAnchor = null;
  } else {
    const point = svgPoint(event);
    config.curve.anchors.push(point);
    selectedAnchor = config.curve.anchors.length - 1;
  }
  renderAll();
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAnchor !== null && !typing) {
    if (config.curve.anchors.length <= 2) {
      toast('至少保留两个锚点');
      return;
    }
    config.curve.anchors.splice(selectedAnchor, 1);
    selectedAnchor = null;
    renderAll();
  }
});

textInput.addEventListener('input', () => {
  config.text = textInput.value;
  refreshAfterControlInput();
});

fontFamilyInput.addEventListener('change', () => {
  config.font.family = fontFamilyInput.value;
  renderAll();
});
fontSizeInput.addEventListener('input', () => {
  config.font.size = Number(fontSizeInput.value);
  refreshAfterControlInput();
});
fontWeightInput.addEventListener('change', () => {
  config.font.weight = Number(fontWeightInput.value);
  renderAll();
});
fontStyleInput.addEventListener('change', () => {
  config.font.style = fontStyleInput.value === 'italic' ? 'italic' : 'normal';
  renderAll();
});
letterSpacingInput.addEventListener('input', () => {
  config.layout.letterSpacing = Number(letterSpacingInput.value);
  refreshAfterControlInput();
});
startDistanceInput.addEventListener('input', () => {
  config.layout.startDistance = Number(startDistanceInput.value);
  refreshAfterControlInput();
});
forwardButton.addEventListener('click', () => {
  config.layout.direction = 'forward';
  renderAll();
});
backwardButton.addEventListener('click', () => {
  config.layout.direction = 'backward';
  renderAll();
});
uprightInput.addEventListener('change', () => {
  config.layout.orientation = uprightInput.checked ? 'upright' : 'path';
  renderAll();
});
avoidOverlapInput.addEventListener('change', () => {
  config.layout.avoidOverlap = avoidOverlapInput.checked;
  renderAll();
});
clearanceInput.addEventListener('input', () => {
  config.layout.overlapClearance = Number(clearanceInput.value);
  refreshAfterControlInput();
});
fitModeInput.addEventListener('change', () => {
  config.layout.fit = fitModeInput.value === 'shrink' ? 'shrink' : 'reject';
  renderAll();
});
minFontInput.addEventListener('input', () => {
  config.layout.minFontSize = Number(minFontInput.value);
  refreshAfterControlInput();
});
paddingInput.addEventListener('input', () => {
  config.layout.endPadding = Number(paddingInput.value);
  refreshAfterControlInput();
});
showBoundsInput.addEventListener('change', () => {
  config.layout.showBounds = showBoundsInput.checked;
  renderStage();
  saveConfig();
});
closedInput.addEventListener('change', () => {
  config.curve.closed = closedInput.checked;
  renderAll();
});
tensionInput.addEventListener('input', () => {
  config.curve.tension = Number(tensionInput.value);
  refreshAfterControlInput();
});
deleteAnchorButton.addEventListener('click', () => {
  if (selectedAnchor === null) return;
  config.curve.anchors.splice(selectedAnchor, 1);
  selectedAnchor = null;
  renderAll();
});

function loadPreset(name: PresetName): void {
  currentPreset = name;
  config = createDefaultConfig(name);
  const presetCurve = ArcLengthCurve.fromAnchors(config.curve);
  if (name === 'closed') config.layout.startDistance = presetCurve.length - 110;
  if (name === 'hairpin') {
    // Start on the first ascent so the default sample visibly reaches the
    // right-to-left return bend.
    config.layout.startDistance = presetCurve.length * 0.18;
    config.layout.orientation = 'upright';
  }
  selectedAnchor = null;
  renderAll();
}

$('preset-inflection').addEventListener('click', () => loadPreset('inflection'));
$('preset-hairpin').addEventListener('click', () => loadPreset('hairpin'));
$('preset-closed').addEventListener('click', () => loadPreset('closed'));
$('reset-current').addEventListener('click', () => loadPreset(currentPreset));

function loadScenario(
  name: PresetName,
  direction: 'forward' | 'backward',
  seam = false,
): void {
  currentPreset = name;
  config = createDefaultConfig(name);
  config.layout.direction = direction;
  config.layout.orientation = 'path';
  const scenarioCurve = ArcLengthCurve.fromAnchors(config.curve);

  if (name === 'closed' && seam) {
    config.layout.startDistance =
      direction === 'forward' ? scenarioCurve.length - 72 : 72;
  } else {
    config.layout.startDistance = direction === 'forward' ? 72 : scenarioCurve.length - 72;
  }
  selectedAnchor = null;
  renderAll();
  toast('已载入测试情形，可切换翻正/缩字号并导出复现配置');
}

$('test-inflection-forward').addEventListener('click', () =>
  loadScenario('inflection', 'forward'),
);
$('test-inflection-backward').addEventListener('click', () =>
  loadScenario('inflection', 'backward'),
);
$('test-closed-forward-seam').addEventListener('click', () =>
  loadScenario('closed', 'forward', true),
);
$('test-closed-backward-seam').addEventListener('click', () =>
  loadScenario('closed', 'backward', true),
);

$('export-config').addEventListener('click', () => {
  download(
    `${config.name || 'curve-text-config'}.json`.replaceAll(/[\\/:*?"<>|]/g, '_'),
    JSON.stringify(config, null, 2),
    'application/json;charset=utf-8',
  );
  toast('配置 JSON 已导出');
});

exportSvgButton.addEventListener('click', () => {
  try {
    const svg = buildSvg(config, layout, { includeGuides: config.layout.showBounds });
    download(
      `${config.name || 'curve-text'}.svg`.replaceAll(/[\\/:*?"<>|]/g, '_'),
      svg,
      'image/svg+xml;charset=utf-8',
    );
    toast('SVG 已导出，配置已嵌入 <metadata>');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'SVG 导出失败');
  }
});

$('import-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const content = await file.text();
    let raw: unknown;
    if (/<svg[\s>]/i.test(content)) {
      const embedded = extractEmbeddedConfig(content) as { config?: unknown };
      raw = embedded.config ?? embedded;
    } else {
      raw = JSON.parse(content) as unknown;
    }
    config = normalizeConfig(raw);
    selectedAnchor = null;
    renderAll();
    toast(`已重新打开配置：${config.name}`);
  } catch (error) {
    toast(`导入失败：${error instanceof Error ? error.message : '无法解析文件'}`);
  } finally {
    fileInput.value = '';
  }
});

populateFonts();
renderAll();

// Keep an explicit clone export useful for console/debug inspection.
(window as unknown as { curveTextStudio?: unknown }).curveTextStudio = {
  getConfig: () => cloneConfig(config),
  getLayout: () => layout,
};
