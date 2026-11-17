import crypto from 'node:crypto';

export function send(res, status, headers, body = '') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

export function sendJson(res, status, value, headers = {}) {
  send(
    res,
    status,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
    JSON.stringify(value),
  );
}

export function sendText(res, status, text, headers = {}) {
  send(
    res,
    status,
    {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
    text,
  );
}

/** 读取 JSON 请求体并限制大小；非 JSON 直接拒绝。 */
export async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function randomId(prefix = 'rpt') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 标题、文件名来自导入者，只当作纯文本使用：
 * 去掉控制字符、裁剪长度，绝不参与文件路径拼接。
 */
export function normalizeLabel(value, fallback, maxLength = 200) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLength);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Host 头校验：只接受配置中的源，防止 DNS 重绑定。 */
export function hostMatches(req, host, port) {
  const header = req.headers.host ?? '';
  return header === `${host}:${port}`;
}
