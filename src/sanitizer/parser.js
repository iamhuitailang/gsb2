// 片段模式的树构建器:把分词 token 组织成节点树。
// 实现 HTML5 片段解析的关键子集——void 元素、原始文本元素、
// 常见隐式闭合规则与畸形嵌套容错,保证安全判断基于结构而非正则。

import { tokenize } from './tokenizer.js';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// 隐式闭合:遇到 key 标签时,栈顶若为 value 集合中的元素则先弹出
const IMPLICIT_CLOSE = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
  tr: new Set(['tr']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  thead: new Set(['thead', 'tbody', 'tfoot']),
  tbody: new Set(['thead', 'tbody', 'tfoot']),
  tfoot: new Set(['thead', 'tbody']),
  p: new Set(['p'])
};

// <p> 的隐式闭合范围更广:HTML5 中块级元素开始时都会挂起闭合 p
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul'
]);

function createElement(name, attrs, selfClosing) {
  return { type: 'element', name, attrs: attrs || [], children: [], selfClosing: !!selfClosing };
}

export function buildTree(tokens, errors = []) {
  const root = { type: 'root', children: [] };
  const stack = [root];

  const current = () => stack[stack.length - 1];

  function closeTo(name) {
    // 弹出到最近的同名元素;找不到则忽略(多余的结束标签)
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].type === 'element' && stack[i].name === name) {
        stack.length = i;
        return true;
      }
    }
    return false;
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        current().children.push({ type: 'text', value: token.text });
        break;

      case 'rawtext':
        // 原始文本内容作为单文本节点挂在对应元素下;
        // 找不到宿主(理论上不会发生)时直接丢弃并记账
        current().children.push({ type: 'text', value: token.text });
        break;

      case 'comment':
      case 'bogusComment':
        // 注释与声明不进入输出树,仅在错误报告中体现
        errors.push({ type: 'comment-or-declaration-removed', detail: token.type });
        break;

      case 'endTag': {
        if (!closeTo(token.name)) {
          errors.push({ type: 'stray-end-tag', detail: token.name });
        }
        break;
      }

      case 'startTag': {
        if (IMPLICIT_CLOSE[token.name] &&
            IMPLICIT_CLOSE[token.name].has(current().name)) {
          stack.pop();
        }
        if (token.name === 'p' && current().name === 'p') {
          stack.pop();
        } else if (P_CLOSERS.has(token.name) && current().name === 'p') {
          stack.pop();
        }

        const el = createElement(token.name, token.attrs, token.selfClosing);
        current().children.push(el);

        if (VOID_ELEMENTS.has(token.name) || token.selfClosing) {
          if (!VOID_ELEMENTS.has(token.name) && token.selfClosing) {
            // 非 void 元素的自闭合写法:HTML 解析器会忽略斜杠,
            // 这里按浏览器行为处理(元素仍可包含后续子节点),并记账
            errors.push({ type: 'self-closing-on-non-void', detail: token.name });
            stack.push(el);
          }
          // void 元素不入栈
        } else {
          stack.push(el);
        }
        break;
      }
    }
  }

  if (stack.length > 1) {
    errors.push({ type: 'unclosed-elements', detail: stack.slice(1).map((n) => n.name) });
  }
  return root;
}

export function parseFragment(html, errors = []) {
  const tokens = tokenize(html, errors);
  return buildTree(tokens, errors);
}
