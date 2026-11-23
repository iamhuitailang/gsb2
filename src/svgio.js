// SVG 导入 / 导出 / PNG 栅格化。导入时把所有形状烘焙为三次贝塞尔锚点模型
import {
  Transform, parseTransform, parsePathD, rectSubpaths, lineSubpaths,
  ellipseSubpaths, transformSubpaths, n, pathToD,
} from './geometry.js';
import { createPath, createGroup, DEFAULT_STYLE, findNode } from './model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- 导出：文档 -> 独立 SVG 字符串 ----------
function styleToAttrs(style) {
  const attrs = {
    fill: style.fill,
    'fill-opacity': style.fillOpacity < 1 ? n(style.fillOpacity) : null,
    'fill-rule': style.fillRule === 'evenodd' ? 'evenodd' : null,
    stroke: style.stroke,
    'stroke-width': style.strokeWidth,
    'stroke-opacity': style.strokeOpacity < 1 ? n(style.strokeOpacity) : null,
    'stroke-linecap': style.strokeLinecap !== 'butt' ? style.strokeLinecap : null,
    'stroke-linejoin': style.strokeLinejoin !== 'miter' ? style.strokeLinejoin : null,
    opacity: style.opacity < 1 ? n(style.opacity) : null,
  };
  if (style.strokeDash && style.strokeDash !== 'none') attrs['stroke-dasharray'] = style.strokeDash;
  return Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${v}"`).join(' ');
}

function nodeToSvg(node, indent) {
  const pad = '  '.repeat(indent);
  const vis = node.visible ? '' : ' style="display:none"';
  if (node.type === 'group') {
    const body = node.children.map((c) => nodeToSvg(c, indent + 1)).join('\n');
    const lock = node.locked ? `\n${pad}  <!-- locked -->` : '';
    return `${pad}<g data-name="${escapeXml(node.name)}" data-locked="${node.locked}"${vis}>${lock}\n${body}\n${pad}</g>`;
  }
  const d = pathToD(node.subpaths);
  const lock = node.locked ? ' data-locked="true"' : '';
  return `${pad}<path data-name="${escapeXml(node.name)}"${lock} d="${d}" ${styleToAttrs(node.style)}${vis}/>`;
}

export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function docToSvgString(doc) {
  const body = doc.layers.map((nd) => nodeToSvg(nd, 1)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">\n${body}\n</svg>\n`;
}

// ---------- 导出 PNG（保持比例：按倍率或目标宽度等比缩放） ----------
export async function docToPngBlob(doc, { scale = 2, width = null, background = null } = {}) {
  const svgText = docToSvgString(doc);
  const targetW = width || Math.round(doc.width * scale);
  const targetH = width ? Math.round(width * doc.height / doc.width) : Math.round(doc.height * scale);
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('SVG 渲染失败'));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = targetW; canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 导入：SVG 文本 -> 文档图层 ----------
export function importSvg(text) {
  const warnings = [];
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'image/svg+xml');
  if (xml.querySelector('parsererror')) throw new Error('SVG 解析失败，文件不是合法 XML');
  const root = xml.documentElement;
  if (root.tagName.toLowerCase() !== 'svg') throw new Error('根元素不是 <svg>');

  const width = parseFloat(root.getAttribute('width')) || parseFloat(root.getAttribute('viewBox')?.split(/[\s,]+/)[2]) || 800;
  const height = parseFloat(root.getAttribute('height')) || parseFloat(root.getAttribute('viewBox')?.split(/[\s,]+/)[3]) || 600;
  const doc = { version: 1, width: Math.round(width), height: Math.round(height), layers: [] };

  const seenUnsupported = new Set();
  const note = (tag) => {
    if (!seenUnsupported.has(tag)) {
      seenUnsupported.add(tag);
      warnings.push(`不支持的元素 <${tag}> 已跳过（仅支持 path/rect/circle/ellipse/line/polyline/polygon/g）`);
    }
  };

  const inheritStyle = (el, parentStyle) => {
    const s = { ...DEFAULT_STYLE(), ...parentStyle };
    const read = (name, attr = name) => {
      const v = el.getAttribute(attr);
      if (v !== null) s[name] = v;
    };
    read('fill'); read('stroke');
    read('fillRule', 'fill-rule');
    read('strokeWidth', 'stroke-width');
    read('strokeLinecap', 'stroke-linecap');
    read('strokeLinejoin', 'stroke-linejoin');
    read('strokeDash', 'stroke-dasharray');
    for (const o of ['opacity', 'fillOpacity', 'strokeOpacity']) {
      const v = el.getAttribute(o.replace('O', '-o')) || el.getAttribute(o);
      if (v !== null) s[o] = parseFloat(v);
    }
    // 内联 style 属性
    const inline = el.getAttribute('style');
    if (inline) {
      for (const decl of inline.split(';')) {
        const [k, ...rest] = decl.split(':');
        if (!rest.length) continue;
        const key = k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const val = rest.join(':').trim();
        if (key in s) s[key] = key.toLowerCase().includes('opacity') ? parseFloat(val) : val;
      }
    }
    if (s.fill === 'currentColor') s.fill = '#000000';
    if (s.stroke === 'currentColor') s.stroke = '#000000';
    if (s.fillRule !== 'evenodd') s.fillRule = 'nonzero';
    s.strokeWidth = parseFloat(s.strokeWidth) || 0;
    return s;
  };

  let seq = 1;
  const convert = (el, ctm, parentStyle) => {
    const tag = el.tagName.toLowerCase();
    const t = ctm.multiply(parseTransform(el.getAttribute('transform') || ''));
    const style = inheritStyle(el, parentStyle);
    const baseName = el.getAttribute('data-name') || el.getAttribute('id') || null;

    if (tag === 'g') {
      const children = [];
      for (const child of el.children) {
        const node = convert(child, t, style);
        if (node) children.push(node);
      }
      if (!children.length) return null;
      return createGroup(children, baseName || `组 ${seq++}`);
    }

    let subpaths = null;
    let name = baseName;
    switch (tag) {
      case 'path':
        subpaths = parsePathD(el.getAttribute('d') || '');
        name ||= `路径 ${seq++}`;
        break;
      case 'rect': {
        const x = parseFloat(el.getAttribute('x')) || 0;
        const y = parseFloat(el.getAttribute('y')) || 0;
        const w = parseFloat(el.getAttribute('width')) || 0;
        const h = parseFloat(el.getAttribute('height')) || 0;
        subpaths = rectSubpaths(x, y, w, h);
        name ||= `矩形 ${seq++}`;
        break;
      }
      case 'circle':
      case 'ellipse': {
        const cx = parseFloat(el.getAttribute('cx')) || 0;
        const cy = parseFloat(el.getAttribute('cy')) || 0;
        const rx = tag === 'circle' ? (parseFloat(el.getAttribute('r')) || 0) : (parseFloat(el.getAttribute('rx')) || 0);
        const ry = tag === 'circle' ? rx : (parseFloat(el.getAttribute('ry')) || 0);
        subpaths = ellipseSubpaths(cx, cy, rx, ry);
        name ||= `${tag === 'circle' ? '圆形' : '椭圆'} ${seq++}`;
        break;
      }
      case 'line':
        subpaths = lineSubpaths(
          parseFloat(el.getAttribute('x1')) || 0, parseFloat(el.getAttribute('y1')) || 0,
          parseFloat(el.getAttribute('x2')) || 0, parseFloat(el.getAttribute('y2')) || 0,
        );
        name ||= `直线 ${seq++}`;
        break;
      case 'polyline':
      case 'polygon': {
        const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        const anchors = [];
        for (let k = 0; k + 1 < pts.length; k += 2) anchors.push({ x: pts[k], y: pts[k + 1], hIn: { dx: 0, dy: 0 }, hOut: { dx: 0, dy: 0 }, smooth: false });
        subpaths = [{ closed: tag === 'polygon', anchors }];
        name ||= `${tag === 'polygon' ? '多边形' : '折线'} ${seq++}`;
        break;
      }
      case 'use': {
        note('use');
        return null;
      }
      default:
        note(tag);
        return null;
    }
    if (!subpaths || !subpaths.length) return null;
    if (!t.isIdentity) subpaths = transformSubpaths(subpaths, t);
    const node = createPath(subpaths, style, name);
    node.visible = el.getAttribute('display') !== 'none' && el.getAttribute('visibility') !== 'hidden';
    node.locked = el.getAttribute('data-locked') === 'true';
    return node;
  };

  for (const child of root.children) {
    const node = convert(child, Transform.identity(), DEFAULT_STYLE());
    if (node) doc.layers.push(node);
  }

  // 渐变 / 图案填充等引用无法在扁平模型中表达，给出提示并降级为纯色
  if (/url\(/.test(text)) warnings.push('渐变/图案填充（url(...)）已降级为纯色，滤镜与裁剪路径不会被导入');
  if (/<text/.test(text)) warnings.push('<text> 文本不支持导入，请先在源工具中转曲为路径');
  return { doc, warnings };
}

// 构造可直接挂到页面的 SVG DOM（用于缩略图/预览等场景）
export function docToSvgElement(doc) {
  const wrapper = document.createElementNS(SVG_NS, 'svg');
  const parser = new DOMParser();
  const xml = parser.parseFromString(docToSvgString(doc), 'image/svg+xml');
  return xml.documentElement;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text, filename, mime = 'image/svg+xml') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export { findNode };
