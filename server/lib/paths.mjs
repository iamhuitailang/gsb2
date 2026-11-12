/**
 * 路径安全工具：所有由外部输入（含 ZIP 条目名）派生的路径，
 * 在使用前必须通过 ensureInside 的包含关系校验，杜绝目录穿越（zip-slip 等）。
 */
import path from 'node:path';

/**
 * 规范化 candidate 并确认它严格位于 base 目录之内（或就是 base 本身）。
 * 使用 realpath 风格的前缀比较：先 path.resolve 消除 .. 与符号链接写法，
 * 再比较目录段，避免 /foo/bar-evil 冒充 /foo/bar 这类前缀攻击。
 */
export function ensureInside(base, candidate) {
  const realBase = path.resolve(base);
  const realCandidate = path.resolve(candidate);
  if (realCandidate === realBase) return realCandidate;
  const relative = path.relative(realBase, realCandidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error(`路径越界: ${relative || realCandidate}`);
    err.code = 'PATH_TRAVERSAL';
    throw err;
  }
  return realCandidate;
}

/**
 * 清理外部提供的文件名：只保留基础名、去掉控制字符与路径分隔符。
 * 注意：返回值仍只用于展示，绝不能作为存储路径使用。
 */
export function safeDisplayName(userName) {
  const base = path.basename(String(userName || '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  return base.slice(0, 180) || 'unnamed';
}
