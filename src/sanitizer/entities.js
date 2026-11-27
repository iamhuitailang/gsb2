// HTML 实体编解码(HTML5 命名实体的常用子集 + 数字实体)。
// 解码结果仅用于安全判断(URL 策略/CSS 检查/属性名匹配),
// 序列化输出时统一重新编码,保证输出是规范文本而非可利用的标记。

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', tab: '\t', newl: '\n', colon: ':', semi: ';',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  micro: 'µ', middot: '·', bull: '•', deg: '°', plusmn: '±',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
  bdquo: '„', dagger: '†', Dagger: '‡', hellip: '…', emsp: ' ',
  ensp: ' ', thinsp: ' ', zwsp: '​', zwnj: '‌', zwj: '‍',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  iexcl: '¡', iquest: '¿', not: '¬', shy: '', macr: '¯',
  acute: '´', cedil: '¸', circ: 'ˆ', uml: '¨', tilde: '˜',
  ordm: 'º', ordf: 'ª', sup1: '¹', sup2: '²', sup3: '³',
  ndash: '–', mdash: '—', hyphen: '‐', oline: '‾',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î',
  Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ',
  szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã',
  auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í',
  icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
  thorn: 'þ', yuml: 'ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š',
  scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ2: 'ˆ', tilde2: '˜',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε',
  Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ',
  Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π',
  Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ',
  Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π',
  rho: 'ρ', sigmaf: 'ς', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  forall: '∀', part: '∂', exists: '∃', empty: '∅', nabla: '∇',
  isin: '∈', notin: '∉', ni: '∋', prod: '∏', sum: '∑',
  minus: '−', lowast: '∗', radic: '√', prop: '∝', infin: '∞',
  ang: '∠', and: '∧', or: '∨', cap: '∩', cup: '∪',
  there4: '∴', sim: '∼', cong: '≅', asymp: '≈', ne: '≠',
  equiv: '≡', le: '≤', ge: '≥', sub: '⊂', sup: '⊃',
  nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗',
  perp: '⊥', sdot: '⋅', lceil: '⌈', rceil: '⌉', lfloor: '⌊',
  rfloor: '⌋', lang: '〈', rang: '〉',
  loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  uarr: '↑', darr: '↓', larr: '←', rarr: '→', harr: '↔',
  crarr: '↵', lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓',
  hArr: '⇔',
  brvbar: '¦', die: '¨', horizbar: '―', verbar: '|',
  doublevert: '‖', embp: '¶', nrarr: '⇏',
  check: '✓', cross: '✗', star: '★', phone: '☎'
};

// 数字实体的范围检查:非法码位/代理项/非字符按 HTML5 规则替换为 U+FFFD。
function codePointToReplacement(cp) {
  if (cp === 0) return '�'; // 空字节显式替换,防止 NUL 截断类绕过
  if (cp > 0x10ffff) return '�';
  if (cp >= 0xd800 && cp <= 0xdfff) return '�'; // UTF-16 代理区
  if (cp >= 0xfdd0 && cp <= 0xfdef) return '�'; // 非字符
  if ((cp & 0xfffe) === 0xfffe) return '�';     // 平面末尾非字符
  if (cp === 0x0b || (cp >= 0x01 && cp <= 0x08) ||
      (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) {
    // HTML5 数字实体对控制字符做特殊映射,这里统一按替换字符处理,更保守
    if (cp >= 0x80 && cp <= 0x9f) {
      // Windows-1252 映射区仍按替换字符处理(保守策略,不影响安全判断)
    }
    return '�';
  }
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '�';
  }
}

// 单遍解码:与浏览器对属性值/文本的实体解析保持一致(浏览器也只解码一遍)。
// 输出随后会重新编码,因此解码后内容无法在结果中变成可执行标记。
export function decodeEntities(input) {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '&') {
      out += ch;
      continue;
    }
    const rest = input.slice(i + 1);
    // &#x41; / &#65; / 缺分号形式 &#x41 与 &#65
    const numeric = /^#(?:[xX]([0-9a-fA-F]{1,8});?|([0-9]{1,10});?)/.exec(rest);
    if (numeric) {
      const cp = numeric[1] !== undefined
        ? parseInt(numeric[1], 16)
        : parseInt(numeric[2], 10);
      out += codePointToReplacement(cp);
      i += numeric[0].length;
      continue;
    }
    // &name; 以及 HTML 遗留的缺分号形式(如 &ampx)
    const named = /^([a-zA-Z][a-zA-Z0-9]{1,31});?/.exec(rest);
    if (named && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, named[1].toLowerCase())) {
      out += NAMED_ENTITIES[named[1].toLowerCase()];
      i += named[0].length;
      continue;
    }
    out += ch; // 非实体,原样保留
  }
  return out;
}

// 序列化编码:文本节点与属性值统一走这里,输出中不可能出现裸 < > 或可逃逸引号的实体。
export function encodeText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function encodeAttribute(value) {
  // 属性统一用双引号输出,只需编码 & < > 与双引号即可防止逃逸;
  // 空格(含 U+00A0)在引号内是安全的,保留原样
  return encodeText(value).replace(/"/g, '&quot;');
}
