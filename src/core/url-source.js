// resolved 来源分类与主机提取。纯函数，不发起任何网络请求。
// 处理 registry tarball、http(s) 直链、git（git+ / scp-like / 缩写）、file、link。
import { SOURCE_TYPES } from './model.js';

const GIT_SHORTHAND_HOSTS = Object.freeze({
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  gist: 'gist.github.com',
});

// scp-like 形态：git@github.com:org/repo.git（无 scheme，含 user@ 与冒号路径）
const SCP_LIKE_RE = /^([^@/]+)@([^:/]+):(.+)$/;
const GIT_HOST_HINT_RE = /(^|\.)git$/i;

function emptyResult(overrides = {}) {
  return {
    sourceType: SOURCE_TYPES.UNKNOWN,
    scheme: null,
    host: null,
    port: null,
    shorthand: false,
    parseError: null,
    ...overrides,
  };
}

export function classifyResolved(resolved) {
  if (resolved === null || resolved === undefined || String(resolved).trim() === '') {
    return emptyResult();
  }
  const raw = String(resolved).trim();

  // 1. link: 工作区/软链
  if (raw.startsWith('link:')) {
    return emptyResult({ sourceType: SOURCE_TYPES.LINK });
  }

  // 2. file: 或裸本地路径（以 /、./、../ 开头，且不含 scheme）
  if (
    raw.startsWith('file:') ||
    raw.startsWith('/') ||
    raw.startsWith('./') ||
    raw.startsWith('../')
  ) {
    return emptyResult({ sourceType: SOURCE_TYPES.FILE });
  }

  // 3. git 缩写：github:org/repo、gitlab:…
  const shorthandMatch = raw.match(/^([a-z]+):(.+)$/i);
  if (shorthandMatch && GIT_SHORTHAND_HOSTS[shorthandMatch[1].toLowerCase()]) {
    return emptyResult({
      sourceType: SOURCE_TYPES.GIT,
      scheme: `${shorthandMatch[1].toLowerCase()}:`,
      host: GIT_SHORTHAND_HOSTS[shorthandMatch[1].toLowerCase()],
      shorthand: true,
    });
  }

  // 4. scp-like git 地址（无 scheme，不能交给 new URL）
  const scp = raw.match(SCP_LIKE_RE);
  if (scp && (GIT_HOST_HINT_RE.test(raw) || raw.includes('.git'))) {
    return emptyResult({
      sourceType: SOURCE_TYPES.GIT,
      scheme: 'ssh:',
      host: scp[2].toLowerCase(),
    });
  }

  // 5. git+ 前缀：剥离 git+ 后按常规 URL 解析
  let work = raw;
  let isGit = false;
  if (work.startsWith('git+')) {
    work = work.slice(4);
    isGit = true;
  }

  let url;
  try {
    url = new URL(work);
  } catch {
    return emptyResult({ parseError: '无法解析为合法 URL' });
  }

  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase() || null;
  const port = url.port || null;

  if (!isGit && (scheme === 'git:' || work.endsWith('.git') || /[#.]git\b/i.test(work))) {
    isGit = true;
  }
  if (scheme === 'ssh:') isGit = true;

  if (isGit) {
    return emptyResult({ sourceType: SOURCE_TYPES.GIT, scheme, host, port });
  }

  if (scheme === 'http:' || scheme === 'https:') {
    // registry tarball 与普通 http 直链的信任与否交给规则引擎按主机判定，
    // 这里统一标记为 http-tarball，不臆断其是否"官方"。
    return emptyResult({ sourceType: SOURCE_TYPES.HTTP_TARBALL, scheme, host, port });
  }

  // 其它 scheme（ftp: 等）：保留主机信息，来源类型标 unknown 由规则引擎提示
  return emptyResult({ sourceType: SOURCE_TYPES.UNKNOWN, scheme, host, port });
}

export function hostMatches(host, trustedHosts, matchSubdomains) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const trusted of trustedHosts) {
    const t = trusted.toLowerCase();
    if (h === t) return true;
    if (matchSubdomains && h.endsWith(`.${t}`)) return true;
  }
  return false;
}

// 从 registry tarball URL 抽取包名：
// https://host/left-pad/-/left-pad-1.3.0.tgz        → left-pad
// https://host/@scope/name/-/name-1.0.0.tgz         → @scope/name
// registry 形态中包名等于 /-/ 前的路径前缀；不符合形态返回 null。
export function extractTarballName(resolved) {
  if (typeof resolved !== 'string') return null;
  let pathname;
  try {
    pathname = new URL(resolved.replace(/^git\+/, '')).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/(.+)\/-\/[^/]+\.tgz$/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
