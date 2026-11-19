/**
 * 规则定义模块（纯数据与正则，无任何外部依赖、无网络访问）。
 *
 * 规则分两类，互相独立、可分别启停：
 *  - field 规则：按字段名判定（用于结构化 JSON 的 key）
 *  - pattern 规则：按字段值/嵌套文本的内容判定（正则 + 校验函数）
 *
 * 设计原则：
 *  - 普通业务编号、日期、日志级别等无对应规则，不会被一概抹掉；
 *  - 所有模式都带边界约束或校验位（如身份证校验码、银行卡 Luhn），降低误报；
 *  - 每条模式规则通过 build() 返回全新的正则实例，避免带状态正则被复用。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SanLog = root.SanLog || {};
    Object.assign(root.SanLog, mod);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 规则集版本号：规则内容变化时升级，写入每条审计记录 */
  const RULE_VERSION = '2026.11.0-r1';

  /* ------------------------------------------------------------------ */
  /* 字段名规则：normalize 后做精确匹配 / 后缀匹配，避免误伤 order_id 等 */
  /* ------------------------------------------------------------------ */
  const FIELD_RULES = [
    {
      id: 'FIELD_PASSWORD',
      type: 'password',
      label: '密码/口令字段',
      description: '字段名表明其内容为登录密码或口令（password、pwd、secret 等）',
      keywords: ['password', 'passwd', 'pwd', 'secret', 'password_hash'],
      suffixes: ['_password', '_pwd', '_secret'],
    },
    {
      id: 'FIELD_TOKEN',
      type: 'token',
      label: '令牌/会话字段',
      description: '字段名表明其内容为访问令牌或会话标识（token、session_id 等）',
      keywords: ['token', 'access_token', 'refresh_token', 'auth_token', 'session_id', 'sessionid', 'sid', 'jwt'],
      suffixes: ['_token', '_session'],
    },
    {
      id: 'FIELD_SECRET_KEY',
      type: 'secret_key',
      label: '密钥/API 密钥字段',
      description: '字段名表明其内容为应用密钥或客户端密钥（api_key、client_secret 等）',
      keywords: ['api_key', 'apikey', 'app_secret', 'appsecret', 'secret_key', 'client_secret', 'secretkey', 'access_key_secret', 'secret_access_key', 'aws_secret_access_key'],
      suffixes: ['_api_key', '_secret', '_key_secret'],
    },
    {
      id: 'FIELD_AK',
      type: 'ak',
      label: '访问密钥 ID 字段',
      description: '字段名表明其内容为云厂商访问密钥 ID（access_key、ak 等）',
      keywords: ['access_key', 'accesskey', 'access_key_id', 'ak', 'aws_access_key_id', 'aws_ak'],
      suffixes: ['_access_key', '_access_key_id', '_ak'],
    },
    {
      id: 'FIELD_AUTHORIZATION',
      type: 'authorization',
      label: 'Authorization 认证头字段',
      description: 'HTTP Authorization 头及其等价字段',
      keywords: ['authorization', 'auth_header', 'http_authorization'],
      suffixes: [],
    },
    {
      id: 'FIELD_PRIVATE_KEY',
      type: 'private_key',
      label: '私钥字段',
      description: '字段名表明其内容为非对称私钥（private_key 等）',
      keywords: ['private_key', 'privatekey', 'ssh_private_key'],
      suffixes: [],
    },
    {
      id: 'FIELD_ID_CARD',
      type: 'cn_id_card',
      label: '身份证号字段',
      description: '字段名表明其内容为中国居民身份证号',
      keywords: ['id_card', 'idcard', 'id_card_no', 'identity_card', 'citizen_id'],
      suffixes: ['_id_card', '_idcard'],
    },
    {
      id: 'FIELD_PHONE',
      type: 'phone',
      label: '手机号字段',
      description: '字段名表明其内容为手机号码（phone、mobile 等）',
      keywords: ['phone', 'mobile', 'cellphone', 'phone_number', 'tel', 'telephone', 'contact_phone'],
      suffixes: ['_phone', '_mobile', '_tel'],
    },
    {
      id: 'FIELD_EMAIL',
      type: 'email',
      label: '邮箱字段',
      description: '字段名表明其内容为电子邮箱地址',
      keywords: ['email', 'mail', 'e_mail', 'email_address', 'contact_email'],
      suffixes: ['_email', '_mail'],
    },
    {
      id: 'FIELD_BANK_CARD',
      type: 'bank_card',
      label: '银行卡/账户字段',
      description: '字段名表明其内容为银行卡号或银行账号（card_no、bank_account 等）',
      keywords: ['bank_card', 'bankcard', 'card_no', 'card_number', 'bank_account', 'account_no'],
      suffixes: ['_card_no', '_card_number', '_account_no'],
    },
    {
      id: 'FIELD_ADDRESS',
      type: 'address',
      label: '住址字段',
      description: '字段名表明其内容为个人住址（address、addr 等）',
      keywords: ['address', 'home_address', 'residential_address', 'addr'],
      suffixes: ['_address', '_addr'],
    },
    {
      id: 'FIELD_NAME',
      type: 'name',
      label: '真实姓名字段',
      description: '字段名表明其内容为自然人真实姓名（real_name、full_name 等），不含普通登录名',
      keywords: ['real_name', 'full_name', 'person_name', 'customer_name'],
      suffixes: ['_real_name', '_full_name'],
    },
  ];

  /* ------------------------------------------------------------------ */
  /* 校验函数：身份证校验码、银行卡 Luhn                                  */
  /* ------------------------------------------------------------------ */
  function luhnCheck(digits) {
    if (!/^\d{15,19}$/.test(digits)) return false;
    let sum = 0;
    let alternate = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alternate) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alternate = !alternate;
    }
    return sum % 10 === 0;
  }

  function idCardCheck(id) {
    if (!/^\d{17}[\dXx]$/.test(id)) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * weights[i];
    return checkCodes[sum % 11] === id.charAt(17).toUpperCase();
  }

  /* ------------------------------------------------------------------ */
  /* 内容模式规则                                                        */
  /*  source: 'value-pattern' 可用于整值判定；全部也用于嵌套文本扫描     */
  /*  captureGroup: 文本命中时只替换捕获组（如 Bearer 后的令牌），        */
  /*                省略则替换整个匹配                                    */
  /* ------------------------------------------------------------------ */
  const PATTERN_RULES = [
    {
      id: 'PATTERN_PEM',
      type: 'private_key',
      label: 'PEM 私钥块',
      description: '-----BEGIN ... PRIVATE KEY----- 形式的 PEM 私钥',
      build: () => /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gd,
    },
    {
      id: 'PATTERN_BEARER',
      type: 'bearer',
      label: 'Bearer 令牌',
      description: 'Authorization: Bearer <token> 中的凭据部分，仅替换令牌本身',
      build: () => /(?<![A-Za-z0-9.])[Bb]earer\s+([A-Za-z0-9\-._~+/]+=*)/gd,
      captureGroup: 1,
    },
    {
      id: 'PATTERN_JWT',
      type: 'jwt',
      label: 'JWT',
      description: '三段式 JSON Web Token（header.payload.signature）',
      build: () => /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gd,
    },
    {
      id: 'PATTERN_AWS_AK',
      type: 'aws_ak',
      label: '云访问密钥 ID',
      description: 'AKIA 开头的 20 位访问密钥 ID',
      build: () => /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/gd,
    },
    {
      id: 'PATTERN_API_KEY',
      type: 'generic_api_key',
      label: '键值对形式的 API Key/Secret',
      description: '文本中 api_key=...、token: ...、secret="..." 等内联凭据，仅替换值部分',
      build: () => /(?<![A-Za-z0-9])(?:api[_-]?key|apikey|secret|token)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/gid,
      captureGroup: 1,
    },
    {
      id: 'PATTERN_EMAIL',
      type: 'email',
      label: '邮箱地址',
      description: '标准邮箱地址格式',
      build: () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gd,
    },
    {
      id: 'PATTERN_PHONE',
      type: 'phone',
      label: '中国大陆手机号',
      description: '11 位手机号，可带 +86/86 前缀；边界约束避免截断长数字',
      build: () => /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gd,
    },
    {
      id: 'PATTERN_ID_CARD',
      type: 'cn_id_card',
      label: '身份证号（含校验位）',
      description: '18 位身份证号并通过 ISO 校验码验证，过滤普通长数字',
      build: () => /(?<!\d)(\d{17}[\dXx])(?!\d)/gd,
      check: (m) => idCardCheck(m[1]),
    },
    {
      id: 'PATTERN_BANK_CARD',
      type: 'bank_card',
      label: '银行卡号（Luhn 校验）',
      description: '15-19 位连续数字并通过 Luhn 校验，过滤业务单号和时间戳',
      build: () => /(?<!\d)(\d{15,19})(?!\d)/gd,
      check: (m) => luhnCheck(m[1]),
    },
    {
      id: 'PATTERN_IPV4',
      type: 'ipv4',
      label: 'IPv4 地址（默认关闭）',
      description: '点分十进制 IPv4；可能与版本号等混淆，默认不启用',
      build: () => /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/gd,
      defaultEnabled: false,
    },
  ];

  const RULES_BY_ID = {};
  [...FIELD_RULES, ...PATTERN_RULES].forEach((r) => {
    RULES_BY_ID[r.id] = r;
  });

  const DEFAULT_ENABLED_IDS = [
    ...FIELD_RULES.map((r) => r.id),
    ...PATTERN_RULES.filter((r) => r.defaultEnabled !== false).map((r) => r.id),
  ];

  /** 归一化字段名：驼峰分词、连字符转下划线、全小写，便于跨命名风格匹配 */
  function normalizeKey(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // 小写/数字 后接大写：contactEmail -> contact_Email
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // 连续大写后接首字母大写词：AWSKey -> AWS_Key
      .replace(/-/g, '_')
      .toLowerCase()
      .trim();
  }

  /** 按字段名查找命中规则；未命中返回 null */
  function matchFieldName(key) {
    const k = normalizeKey(key);
    for (const rule of FIELD_RULES) {
      if (rule.keywords.includes(k)) return rule;
      if (rule.suffixes.some((s) => k.endsWith(s))) return rule;
    }
    return null;
  }

  /** 脱敏占位标记：[REDACTED:TYPE:序号]，序号在一次处理内按类型分配 */
  const REDACTION_MARKER_RE = /^\[REDACTED:[A-Z]+:\d{1,6}\]$/;
  const REDACTION_MARKER_IN_TEXT_RE = /\[REDACTED:[A-Z]+:\d{1,6}\]/g;
  function isRedactionMarker(s) {
    return typeof s === 'string' && REDACTION_MARKER_RE.test(s);
  }

  /** 类型 -> 标记中的大写前缀，全部规则共用一张表，保证命名一致 */
  const TYPE_PREFIX = {
    password: 'PASSWORD',
    token: 'TOKEN',
    secret_key: 'SECRET',
    ak: 'ACCESSKEY',
    authorization: 'AUTHORIZATION',
    private_key: 'PRIVATEKEY',
    cn_id_card: 'IDCARD',
    phone: 'PHONE',
    email: 'EMAIL',
    bank_card: 'BANKCARD',
    address: 'ADDRESS',
    name: 'NAME',
    bearer: 'BEARER',
    jwt: 'JWT',
    aws_ak: 'AWSAK',
    generic_api_key: 'APIKEY',
    ipv4: 'IP',
  };

  /**
   * 生成安全预览（仅用于界面展示）：保留少量头尾字符，绝不返回原值。
   * 审计记录不使用该函数，而是完全不存原文。
   */
  function maskPreview(type, raw) {
    const s = String(raw);
    const tail = (n) => (s.length > n * 2 ? `${s.slice(0, n)}****${s.slice(-n)}` : '****');
    switch (type) {
      case 'email': {
        const at = s.indexOf('@');
        if (at > 0) return `${s.charAt(0)}***${s.slice(at)}`;
        return '****';
      }
      case 'phone':
        return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : '****';
      case 'cn_id_card':
        return s.length >= 10 ? `${s.slice(0, 4)}**********${s.slice(-4)}` : '****';
      case 'bank_card':
        return s.length >= 4 ? `**** **** **** ${s.slice(-4)}` : '****';
      case 'ipv4': {
        const parts = s.split('.');
        return parts.length === 4 ? `${parts[0]}.*.*.*` : '****';
      }
      case 'jwt':
        return 'eyJ****.****.****';
      default:
        return tail(2);
    }
  }

  return {
    RULE_VERSION,
    FIELD_RULES,
    PATTERN_RULES,
    RULES_BY_ID,
    DEFAULT_ENABLED_IDS,
    normalizeKey,
    matchFieldName,
    luhnCheck,
    idCardCheck,
    REDACTION_MARKER_RE,
    REDACTION_MARKER_IN_TEXT_RE,
    isRedactionMarker,
    TYPE_PREFIX,
    maskPreview,
  };
});
