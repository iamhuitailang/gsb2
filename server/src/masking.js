// 个人敏感字段的日志遮蔽。所有写入日志 / 推送到前端的文本都经过 mask()。
// 明文只保存在本地 SQLite 与模拟后台，不出现在任何日志行里。

const SENSITIVE_KEYS = [
  'applicantName', // 姓名
  'phone', // 手机号
  'idCard', // 身份证号
  'email', // 邮箱
  'address', // 住址
  'bankAccount', // 银行账号
];

export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key);
}

function maskPhone(v) {
  const s = String(v);
  if (s.length < 7) return '***';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function maskName(v) {
  const s = String(v);
  if (s.length <= 1) return '*';
  if (s.length === 2) return `${s[0]}*`;
  return `${s[0]}${'*'.repeat(s.length - 2)}${s.slice(-1)}`;
}

function maskIdCard(v) {
  const s = String(v);
  if (s.length < 6) return '***';
  return `${s.slice(0, 4)}**********${s.slice(-4)}`;
}

function maskEmail(v) {
  const s = String(v);
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  return `${name.slice(0, 1)}***${domain}`;
}

function maskAddress(v) {
  const s = String(v);
  // 保留省/市等粗粒度前缀，遮蔽详细门牌
  return s.length > 6 ? `${s.slice(0, 6)}***` : '***';
}

function maskBank(v) {
  const s = String(v);
  if (s.length < 4) return '***';
  return `****${s.slice(-4)}`;
}

export function maskField(key, value) {
  if (value === null || value === undefined || value === '') return value;
  switch (key) {
    case 'phone':
      return maskPhone(value);
    case 'applicantName':
      return maskName(value);
    case 'idCard':
      return maskIdCard(value);
    case 'email':
      return maskEmail(value);
    case 'address':
      return maskAddress(value);
    case 'bankAccount':
      return maskBank(value);
    default:
      return value;
  }
}

// 对一条记录做整体遮蔽（用于日志、SSE、前端展示以外的场景）
export function maskRecord(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = isSensitiveKey(k) ? maskField(k, v) : v;
  }
  return out;
}

// 遮蔽任意文本中可能出现的手机号 / 身份证号 / 邮箱（兜底，防止堆栈信息泄漏）
export function maskText(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  s = s.replace(/\b1[3-9]\d{9}\b/g, (m) => maskPhone(m));
  s = s.replace(/\b\d{17}[\dXx]\b/g, (m) => maskIdCard(m));
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => maskEmail(m));
  return s;
}
