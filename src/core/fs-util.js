// 安全读取本地文件：大小双保险（stat 预检 + 流内硬计数，防 TOCTOU 替换）、
// sha256 指纹、JSON 解析错误行列定位。绝不使用 require()/import() 加载用户文件。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError, ERROR_CODES } from './errors.js';

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 从 V8 SyntaxError 消息或自行换算得到 JSON 错误的行列位置。
export function locateJsonError(text, err) {
  const message = err && typeof err.message === 'string' ? err.message : 'JSON 解析失败';
  let position = -1;
  let line = -1;
  let column = -1;

  const posMatch = message.match(/position\s+(\d+)/i);
  if (posMatch) position = Number(posMatch[1]);

  const lcMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lcMatch) {
    line = Number(lcMatch[1]);
    column = Number(lcMatch[2]);
  }

  if (position >= 0 && (line < 0 || column < 0)) {
    // position 基于去除 BOM 前的原始字符串，这里基于去掉 BOM 的文本换算并修正。
    const bomOffset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const before = text.slice(0, Math.max(0, position - bomOffset));
    const lines = before.split('\n');
    line = lines.length;
    column = lines[lines.length - 1].length + 1;
  }

  if (line < 0 || column < 0) {
    // 消息不含任何位置信息时的最终兜底：指向首个字符，保证行列始终可用
    line = 1;
    column = 1;
  }

  return { message: `JSON 解析失败：${message}`, line, column, position };
}

// 流式读取，读取过程中字节数超过 hardLimit 立即中止。
function readLimited(filePath, hardLimit) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks = [];
    let total = 0;
    let aborted = false;

    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > hardLimit) {
        aborted = true;
        stream.destroy();
        reject(
          new AppError(ERROR_CODES.FILE_TOO_LARGE, `文件超过大小上限 ${hardLimit} 字节`, {
            limitBytes: hardLimit,
            actualBytes: total,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    stream.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

// 读取并解析 JSON 文件，返回数据、字节数与 sha256。
export async function readJsonFile(filePath, maxBytes) {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    throw new AppError(ERROR_CODES.FILE_NOT_FOUND, `找不到文件：${filePath}`, { filePath });
  }
  if (!stats.isFile()) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, `路径不是普通文件：${filePath}`, {
      filePath,
    });
  }
  if (stats.size > maxBytes) {
    throw new AppError(
      ERROR_CODES.FILE_TOO_LARGE,
      `文件 ${stats.size} 字节，超过大小上限 ${maxBytes} 字节`,
      { limitBytes: maxBytes, actualBytes: stats.size, filePath },
    );
  }

  const buf = await readLimited(filePath, maxBytes);
  const sizeBytes = buf.length;
  const sha256 = sha256Buffer(buf);
  const text = stripBom(buf.toString('utf8'));

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const loc = locateJsonError(text, err);
    throw new AppError(
      ERROR_CODES.JSON_PARSE_ERROR,
      `JSON 解析失败（第 ${loc.line} 行第 ${loc.column} 列）：${loc.message}`,
      { ...loc, filePath },
    );
  }
  return { data, sizeBytes, sha256 };
}

// 解析来自字符串的 JSON（Web 上传内容），同样做大小限制与错误定位。
export function parseJsonText(content, maxBytes, sourceLabel = '输入内容') {
  if (typeof content !== 'string') {
    throw new AppError(ERROR_CODES.JSON_PARSE_ERROR, `${sourceLabel} 不是文本`);
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > maxBytes) {
    throw new AppError(
      ERROR_CODES.REQUEST_TOO_LARGE,
      `${sourceLabel} ${byteLength} 字节，超过上限 ${maxBytes} 字节`,
      { limitBytes: maxBytes, actualBytes: byteLength },
    );
  }
  const text = stripBom(content);
  try {
    return { data: JSON.parse(text), sizeBytes: byteLength };
  } catch (err) {
    const loc = locateJsonError(text, err);
    throw new AppError(
      ERROR_CODES.JSON_PARSE_ERROR,
      `${sourceLabel} JSON 解析失败（第 ${loc.line} 行第 ${loc.column} 列）：${loc.message}`,
      loc,
    );
  }
}
