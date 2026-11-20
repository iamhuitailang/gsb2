// CSP 指令目录。仅用于离线分析，不涉及任何网络行为。
// 参考 CSP3（https://www.w3.org/TR/CSP3/）及常见浏览器实现。

export const FETCH_DIRECTIVES = [
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'connect-src',
  'frame-src',
  'child-src',
  'worker-src',
  'manifest-src',
  'media-src',
  'object-src',
  'prefetch-src',
];

// 文档级与导航类指令（值同样是源表达式集合，但不是资源加载的 fetch 指令）
export const DOCUMENT_DIRECTIVES = [
  'base-uri',
  'form-action',
  'frame-ancestors',
  'navigate-to',
];

export const BOOLEAN_DIRECTIVES = [
  'upgrade-insecure-requests',
  'block-all-mixed-content',
];

// 有固定取值格式、但不是源列表的指令
export const SPECIAL_DIRECTIVES = {
  'report-to': 'token',          // 上报组名称
  'report-uri': 'uri-list',      // 已废弃，值为 URI 列表
  sandbox: 'sandbox-flags',
  'require-trusted-types-for': 'trusted-types',
  'trusted-types': 'tt-policy-list',
  plugin_types: 'plugin-types',  // 极少使用的旧拼写容错
};

// 历史上存在、现代规范已移除或改名的指令
export const DEPRECATED_DIRECTIVES = {
  'report-uri': 'CSP3 中已废弃，请使用 report-to（浏览器仍可能兼容处理）',
  'block-all-mixed-content': '已被 upgrade-insecure-requests 取代',
  'plugin-types': 'CSP3 中已移除',
  'referrer': '从未被主流浏览器实现，请使用 Referrer-Policy 响应头',
};

// 已知实验性/非常新的指令（不报错，只提示兼容性）
export const EXPERIMENTAL_DIRECTIVES = {
  'navigate-to': '实验性指令，浏览器支持有限',
  'prefetch-src': '实验性指令，浏览器支持有限',
  'require-sri-for': '实验性指令，主流浏览器尚未实现',
};

// 全部已知指令（用于“未知指令”判断）
export const KNOWN_DIRECTIVES = new Set([
  ...FETCH_DIRECTIVES,
  ...DOCUMENT_DIRECTIVES,
  ...BOOLEAN_DIRECTIVES,
  ...Object.keys(SPECIAL_DIRECTIVES),
  ...Object.keys(DEPRECATED_DIRECTIVES),
  ...Object.keys(EXPERIMENTAL_DIRECTIVES),
]);

// 接受源表达式列表的指令
export const SOURCE_LIST_DIRECTIVES = new Set([
  ...FETCH_DIRECTIVES,
  ...DOCUMENT_DIRECTIVES,
]);

// 各资源类型对应的指令回退链（CSP3 §6.7），顺序即优先级
export const FALLBACK_CHAINS = {
  script: ['script-src-elem', 'script-src', 'default-src'],
  'script-attr': ['script-src-attr', 'script-src', 'default-src'],
  style: ['style-src-elem', 'style-src', 'default-src'],
  'style-attr': ['style-src-attr', 'style-src', 'default-src'],
  img: ['img-src', 'default-src'],
  font: ['font-src', 'default-src'],
  connect: ['connect-src', 'default-src'],
  frame: ['frame-src', 'child-src', 'default-src'],
  worker: ['worker-src', 'child-src', 'default-src'],
  manifest: ['manifest-src', 'default-src'],
  media: ['media-src', 'default-src'],
  object: ['object-src', 'default-src'],
  prefetch: ['prefetch-src', 'default-src'],
};

// 资源类型的中文说明
export const RESOURCE_TYPE_LABELS = {
  script: '脚本 (<script> 元素)',
  'script-attr': '内联事件处理器 (onclick 等)',
  style: '样式表 (<link>/<style> 元素)',
  'style-attr': '内联 style 属性',
  img: '图片',
  font: '字体',
  connect: '连接 (fetch/XHR/WebSocket)',
  frame: '框架 (<iframe>/<frame>)',
  worker: 'Worker / SharedWorker',
  manifest: 'Manifest 清单',
  media: '音视频 (<audio>/<video>)',
  object: '插件对象 (<object>/<embed>)',
  prefetch: '预取资源',
};

// 哪些资源类型支持“内联”概念
export const INLINE_CAPABLE = new Set(['script', 'script-attr', 'style', 'style-attr']);

// frame-ancestors 不回退到 default-src，也不接受 'unsafe-inline' 等
export const NO_DEFAULT_FALLBACK = new Set(['frame-ancestors', 'form-action', 'base-uri', 'navigate-to']);

// 简单拼写建议表（未知指令时给出“你是不是想写”提示）
const SPELLING_SUGGESTIONS = {
  'defaultsrc': 'default-src',
  'scriptsrc': 'script-src',
  'stylesrc': 'style-src',
  'imgsrc': 'img-src',
  'fontsrc': 'font-src',
  'connectsrc': 'connect-src',
  'framesrc': 'frame-src',
  'childsrc': 'child-src',
  'objects src': 'object-src',
  'objectsrc': 'object-src',
  'media-src': 'media-src',
};

export function suggestDirective(name) {
  if (SPELLING_SUGGESTIONS[name]) return SPELLING_SUGGESTIONS[name];
  const noHyphen = name.replace(/-/g, '');
  for (const known of KNOWN_DIRECTIVES) {
    if (known.replace(/-/g, '') === noHyphen) return known;
  }
  // 简单编辑距离
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_DIRECTIVES) {
    const d = levenshtein(name, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  return bestDist <= 2 ? best : null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
