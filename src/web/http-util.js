// node:http 辅助：请求体大小限制读取、统一 JSON 响应与错误码映射。
import { AppError, ERROR_CODES } from '../core/errors.js';

const ERROR_STATUS = Object.freeze({
  [ERROR_CODES.FILE_NOT_FOUND]: 404,
  [ERROR_CODES.FILE_TOO_LARGE]: 413,
  [ERROR_CODES.REQUEST_TOO_LARGE]: 413,
  [ERROR_CODES.JSON_PARSE_ERROR]: 400,
  [ERROR_CODES.INVALID_RULES]: 422,
  [ERROR_CODES.UNSUPPORTED_STRUCTURE]: 422,
  [ERROR_CODES.UNKNOWN_LOCKFILE_VERSION]: 422,
});

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, err) {
  if (err instanceof AppError) {
    const status = ERROR_STATUS[err.code] ?? 500;
    sendJson(res, status, {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        line: err.line,
        column: err.column,
        position: err.position,
        limitBytes: err.limitBytes,
        actualBytes: err.actualBytes,
        lockfileVersion: err.lockfileVersion,
      },
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: err?.message ?? '内部错误' },
  });
}

// 读取请求体，超过 maxBytes 立即停止并抛 REQUEST_TOO_LARGE。
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        req.destroy();
        reject(
          new AppError(ERROR_CODES.REQUEST_TOO_LARGE, `请求体超过上限 ${maxBytes} 字节`, {
            limitBytes: maxBytes,
            actualBytes: total,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new AppError(ERROR_CODES.JSON_PARSE_ERROR, `请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}
