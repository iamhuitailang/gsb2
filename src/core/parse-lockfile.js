// package-lock.json 解析器：v1 嵌套 dependencies 树与 v2/v3 packages 位置映射
// 统一转成 Map<安装位置, PackageRecord>。同一包的不同嵌套位置分别保留，不去重。
import { AppError, ERROR_CODES } from './errors.js';
import { createPackageRecord, RELATIONSHIPS, SOURCE_TYPES } from './model.js';
import { classifyResolved } from './url-source.js';
import { parseIntegrity } from './sri.js';

const SUPPORTED_VERSIONS = new Set([1, 2, 3]);
const ROOT_KEY = '';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 取安装位置的包目录名：按最后一个 /node_modules/ 切分，scoped 包整体保留。
export function basenameOf(locationKey) {
  if (locationKey === ROOT_KEY) return null;
  const marker = '/node_modules/';
  const idx = locationKey.lastIndexOf(marker);
  if (idx >= 0) return locationKey.slice(idx + marker.length);
  // 容错根级位置（无前导斜杠）：node_modules/<name>
  const prefix = 'node_modules/';
  if (locationKey.startsWith(prefix)) {
    const rest = locationKey.slice(prefix.length);
    // scoped 包整体返回；普通包若含意外斜杠取最后一段
    if (rest.startsWith('@')) {
      const parts = rest.split('/');
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : rest;
    }
    return rest.includes('/') ? rest.slice(rest.lastIndexOf('/') + 1) : rest;
  }
  // 最终兜底：scoped 名整体返回，普通名取最后一段
  if (locationKey.startsWith('@')) return locationKey;
  const segs = locationKey.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? locationKey;
}

// 合并条目四类依赖声明，保留 name -> spec 供建图与别名判定。
function collectDeps(entry) {
  const deps = new Map();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const obj = entry[field];
    if (isPlainObject(obj)) {
      for (const [name, spec] of Object.entries(obj)) {
        if (!deps.has(name)) deps.set(name, String(spec));
      }
    }
  }
  return deps;
}

// 从 v1 的 from 字段识别 npm 别名：形态 "<alias>@npm:<real-name>@<range>"。
// 返回真实包名，无法识别时返回 null。
function realNameFromV1From(from) {
  if (typeof from !== 'string') return null;
  const m = from.match(/(?:^|.*?)npm:(.+?)@/);
  if (!m) return null;
  const real = m[1];
  return real && !real.includes('/') ? real : real;
}

function buildRecord({ key, entry, lockfileVersion, source }) {
  const basename = basenameOf(key);
  let declaredName = typeof entry.name === 'string' ? entry.name : null;
  // v1 没有独立 name 字段：尽力从 from 的 npm: 别名中还原真实包名
  if (declaredName === null && lockfileVersion === 1) {
    const fromReal = realNameFromV1From(entry.from);
    if (fromReal && fromReal !== basename) declaredName = fromReal;
  }
  const resolved = entry.resolved === undefined ? null : String(entry.resolved);
  const integrity = entry.integrity === undefined ? null : String(entry.integrity);
  const cls = classifyResolved(resolved);

  const omittedFields = [];
  if (entry.resolved === undefined) omittedFields.push('resolved');
  if (entry.integrity === undefined) omittedFields.push('integrity');

  const alias = declaredName !== null && basename !== null && declaredName !== basename;
  const parsedIntegrity = integrity === null ? { present: false, tokens: [], overallValid: false } : parseIntegrity(integrity);

  const rec = createPackageRecord({
    key,
    location: key,
    lockfileVersion,
    name: declaredName ?? basename,
    basename,
    declaredName,
    alias,
    version: entry.version === undefined ? null : String(entry.version),
    resolved,
    sourceType: cls.sourceType,
    scheme: cls.scheme,
    host: cls.host,
    port: cls.port,
    integrity,
    integrityParsed: parsedIntegrity.tokens,
    omittedFields,
    inferred: omittedFields.length > 0,
    from: entry.from === undefined ? null : String(entry.from),
    link: entry.link === true,
    dev: entry.dev === true || entry.devOptional === true,
    optional: entry.optional === true || entry.devOptional === true,
    relationship: key === ROOT_KEY ? RELATIONSHIPS.ROOT : RELATIONSHIPS.UNREACHABLE,
    // 原始字段快照作为证据；原样保留，不做改写
    raw: entry,
  });

  if (rec.link) rec.sourceType = SOURCE_TYPES.LINK;
  return rec;
}

// v2/v3：遍历 packages 映射。
function parsePackages(data, lockfileVersion) {
  const packages = data.packages;
  if (!isPlainObject(packages)) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, 'packages 字段不是对象', {
      lockfileVersion,
    });
  }
  const records = new Map();
  // key -> (依赖名 -> spec)，供 graph 建边
  const rawDeps = new Map();

  for (const [key, entry] of Object.entries(packages)) {
    if (!isPlainObject(entry)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_STRUCTURE,
        `packages["${key}"] 不是对象，锁文件结构不受支持`,
      );
    }
    if (records.has(key)) {
      throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, `packages 中出现重复位置键：${key}`);
    }
    records.set(key, buildRecord({ key, entry, lockfileVersion, source: 'packages' }));
    rawDeps.set(key, collectDeps(entry));
  }

  if (!records.has(ROOT_KEY)) {
    // 没有根条目仍可分析，但图需要一个虚拟根
    records.set(
      ROOT_KEY,
      createPackageRecord({
        key: ROOT_KEY,
        location: ROOT_KEY,
        lockfileVersion,
        name: null,
        relationship: RELATIONSHIPS.ROOT,
        raw: Object.create(null),
      }),
    );
    rawDeps.set(ROOT_KEY, new Map());
  }
  return { records, rawDeps, rootKey: ROOT_KEY };
}

// v1：递归 walk dependencies 树，合成 node_modules 风格的虚拟位置键。
function parseV1Tree(data) {
  const lockfileVersion = 1;
  const records = new Map();
  const rawDeps = new Map();

  // 虚拟根，承载顶层依赖
  records.set(
    ROOT_KEY,
    createPackageRecord({
      key: ROOT_KEY,
      location: ROOT_KEY,
      lockfileVersion,
      name: null,
      relationship: RELATIONSHIPS.ROOT,
      raw: data,
    }),
  );
  const rootDeps = new Map();

  const walk = (depsObj, parentKey) => {
    if (!isPlainObject(depsObj)) return;
    for (const [depName, entry] of Object.entries(depsObj)) {
      if (!isPlainObject(entry)) continue;
      const key = parentKey === ROOT_KEY ? `node_modules/${depName}` : `${parentKey}/node_modules/${depName}`;
      if (!records.has(key)) {
        records.set(key, buildRecord({ key, entry, lockfileVersion, source: 'dependencies-tree' }));
        // v1 依赖边来自 requires（模块名 -> 版本要求）
        const req = new Map();
        if (isPlainObject(entry.requires)) {
          for (const [n, spec] of Object.entries(entry.requires)) req.set(n, String(spec));
        }
        rawDeps.set(key, req);
      }
      if (parentKey === ROOT_KEY && !rootDeps.has(depName)) {
        rootDeps.set(depName, entry.version ? String(entry.version) : '*');
      }
      if (isPlainObject(entry.dependencies)) walk(entry.dependencies, key);
    }
  };

  walk(data.dependencies, ROOT_KEY);
  rawDeps.set(ROOT_KEY, rootDeps);
  return { records, rawDeps, rootKey: ROOT_KEY };
}

export function parseLockfile(data, { fileName = '<input>' } = {}) {
  if (!isPlainObject(data)) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_STRUCTURE, '锁文件根节点不是 JSON 对象', { fileName });
  }
  if (!('lockfileVersion' in data)) {
    throw new AppError(
      ERROR_CODES.UNSUPPORTED_STRUCTURE,
      '缺少 lockfileVersion 字段，可能是 npm v5 之前的 shrinkwrap 或非 package-lock 文件',
      { fileName },
    );
  }
  const version = data.lockfileVersion;
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new AppError(
      ERROR_CODES.UNKNOWN_LOCKFILE_VERSION,
      `不支持的 lockfileVersion：${version}（仅支持 1/2/3）`,
      { lockfileVersion: version, fileName },
    );
  }

  let parsed;
  if (version === 1) {
    if (!isPlainObject(data.dependencies)) {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_STRUCTURE,
        'lockfileVersion 1 的锁文件缺少 dependencies 树',
        { fileName },
      );
    }
    parsed = parseV1Tree(data);
  } else {
    // v2/v3：优先 packages；v2 可能同时带 legacy dependencies 段，审计以 packages 为准
    if (isPlainObject(data.packages)) {
      parsed = parsePackages(data, version);
    } else if (isPlainObject(data.dependencies)) {
      parsed = parseV1Tree(data);
    } else {
      throw new AppError(
        ERROR_CODES.UNSUPPORTED_STRUCTURE,
        `lockfileVersion ${version} 的锁文件既无 packages 也无 dependencies`,
        { fileName },
      );
    }
  }

  return {
    fileName,
    lockfileVersion: version,
    rootKey: parsed.rootKey,
    records: parsed.records,
    rawDeps: parsed.rawDeps,
  };
}
