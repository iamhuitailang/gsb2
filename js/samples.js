/*
 * samples.js — 本地样例：覆盖放行、阻止、default-src 回退、多策略冲突、
 * nonce/哈希内联授权、通配符/端口/路径边界、以及带格式问题的策略。
 * 全部为静态数据，不访问网络。
 */
window.CSP_SAMPLES = [
  {
    name: '1. 基础放行与阻止',
    description: '单条策略：同源与指定 CDN 放行，其余来源阻止；connect/font 演示 default-src 回退。',
    pageUrl: 'https://shop.example.com/app/index.html',
    policies: [
      "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    ],
    resources: [
      'script https://cdn.example.com/app.js',
      'script https://evil-cdn.example.net/x.js',
      'script /js/local.js',
      'style inline',
      'img data:image/png;base64,iVBORw0KGgo=',
      'img https://img.example.net/a.png',
      'connect https://api.example.com/v1',
      'font https://shop.example.com/fonts/a.woff2'
    ].join('\n')
  },
  {
    name: '2. 默认规则回退（default-src）',
    description: '只设置 script-src 与 default-src：img/font/object 等未指定的类型回退到 default-src。',
    pageUrl: 'https://shop.example.com/',
    policies: [
      "default-src 'self'; script-src https://cdn.example.com"
    ],
    resources: [
      'script https://cdn.example.com/app.js',
      'script https://shop.example.com/local.js',
      'img https://shop.example.com/logo.png',
      'img https://img.other.net/logo.png',
      'font https://shop.example.com/a.woff2',
      'object https://shop.example.com/plugin.swf'
    ].join('\n')
  },
  {
    name: '3. 多策略共同生效（冲突）',
    description: '两条策略同时生效：资源必须被所有策略放行。结果会指出是哪条策略造成阻止。',
    pageUrl: 'https://shop.example.com/',
    policies: [
      "default-src 'self'; script-src 'self' https://cdn.example.com",
      "script-src 'self'; img-src 'self' https://img.example.com"
    ],
    resources: [
      'script https://cdn.example.com/app.js',
      'script https://shop.example.com/local.js',
      'img https://img.example.com/a.png',
      'img https://img.other.net/a.png',
      'style https://shop.example.com/a.css'
    ].join('\n')
  },
  {
    name: '4. 内联标记：nonce 与哈希',
    description: 'script-src 用 nonce 和哈希授权特定内联脚本；style-src 用 unsafe-inline。可修改 nonce 值观察结果变化。',
    pageUrl: 'https://shop.example.com/',
    policies: [
      "script-src 'self' 'nonce-abc123' 'sha256-7Hv6q2xkLMN0pQrStUvWxYzAbCdEfGhIjKlMnOpQrSt='; style-src 'self' 'unsafe-inline'"
    ],
    resources: [
      'script inline nonce=abc123',
      'script inline nonce=wrong-value',
      'script inline',
      'script inline hash=sha256-7Hv6q2xkLMN0pQrStUvWxYzAbCdEfGhIjKlMnOpQrSt=',
      'script inline hash=sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'style inline'
    ].join('\n')
  },
  {
    name: '5. 通配符、端口与路径边界',
    description: '演示 *. 通配符不含主域、端口必须一致、路径前缀匹配，以及「文本前缀相似」的地址不会被误判为同一来源。',
    pageUrl: 'https://shop.example.com:8443/app/',
    policies: [
      "default-src 'none'; script-src https://*.example.com; img-src https://cdn.example.com:8443; connect-src https://api.example.com/v1/"
    ],
    resources: [
      'script https://cdn.example.com/a.js',
      'script https://example.com/a.js',
      'script https://cdn.example.com.evil.com/a.js',
      'img https://cdn.example.com:8443/a.png',
      'img https://cdn.example.com/a.png',
      'connect https://api.example.com/v1/users',
      'connect https://api.example.com/v2/users',
      'connect https://api.example.com.evil.com/v1/x',
      'font https://shop.example.com/a.woff2'
    ].join('\n')
  },
  {
    name: '6. 有问题的策略（告警展示）',
    description: '策略中包含重复指令、未知指令、无效来源、none 并存等问题：检查器给出告警，但其余指令仍正常参与评估。',
    pageUrl: 'https://shop.example.com/',
    policies: [
      "default-src 'self'; script-src 'self'; script-src https://cdn.example.com; img-src 'none' 'self'; font-src 'self' bad_token!!; unknown-dir 'self'; style-src 'self' 'unsafe-inline' 'nonce-x1'"
    ],
    resources: [
      'script https://shop.example.com/a.js',
      'script https://cdn.example.com/a.js',
      'img https://shop.example.com/a.png',
      'font https://shop.example.com/a.woff2',
      'style inline nonce=x1',
      'style inline'
    ].join('\n')
  }
];
