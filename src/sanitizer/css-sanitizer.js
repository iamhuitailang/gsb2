// 内联 style 属性清理:属性白名单 + 值危险模式拦截。
// 不支持 <style> 标签与外部样式表(在标签白名单层面移除),
// 因此只需处理声明列表,无需解析完整 CSS 语法。

// 允许的 CSS 属性:仅排版/颜色/布局类,排除 expression 时代遗留属性与
// 任何可承载外部资源/脚本的属性(@import、filter url() 等均不在表内)
const ALLOWED_PROPERTIES = new Set([
  'align-content', 'align-items', 'align-self', 'background-color',
  'border', 'border-bottom', 'border-collapse', 'border-color',
  'border-left', 'border-radius', 'border-right', 'border-spacing',
  'border-style', 'border-top', 'border-width', 'bottom', 'box-sizing',
  'caption-side', 'clear', 'color', 'direction', 'display',
  'empty-cells', 'flex', 'flex-basis', 'flex-direction', 'flex-flow',
  'flex-grow', 'flex-shrink', 'flex-wrap', 'font', 'font-family',
  'font-size', 'font-style', 'font-variant', 'font-weight', 'gap',
  'height', 'justify-content', 'left', 'letter-spacing', 'line-height',
  'list-style', 'list-style-position', 'list-style-type', 'margin',
  'margin-bottom', 'margin-left', 'margin-right', 'margin-top',
  'max-height', 'max-width', 'min-height', 'min-width', 'opacity',
  'order', 'outline', 'overflow', 'overflow-x', 'overflow-y', 'padding',
  'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'place-content', 'place-items', 'position', 'right', 'table-layout',
  'text-align', 'text-decoration', 'text-decoration-color',
  'text-decoration-line', 'text-decoration-style', 'text-indent',
  'text-overflow', 'text-transform', 'top', 'transform',
  'transform-origin', 'unicode-bidi', 'vertical-align', 'visibility',
  'white-space', 'width', 'word-break', 'word-spacing', 'word-wrap',
  'writing-mode', 'z-index'
]);

// 值中出现以下任意片段即拒绝声明(小写匹配)
const FORBIDDEN_VALUE_PATTERNS = [
  { re: /url\s*\(/, reason: 'css-url-reference' },
  { re: /@import/, reason: 'css-at-import' },
  { re: /expression\s*\(/, reason: 'css-expression' },
  { re: /javascript\s*:/, reason: 'css-script-scheme' },
  { re: /vbscript\s*:/, reason: 'css-script-scheme' },
  { re: /data\s*:/, reason: 'css-data-uri' },
  { re: /[<>]/, reason: 'css-markup-chars' },
  { re: /\\[0-9a-f]/, reason: 'css-backslash-escape' } // CSS 反斜杠十六进制转义,可能藏脚本
];

function countQuotes(v) {
  let n = 0;
  for (const ch of v) if (ch === '"' || ch === "'") n++;
  return n;
}

// 输入为已解码实体的 style 属性值;输出 { css, removed }
export function sanitizeStyle(rawValue) {
  const removed = [];
  const kept = [];
  const declarations = String(rawValue ?? '').split(';');

  for (let decl of declarations) {
    decl = decl.trim();
    if (!decl) continue;

    // at 规则(如 @import)不是声明,整体拒绝
    if (decl.startsWith('@')) {
      const atName = (decl.split(/[\s(]/)[0] || '').toLowerCase();
      removed.push({
        property: atName,
        reason: atName === '@import' ? 'css-at-import' : 'css-at-rule'
      });
      continue;
    }

    const colon = decl.indexOf(':');
    if (colon === -1) {
      removed.push({ property: '', reason: 'malformed-declaration' });
      continue;
    }
    const property = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();

    // 自定义属性单独识别(名称为 --xxx,不套普通属性名字符类)
    if (property.startsWith('--')) {
      removed.push({ property, reason: 'custom-property-not-allowed' });
      continue;
    }
    if (!/^-?[a-z][a-z0-9-]*$/.test(property)) {
      removed.push({ property, reason: 'invalid-property-name' });
      continue;
    }
    if (!value) {
      removed.push({ property, reason: 'empty-value' });
      continue;
    }
    if (countQuotes(value) % 2 !== 0) {
      removed.push({ property, reason: 'unbalanced-quotes' });
      continue;
    }
    // 危险值模式优先判定:即使属性本身不在白名单,
    // 带 url()/expression/脚本协议的载荷也要按真实风险类别记录
    const lowerValue = value.toLowerCase();
    const hit = FORBIDDEN_VALUE_PATTERNS.find((p) => p.re.test(lowerValue));
    if (hit) {
      removed.push({ property, reason: hit.reason });
      continue;
    }
    if (!ALLOWED_PROPERTIES.has(property)) {
      removed.push({ property, reason: 'property-not-allowed' });
      continue;
    }
    kept.push(`${property}: ${value}`);
  }

  return { css: kept.join('; '), removed };
}
