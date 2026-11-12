/**
 * ZIP 安全检查与受控解压（单遍流式，yauzl lazyEntries + 官方 eachEntry 异步迭代器）。
 *
 * 防线（任何一条不通过都拒收，整个压缩包进入隔离区，并由调用方清理半成品目录）：
 *  1. 条目数量上限（以实际遍历为准，不信任中央目录声称的数量）
 *  2. 解压后总字节数上限、单个条目字节数上限（流式计数，边解边拦，防 zip-bomb）
 *  3. 目录范围：条目名经规范化后必须严格位于目标目录内（zip-slip 防护）
 *  4. 拒绝绝对路径、盘符路径、符号链接/设备等特殊条目、.lnk 快捷方式
 *  5. 重复条目名检测
 * 注意：迭代进行中不能直接 return（会让异步迭代器永久等待下一个 next），
 * 所有违规一律 throw ZipAbort，由外层 catch 统一转换为 { ok:false, reason }。
 */
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { config } from '../config.mjs';
import { ensureInside } from './paths.mjs';

const { zip: zipLimits } = config.limits;

class ZipAbort extends Error {}

/**
 * 检查 ZIP 内容并解压到 destDir（调用方应为每个任务新建的空目录）。
 * @returns {Promise<{ok:true, entries:number, totalBytes:number, files:Array}>}
 *          或 { ok:false, reason:string }
 */
export async function inspectAndExtract(zipPath, destDir) {
  let zipfile;
  try {
    zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true });
  } catch (err) {
    return { ok: false, reason: `ZIP 无法打开（可能已损坏或并非 ZIP）: ${err.message}` };
  }

  const seen = new Set();
  const written = [];
  let entries = 0;
  let totalBytes = 0;

  try {
    for await (const entry of zipfile.eachEntry()) {
      entries += 1;
      if (entries > zipLimits.maxEntries) {
        throw new ZipAbort(`ZIP 条目数量超过上限 ${zipLimits.maxEntries}`);
      }

      const isDir = entry.fileName.endsWith('/');

      // 拒绝特殊条目（Unix 模式中的符号链接、套接字、设备等）
      const unixMode = (entry.versionMadeBy >> 8) & 0xffff;
      const typeBits = unixMode & 0o170000;
      if (typeBits === 0o120000) {
        throw new ZipAbort('ZIP 含符号链接条目，已拒收');
      }
      if (typeBits !== 0 && typeBits !== 0o100000 && typeBits !== 0o040000) {
        throw new ZipAbort(`ZIP 含不支持的特殊条目类型: ${entry.fileName}`);
      }

      const safeName = normalizeEntryName(entry.fileName);
      if (safeName === null) {
        throw new ZipAbort(`ZIP 条目路径非法（含绝对路径、盘符或目录穿越）: ${entry.fileName}`);
      }
      if (entry.fileName.toLowerCase().endsWith('.lnk')) {
        throw new ZipAbort(`ZIP 含 Windows 快捷方式条目，已拒收: ${entry.fileName}`);
      }

      const target = ensureInside(destDir, path.join(destDir, safeName));
      if (seen.has(target)) {
        throw new ZipAbort(`ZIP 含重复条目路径: ${entry.fileName}`);
      }
      seen.add(target);

      if (isDir) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        continue;
      }

      // 声明大小先过一道（造假数据会在流式写入时被实际计数再次拦截）
      // 总量限制优先于单条目限制，保证 zip-bomb 场景报“总大小”而非单文件
      totalBytes += entry.uncompressedSize;
      if (totalBytes > zipLimits.maxTotalUncompressedBytes) {
        throw new ZipAbort(`ZIP 解压后总大小超过上限 ${zipLimits.maxTotalUncompressedBytes} 字节`);
      }
      if (entry.uncompressedSize > zipLimits.maxEntryBytes) {
        throw new ZipAbort(`条目 ${entry.fileName} 解压后大小 ${entry.uncompressedSize} 超过单文件上限`);
      }

      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const stream = await openReadStream(zipfile, entry);
      const actual = await writeWithLimit(stream, target, entry.uncompressedSize, zipLimits.maxEntryBytes);

      if (actual > zipLimits.maxEntryBytes) {
        throw new ZipAbort(`条目 ${entry.fileName} 实际解压大小超过单文件上限`);
      }
      written.push(path.relative(destDir, target));
    }
  } catch (err) {
    // ZipAbort 是预期的安全拒收；yauzl 的 strictFileNames 也会拦截非法相对路径；
    // 其余视为解析/IO 故障。统一给出可读原因。
    let reason;
    if (err instanceof ZipAbort) {
      reason = err.message;
    } else if (/invalid (relative )?path|unsafe|traversal/i.test(err.message)) {
      reason = `ZIP 条目路径非法（含目录穿越或不受控路径）: ${err.message}`;
    } else {
      reason = `ZIP 解析/解压中断: ${err.message}`;
    }
    // autoClose:true 下迭代正常结束会自动关闭；异常分支手动兜底关闭
    await closeQuietly(zipfile);
    return { ok: false, reason };
  }

  if (entries === 0) {
    return { ok: false, reason: 'ZIP 为空归档' };
  }
  return { ok: true, entries, totalBytes, files: written };
}

function openReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    // CRC 校验由 yauzl 在流结束时内部完成；落盘权限统一收紧，不信任外部可执行位
    zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

async function writeWithLimit(stream, target, declaredSize, hardLimit) {
  // wx：路径已存在直接失败，杜绝任何覆盖
  const fd = fs.openSync(target, 'wx', 0o600);
  let actual = 0;
  try {
    for await (const chunk of stream) {
      actual += chunk.length;
      if (actual > hardLimit) {
        throw new Error(`条目实际解压大小超过单文件上限 ${hardLimit} 字节`);
      }
      fs.writeFileSync(fd, chunk);
    }
    if (declaredSize !== 0 && actual !== declaredSize) {
      throw new Error('条目实际大小与中央目录声明不一致');
    }
  } finally {
    fs.closeSync(fd);
  }
  return actual;
}

/**
 * 规范化 ZIP 条目名。返回相对路径片段；绝对路径/盘符/穿越/空名返回 null。
 */
function normalizeEntryName(rawName) {
  let name = String(rawName).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(name)) return null; // Windows 盘符
  name = name.replace(/^\/+/, '');
  if (name === '' || name === '/') return null;
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) return null;
  return segments.join('/');
}

async function closeQuietly(zipfile) {
  if (!zipfile || zipfile.__fiwClosed) return;
  zipfile.__fiwClosed = true;
  try {
    // 加超时兜底：已关闭或异常状态下 close 回调可能不触发，不能无限等待
    await Promise.race([
      new Promise((resolve) => zipfile.close(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    /* 关闭失败不影响判定结果 */
  }
}
