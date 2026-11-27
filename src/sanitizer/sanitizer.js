// 核心清理器:白名单式 HTML 过滤,同一份逻辑供页面(粘贴/导入/切换样例)
// 与自动化测试共用,任何入口的安全结果完全一致。
//
// 输出三部分:
//   html    —— 规范化、重新编码后的安全 HTML 字符串(可直接放入隔离帧)
//   report  —— 结构化处理报告(类别 + 数量 + 明细,不含可执行原始标记)
//   stats   —— 计数统计

import { parseFragment } from './parser.js';
import { evaluateUrl } from './url-policy.js';
import { sanitizeStyle } from './css-sanitizer.js';
import { encodeText, encodeAttribute, decodeEntities } from './entities.js';

// ---- 标签白名单 ----------------------------------------------------------
// 仅包含排版与常见安全格式标签;script/iframe/object/embed/svg/math/
// form/input/link/meta/base/style 等全部不在表内(整子树移除或空元素移除)。
export const ALLOWED_TAGS = new Set([
  // 结构
  'address', 'article', 'aside', 'blockquote', 'br', 'div', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'p', 'pre', 'section', 'span',
  // 行内文本
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'i', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  // 列表
  'dd', 'dl', 'dt', 'li', 'ol', 'ul',
  // 表格
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr',
  // 图片(仅 data: 图片可通过 URL 策略)
  'img',
  // 折叠区块(无脚本能力)
  'details', 'summary'
]);

// 整子树移除的标签:内容本身不可信(脚本/样式/嵌入文档等),
// 不能像普通未知标签那样只脱壳保留子节点
const DROP_SUBTREE_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
  'noscript', 'noembed', 'noframes', 'template', 'canvas', 'applet',
  'frame', 'frameset', 'portal', 'xml'
]);

// 所有元素可用的全局属性
const GLOBAL_ATTRIBUTES = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'translate', 'hidden',
  'tabindex', 'role', 'slot'
]);

// 元素专属属性白名单(全局属性之外)
const TAG_ATTRIBUTES = {
  a: new Set(['href', 'rel', 'name']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  time: new Set(['datetime']),
  details: new Set(['open']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  table: new Set(['border', 'cellpadding', 'cellspacing', 'summary']),
  bdo: new Set(['dir']),
  bdi: new Set(['dir'])
};

// 取值需要走 URL 策略的属性及其上下文
const URL_ATTRIBUTES = {
  href: 'href',
  src: 'resource',
  cite: 'resource',
  poster: 'resource',
  data: 'resource'
};

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// 布尔属性:存在即保留,值忽略
const BOOLEAN_ATTRIBUTES = new Set([
  'hidden', 'open', 'reversed', 'async', 'defer', 'disabled',
  'checked', 'multiple', 'readonly', 'required', 'selected', 'nomodule'
]);

function createReport() {
  return {
    removedElements: [],       // 整元素/整子树移除
    removedAttributes: [],     // 属性移除或改写
    removedStyleDeclarations: [],
    urlDecisions: [],          // 全部 URL 判定(含放行),便于审计
    parserIssues: [],          // 畸形输入与容错记录
    discardedContainers: 0     // 文档外壳/注释类丢弃计数
  };
}

function isEventHandler(attrName) {
  // on* 一律视为事件处理属性,包含 onmozpointerlockchange 等冷门事件
  return attrName.length > 2 && attrName.startsWith('on');
}

function sanitizeAttributes(el, report) {
  const tag = el.name;
  const allowed = new Set([
    ...GLOBAL_ATTRIBUTES,
    ...(TAG_ATTRIBUTES[tag] || [])
  ]);
  // style 单独走 CSS 清理,不直接放行
  allowed.add('style');

  const out = [];

  for (const attr of el.attrs) {
    const name = attr.name;
    // 与浏览器解析对齐:先解一遍实体再做安全判断,
    // 序列化时统一重新编码,输出保持幂等
    const rawValue = decodeEntities(attr.value);

    if (isEventHandler(name)) {
      report.removedAttributes.push({ tag, attribute: name, reason: 'event-handler' });
      continue;
    }
    // XML 命名空间属性(含 xlink:href、xml:lang 等)一律不进入输出,
    // 普通 data-* 等其余非白名单属性由下面的白名单判断统一拦截
    if (name.startsWith('xmlns') || name.includes(':')) {
      report.removedAttributes.push({ tag, attribute: name, reason: 'namespaced-attribute' });
      continue;
    }
    if (!allowed.has(name)) {
      report.removedAttributes.push({ tag, attribute: name, reason: 'attribute-not-allowed' });
      continue;
    }

    // URL 类属性
    if (name in URL_ATTRIBUTES) {
      const decision = evaluateUrl(rawValue, URL_ATTRIBUTES[name], true);
      report.urlDecisions.push({
        tag, attribute: name,
        verdict: decision.ok ? 'allowed' : 'rejected',
        reason: decision.reason || 'ok',
        // 仅记录截断后的地址用于展示,避免报告本身承载超长载荷
        sample: decision.url.slice(0, 120)
      });
      if (!decision.ok) {
        report.removedAttributes.push({
          tag, attribute: name, reason: `url:${decision.reason}`
        });
        continue; // 被拒地址直接移除属性,元素保留但无法导航/加载
      }
      out.push({ name, value: decision.url });
      continue;
    }

    if (name === 'style') {
      const result = sanitizeStyle(rawValue);
      for (const r of result.removed) {
        report.removedStyleDeclarations.push({ tag, ...r });
      }
      if (result.css) {
        out.push({ name, value: result.css });
      } else {
        report.removedAttributes.push({ tag, attribute: 'style', reason: 'style-fully-removed' });
      }
      continue;
    }

    if (name === 'target') {
      // 不允许新窗口/弹窗导航
      report.removedAttributes.push({ tag, attribute: name, reason: 'target-not-allowed' });
      continue;
    }

    if (BOOLEAN_ATTRIBUTES.has(name)) {
      out.push({ name, value: '' });
      continue;
    }

    // 普通安全属性:值在序列化时统一编码
    out.push({ name, value: rawValue });
  }

  // 链接固化 rel,禁止反向 tabnabbing(即便 target 已被移除也保持防御)
  if (tag === 'a' && out.some((a) => a.name === 'href')) {
    if (!out.some((a) => a.name === 'rel')) {
      out.push({ name: 'rel', value: 'noopener noreferrer' });
    }
  }
  // referrerpolicy 若保留则强制 no-referrer,杜绝外带来源信息
  const rp = out.find((a) => a.name === 'referrerpolicy');
  if (rp) rp.value = 'no-referrer';

  return out;
}

function walk(node, report) {
  if (node.type === 'text') {
    // 解码实体后再由序列化阶段统一编码,杜绝二次编码漂移
    return { kind: 'text', value: decodeEntities(node.value) };
  }
  if (node.type !== 'element') return null;

  const tag = node.name;

  // 危险子树:整体丢弃(含文本与所有后代),报告类别
  if (DROP_SUBTREE_TAGS.has(tag)) {
    report.removedElements.push({ tag, reason: 'dangerous-subtree', withChildren: true });
    return null;
  }

  const safeAttrs = sanitizeAttributes(node, report);
  const safeChildren = [];
  for (const child of node.children) {
    const result = walk(child, report);
    if (result) safeChildren.push(result);
  }

  if (!ALLOWED_TAGS.has(tag)) {
    // 未知/不支持的标签:移除标签本身,保留已清理的子节点(脱壳)
    report.removedElements.push({ tag, reason: 'tag-not-allowed', withChildren: false });
    return { kind: 'fragment', children: safeChildren };
  }

  return { kind: 'element', name: tag, attrs: safeAttrs, children: safeChildren };
}

function serialize(node) {
  if (node.kind === 'text') {
    return encodeText(node.value);
  }
  if (node.kind === 'fragment') {
    return node.children.map(serialize).join('');
  }
  const attrText = node.attrs.length
    ? ' ' + node.attrs.map((a) => `${a.name}="${encodeAttribute(a.value)}"`).join(' ')
    : '';
  if (VOID_TAGS.has(node.name)) {
    return `<${node.name}${attrText}>`;
  }
  const inner = node.children.map(serialize).join('');
  return `<${node.name}${attrText}>${inner}</${node.name}>`;
}

// 汇总各类别计数,供 UI 直接渲染
function summarize(report) {
  const counts = {
    removedElements: report.removedElements.length,
    removedAttributes: report.removedAttributes.length,
    removedStyleDeclarations: report.removedStyleDeclarations.length,
    rejectedUrls: report.urlDecisions.filter((u) => u.verdict === 'rejected').length,
    allowedUrls: report.urlDecisions.filter((u) => u.verdict === 'allowed').length,
    parserIssues: report.parserIssues.length
  };
  return counts;
}

// 唯一对外入口:输入任意 HTML 字符串,输出安全 HTML 与报告
export function sanitizeHtml(input) {
  const parserErrors = [];
  const report = createReport();
  const tree = parseFragment(String(input ?? ''), parserErrors);
  report.parserIssues = parserErrors;

  const safeNodes = [];
  for (const child of tree.children) {
    const result = walk(child, report);
    if (result) safeNodes.push(result);
  }
  const html = safeNodes.map(serialize).join('');
  return { html, report, stats: summarize(report) };
}
