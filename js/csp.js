/*
 * csp.js — 内容安全策略（CSP）解析与匹配核心。
 * 纯函数实现，不依赖 DOM，不访问网络；同时支持浏览器（window.CSP）与 Node（require）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 本检查器评估的资源类型 → 对应的 fetch 指令
  var FETCH_DIRECTIVES = {
    script: 'script-src',
    style: 'style-src',
    img: 'img-src',
    font: 'font-src',
    connect: 'connect-src',
    frame: 'frame-src',
    object: 'object-src'
  };

  var FETCH_DIRECTIVE_NAMES = Object.keys(FETCH_DIRECTIVES).map(function (k) {
    return FETCH_DIRECTIVES[k];
  });

  // 合法但本检查器不评估其效果的指令
  var KNOWN_NON_EVALUATED = [
    'base-uri', 'form-action', 'frame-ancestors', 'report-uri', 'report-to',
    'upgrade-insecure-requests', 'block-all-mixed-content', 'sandbox',
    'require-trusted-types-for', 'trusted-types', 'worker-src', 'manifest-src',
    'media-src', 'child-src', 'prefetch-src', 'script-src-elem', 'script-src-attr',
    'style-src-elem', 'style-src-attr'
  ];

  var KEYWORDS = [
    "'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'",
    "'strict-dynamic'", "'report-sample'", "'unsafe-allow-redirects'",
    "'inline-speculation-rules'"
  ];

  var DEFAULT_PORTS = { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' };

  // 协议“升级”匹配：策略写 http 时可覆盖 https（ws → wss 同理）
  var SCHEME_UPGRADES = { http: ['https'], ws: ['wss'] };

  function defaultPort(scheme) {
    return Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, scheme)
      ? DEFAULT_PORTS[scheme] : null;
  }

  /* ---------------- 来源表达式解析 ---------------- */

  // 将单个来源表达式 token 解析为结构化对象；无法识别时 kind 为 'invalid'
  function parseSourceToken(token) {
    var lower = token.toLowerCase();
    if (KEYWORDS.indexOf(lower) !== -1) {
      return { kind: 'keyword', value: lower, raw: token };
    }
    var nonce = token.match(/^'nonce-([^']+)'$/i);
    if (nonce) return { kind: 'nonce', value: nonce[1], raw: token };
    var hash = token.match(/^'(sha256|sha384|sha512)-([^']+)'$/i);
    if (hash) return { kind: 'hash', algo: hash[1].toLowerCase(), value: hash[2], raw: token };
    if (/^[a-z][a-z0-9+.-]*:$/i.test(token)) {
      return { kind: 'scheme', scheme: lower.slice(0, -1), raw: token };
    }
    // host-source: [scheme://]host[:port][/path]，host 可为 * 或 *. 前缀
    var m = token.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^\s/:]+|[A-Za-z0-9.-]+)(?::(\d+|\*))?(\/\S*)?$/i);
    if (m && m[2]) {
      return {
        kind: 'host',
        scheme: m[1] ? m[1].toLowerCase() : null,
        host: m[2].toLowerCase(),
        port: m[3] || null,
        path: m[4] || null,
        raw: token
      };
    }
    return { kind: 'invalid', raw: token };
  }

  /* ---------------- 策略解析 ---------------- */

  // 解析一条策略文本，返回 { text, directives: Map, warnings: [{level, message}] }
  function parsePolicy(text) {
    var warnings = [];
    var directives = new Map();
    var segments = String(text).split(';');

    segments.forEach(function (seg, idx) {
      var trimmed = seg.trim();
      if (!trimmed) {
        if (idx !== segments.length - 1) {
          warnings.push({ level: 'info', message: '第 ' + (idx + 1) + ' 个分号段为空，已忽略（可能是连续分号）' });
        }
        return;
      }
      var tokens = trimmed.split(/\s+/);
      var name = tokens[0].toLowerCase();
      var isFetch = name === 'default-src' || FETCH_DIRECTIVE_NAMES.indexOf(name) !== -1;

      if (!isFetch) {
        if (KNOWN_NON_EVALUATED.indexOf(name) !== -1) {
          warnings.push({ level: 'info', message: '指令 "' + name + '" 是有效的 CSP 指令，但本检查器不评估它，已跳过' });
        } else {
          warnings.push({ level: 'warn', message: '未知指令 "' + name + '"，浏览器会忽略该指令' });
        }
        return;
      }
      if (directives.has(name)) {
        warnings.push({ level: 'warn', message: '指令 "' + name + '" 重复出现：按规范仅第一条生效，后续的「' + trimmed + '」已被忽略' });
        return;
      }

      var sources = tokens.slice(1).map(parseSourceToken);
      if (sources.length === 0) {
        warnings.push({ level: 'warn', message: '指令 "' + name + '" 没有任何来源表达式，效果等同于 \'none\'（全部阻止）' });
      }

      var seen = new Set();
      sources.forEach(function (s) {
        var key = s.raw.toLowerCase();
        if (seen.has(key)) {
          warnings.push({ level: 'info', message: '"' + name + '" 中来源表达式 "' + s.raw + '" 重复出现' });
        }
        seen.add(key);
        if (s.kind === 'invalid') {
          warnings.push({ level: 'warn', message: '"' + name + '" 中的 "' + s.raw + '" 不是合法的来源表达式，浏览器会忽略它' });
        }
      });

      var hasNone = sources.some(function (s) { return s.kind === 'keyword' && s.value === "'none'"; });
      if (hasNone && sources.length > 1) {
        warnings.push({ level: 'warn', message: '"' + name + '" 中 \'none\' 与其他来源并存：按规范 \'none\' 会被忽略，其余来源仍然生效' });
      }
      var hasNonceOrHash = sources.some(function (s) { return s.kind === 'nonce' || s.kind === 'hash'; });
      var hasUnsafeInline = sources.some(function (s) { return s.kind === 'keyword' && s.value === "'unsafe-inline'"; });
      if (hasNonceOrHash && hasUnsafeInline) {
        warnings.push({ level: 'info', message: '"' + name + '" 同时包含 nonce/哈希与 \'unsafe-inline\'：支持 CSP3 的浏览器会忽略 \'unsafe-inline\'' });
      }
      if (sources.some(function (s) { return s.kind === 'keyword' && s.value === "'unsafe-eval'"; })) {
        warnings.push({ level: 'info', message: '"' + name + '" 包含 \'unsafe-eval\'：它只影响 eval 等动态执行，本检查器不模拟该行为' });
      }

      directives.set(name, { name: name, sources: sources, raw: trimmed });
    });

    return { text: String(text), directives: directives, warnings: warnings };
  }

  /* ---------------- URL 与页面来源 ---------------- */

  // 解析（可能是相对的）URL，返回 { scheme, host, port, path }
  function parseUrl(urlText, pageUrl) {
    var u = new URL(urlText, pageUrl);
    return {
      scheme: u.protocol.replace(':', '').toLowerCase(),
      host: u.hostname.toLowerCase(),
      port: u.port, // URL 已把默认端口归一化为空串
      path: u.pathname
    };
  }

  function parsePageOrigin(pageUrlText) {
    var p = parseUrl(pageUrlText, undefined);
    if (!p.scheme || !p.host) throw new Error('页面地址不完整');
    return p;
  }

  /* ---------------- 匹配规则 ---------------- */

  function schemeMatches(expected, actual) {
    if (expected === actual) return true;
    var ups = SCHEME_UPGRADES[expected] || [];
    return ups.indexOf(actual) !== -1;
  }

  // 主机匹配：精确匹配或 *. 后缀匹配；不做文本前缀匹配，
  // 因此 cdn.example.com.evil.com 不会匹配 cdn.example.com，
  // example.com 也不会匹配 *.example.com
  function hostMatches(sourceHost, urlHost) {
    if (sourceHost === '*') return true;
    if (sourceHost.indexOf('*.') === 0) {
      var suffix = sourceHost.slice(1); // ".example.com"
      return urlHost.length > suffix.length && urlHost.slice(-suffix.length) === suffix;
    }
    return sourceHost === urlHost;
  }

  function effectivePort(port, scheme) {
    return port || defaultPort(scheme) || '';
  }

  function portMatches(source, url) {
    if (source.port === '*') return true;
    var urlPort = effectivePort(url.port, url.scheme);
    if (source.port) return String(source.port) === String(urlPort);
    // 来源未写端口时，与 URL 自身协议的默认端口比较（配合协议升级规则）
    var expected = defaultPort(url.scheme);
    return expected === null || String(urlPort) === String(expected);
  }

  // 路径匹配：以 / 结尾为前缀匹配，否则精确匹配
  function pathMatches(sourcePath, urlPath) {
    if (!sourcePath) return true;
    if (sourcePath.slice(-1) === '/') return urlPath.indexOf(sourcePath) === 0;
    return urlPath === sourcePath;
  }

  // 判断单个来源表达式是否匹配一个外部 URL
  function matchSourceExternal(source, url, pageOrigin) {
    if (source.kind === 'keyword') {
      if (source.value === "'self'") {
        return url.scheme === pageOrigin.scheme &&
          url.host === pageOrigin.host &&
          effectivePort(url.port, url.scheme) === effectivePort(pageOrigin.port, pageOrigin.scheme);
      }
      return false; // 'none' 及其他关键字不匹配任何外部地址
    }
    if (source.kind === 'scheme') {
      return schemeMatches(source.scheme, url.scheme);
    }
    if (source.kind === 'host') {
      var refScheme = source.scheme || pageOrigin.scheme;
      return schemeMatches(refScheme, url.scheme) &&
        hostMatches(source.host, url.host) &&
        portMatches(source, url) &&
        pathMatches(source.path, url.path);
    }
    return false; // nonce/hash/invalid 不匹配外部地址
  }

  /* ---------------- 指令评估 ---------------- */

  // 评估一条指令对某个资源的放行结果
  // resource: { inline, url?, nonce?, hash? }
  function evaluateDirective(directive, resource, pageOrigin) {
    var sources = directive.sources;
    if (sources.length === 0) {
      return { allowed: false, matched: null, reason: '指令没有来源表达式，等同于 \'none\'' };
    }

    if (resource.inline) {
      var nonces = sources.filter(function (s) { return s.kind === 'nonce'; });
      var hashes = sources.filter(function (s) { return s.kind === 'hash'; });

      if (resource.nonce) {
        for (var i = 0; i < nonces.length; i++) {
          if (nonces[i].value === resource.nonce) {
            return { allowed: true, matched: nonces[i].raw, reason: '内联标记 nonce 与 ' + nonces[i].raw + ' 相符' };
          }
        }
      }
      if (resource.hash) {
        for (var j = 0; j < hashes.length; j++) {
          var hv = hashes[j].algo + '-' + hashes[j].value;
          if (hv.toLowerCase() === resource.hash.toLowerCase()) {
            return { allowed: true, matched: hashes[j].raw, reason: '内容摘要与 ' + hashes[j].raw + ' 相符' };
          }
        }
      }
      var unsafeInline = sources.some(function (s) {
        return s.kind === 'keyword' && s.value === "'unsafe-inline'";
      });
      if (unsafeInline && nonces.length === 0 && hashes.length === 0) {
        return { allowed: true, matched: "'unsafe-inline'", reason: "'unsafe-inline' 允许所有内联内容" };
      }
      if (unsafeInline) {
        return { allowed: false, matched: null, reason: '存在 nonce/哈希时 CSP3 浏览器会忽略 \'unsafe-inline\'，且提供的标记不相符' };
      }
      if (resource.nonce || resource.hash) {
        return { allowed: false, matched: null, reason: '提供的 nonce/哈希与指令中的标记不相符' };
      }
      return { allowed: false, matched: null, reason: '内联内容未被 nonce/哈希授权，且未启用 \'unsafe-inline\'' };
    }

    for (var k = 0; k < sources.length; k++) {
      if (matchSourceExternal(sources[k], resource.url, pageOrigin)) {
        return { allowed: true, matched: sources[k].raw, reason: '匹配来源表达式 ' + sources[k].raw };
      }
    }
    return { allowed: false, matched: null, reason: '指令中没有任何来源表达式匹配该地址' };
  }

  // 对一组策略评估一个资源；所有策略都放行才算放行
  function evaluateResource(policies, resource, pageOrigin) {
    var directiveName = FETCH_DIRECTIVES[resource.type];
    var perPolicy = policies.map(function (policy, i) {
      var directive = policy.directives.get(directiveName);
      var usedFallback = false;
      if (!directive) {
        directive = policy.directives.get('default-src');
        usedFallback = true;
      }
      if (!directive) {
        return {
          index: i, allowed: true, directiveName: null, usedFallback: false,
          matched: null, reason: '该策略未设置 ' + directiveName + ' 和 default-src，不施加限制'
        };
      }
      var r = evaluateDirective(directive, resource, pageOrigin);
      return {
        index: i, allowed: r.allowed, directiveName: directive.name,
        usedFallback: usedFallback, matched: r.matched, reason: r.reason
      };
    });
    var allowed = perPolicy.every(function (p) { return p.allowed; });
    return { allowed: allowed, directiveName: directiveName, perPolicy: perPolicy };
  }

  /* ---------------- 资源清单解析 ---------------- */

  // 解析资源清单中的一行："类型 地址|inline [nonce=...] [hash=...]"
  function parseResourceLine(line) {
    var tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    var type = tokens[0].toLowerCase();
    if (!FETCH_DIRECTIVES[type]) {
      throw new Error('未知资源类型 "' + tokens[0] + '"（支持：' + Object.keys(FETCH_DIRECTIVES).join(', ') + '）');
    }
    var target = tokens[1];
    if (!target) throw new Error('缺少资源地址（URL 或 inline）');
    var attrs = {};
    for (var i = 2; i < tokens.length; i++) {
      var eq = tokens[i].indexOf('=');
      if (eq === -1) throw new Error('无法理解的附加标记 "' + tokens[i] + '"（应为 nonce=... 或 hash=...）');
      attrs[tokens[i].slice(0, eq).toLowerCase()] = tokens[i].slice(eq + 1);
    }
    var inline = target.toLowerCase() === 'inline';
    if (!inline && (attrs.nonce || attrs.hash)) {
      throw new Error('nonce/hash 标记仅适用于 inline 资源');
    }
    if (attrs.hash && !/^(sha256|sha384|sha512)-[A-Za-z0-9+/=_-]+$/.test(attrs.hash)) {
      throw new Error('hash 标记格式应为 sha256-/sha384-/sha512- 加摘要值');
    }
    return {
      type: type, target: target, inline: inline,
      nonce: attrs.nonce || null, hash: attrs.hash || null,
      raw: line.trim()
    };
  }

  return {
    FETCH_DIRECTIVES: FETCH_DIRECTIVES,
    parsePolicy: parsePolicy,
    parseSourceToken: parseSourceToken,
    parseUrl: parseUrl,
    parsePageOrigin: parsePageOrigin,
    parseResourceLine: parseResourceLine,
    evaluateDirective: evaluateDirective,
    evaluateResource: evaluateResource,
    matchSourceExternal: matchSourceExternal,
    hostMatches: hostMatches,
    defaultPort: defaultPort
  };
});
