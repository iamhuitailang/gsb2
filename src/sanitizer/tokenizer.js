// 容错 HTML 分词器:基于简化的 HTML5 状态机,不依赖浏览器解析。
// 目标不是 100% 还原浏览器 DOM,而是保证任何畸形/混淆输入都被解析成
// 结构化 token,后续白名单逻辑不会被大小写、实体、空白、嵌套或畸形标签绕过。

const isWhitespace = (c) => c === '\t' || c === '\n' || c === '\f' || c === ' ' || c === '\r';

// 原始文本元素:内容直到匹配到对应结束标签为止,内部不解析任何标签
const RAWTEXT_TAGS = new Set(['script', 'style', 'iframe', 'noscript', 'noembed', 'noframes', 'xmp']);

export function tokenize(html, errors = []) {
  const s = String(html ?? '');
  const len = s.length;
  let pos = 0;
  const tokens = [];

  const pushError = (type, detail) => errors.push({ type, detail, position: pos });

  function readRawtext(tagName) {
    const start = pos;
    const lower = tagName.toLowerCase();
    while (pos < len) {
      if (s[pos] === '<' && s[pos + 1] === '/') {
        // 模拟浏览器对 </script 等结束序列的识别:标签名不区分大小写,
        // 其后必须是空白、> 或 EOF,否则只是普通文本
        let j = pos + 2;
        let name = '';
        while (j < len && /[a-zA-Z0-9]/.test(s[j])) name += s[j++];
        if (name.toLowerCase() === lower &&
            (j >= len || s[j] === '>' || isWhitespace(s[j]))) {
          break;
        }
      }
      pos++;
    }
    const text = s.slice(start, pos);
    tokens.push({ type: 'rawtext', tag: lower, text });
    if (pos < len && s[pos] === '<') {
      // 正常产出结束标签 token,让树构建器闭合 rawtext 元素
      tokens.push({ type: 'endTag', name: lower });
      const end = s.indexOf('>', pos);
      if (end === -1) {
        pos = len;
        pushError('unclosed-rawtext', lower);
      } else {
        pos = end + 1;
      }
    } else {
      // 读到 EOF 仍未遇到匹配的结束标签
      pushError('unclosed-rawtext', lower);
    }
  }

  function parseAttributes() {
    // 进入时 pos 位于标签名之后;返回 [{name, value, quoted}]
    const attrs = [];
    while (pos < len && s[pos] !== '>' && s[pos] !== '/') {
      while (pos < len && isWhitespace(s[pos])) pos++;
      if (pos >= len || s[pos] === '>' || s[pos] === '/') break;
      if (s[pos] === '/') { pos++; continue; }
      // 属性名:遇到空白、=、> 终止;控制字符与引号也容错终止
      let name = '';
      while (pos < len && !isWhitespace(s[pos]) && s[pos] !== '=' && s[pos] !== '>') {
        if (s[pos] === '/') break;
        name += s[pos++];
      }
      if (!name) {
        // 孤立引号等垃圾字符,跳过并记账
        pushError('malformed-attribute', s[pos]);
        pos++;
        continue;
      }
      while (pos < len && isWhitespace(s[pos])) pos++;
      let value = '';
      let quoted = false;
      if (s[pos] === '=') {
        pos++;
        while (pos < len && isWhitespace(s[pos])) pos++;
        if (s[pos] === '"' || s[pos] === "'") {
          quoted = true;
          const quote = s[pos++];
          const vStart = pos;
          while (pos < len && s[pos] !== quote) pos++;
          value = s.slice(vStart, pos);
          if (pos >= len) pushError('unterminated-attribute-value', name);
          else pos++; // 消费闭合引号
        } else {
          const vStart = pos;
          while (pos < len && !isWhitespace(s[pos]) && s[pos] !== '>') pos++;
          value = s.slice(vStart, pos);
        }
      }
      const lowerName = name.toLowerCase();
      if (attrs.some((a) => a.name === lowerName)) {
        pushError('duplicate-attribute', lowerName);
        // HTML 规则:重复属性保留第一个,丢弃后续
        continue;
      }
      attrs.push({ name: lowerName, value, quoted });
    }
    return attrs;
  }

  while (pos < len) {
    if (s[pos] !== '<') {
      const start = pos;
      while (pos < len && s[pos] !== '<') pos++;
      tokens.push({ type: 'text', text: s.slice(start, pos) });
      continue;
    }

    // 以下均以 < 开头
    if (s.startsWith('<!--', pos)) {
      const end = s.indexOf('-->', pos + 4);
      if (end === -1) {
        tokens.push({ type: 'comment', text: s.slice(pos + 4) });
        pos = len;
        pushError('unterminated-comment', null);
      } else {
        tokens.push({ type: 'comment', text: s.slice(pos + 4, end) });
        pos = end + 3;
      }
      continue;
    }
    if (s.startsWith('<!', pos) || s.startsWith('<?', pos)) {
      // DOCTYPE、CDATA、处理指令等一律记为 bogusComment
      const end = s.indexOf('>', pos);
      const text = end === -1 ? s.slice(pos + 2) : s.slice(pos + 2, end);
      tokens.push({ type: 'bogusComment', text });
      if (end === -1) {
        pos = len;
        pushError('unterminated-declaration', null);
      } else {
        pos = end + 1;
      }
      continue;
    }
    if (s[pos + 1] === '/') {
      // 结束标签
      let j = pos + 2;
      const nameStart = j;
      while (j < len && /[a-zA-Z0-9]/.test(s[j])) j++;
      const name = s.slice(nameStart, j).toLowerCase();
      if (!name) {
        pushError('malformed-end-tag', s.slice(pos, Math.min(pos + 12, len)));
        const end = s.indexOf('>', pos);
        pos = end === -1 ? len : end + 1;
        continue;
      }
      // 跳过残余属性(结束标签上的属性是畸形输入)
      let k = j;
      while (k < len && s[k] !== '>') k++;
      if (k > j && s.slice(j, k).trim()) pushError('attributes-on-end-tag', name);
      tokens.push({ type: 'endTag', name });
      pos = k < len ? k + 1 : len;
      if (k >= len) pushError('unterminated-end-tag', name);
      continue;
    }

    // 开始标签:名字首字符必须是字母,否则 < 按文本处理
    if (!/[a-zA-Z]/.test(s[pos + 1] || '')) {
      tokens.push({ type: 'text', text: '<' });
      pos++;
      continue;
    }
    let name = '';
    pos++;
    const nameStart = pos;
    while (pos < len && /[a-zA-Z0-9]/.test(s[pos])) name += s[pos++];
    name = name.toLowerCase();
    if (!name) {
      pushError('malformed-start-tag', s.slice(nameStart, pos));
      continue;
    }
    const attrs = parseAttributes();
    const selfClosing = s[pos] === '/';
    if (selfClosing) pos++;
    if (s[pos] === '>') {
      pos++;
    } else {
      pushError('unterminated-start-tag', name); // EOF 处的标签
    }
    tokens.push({ type: 'startTag', name, attrs, selfClosing });
    if (RAWTEXT_TAGS.has(name) && !selfClosing) {
      readRawtext(name);
    }
  }
  return tokens;
}
