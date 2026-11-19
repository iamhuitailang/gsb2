// 核心数据模型工厂与常量。记录容器一律用 Map；本模块的工厂只产出普通数据对象，
// 不把锁文件中的任意 key 挂到原型对象上。

export const SOURCE_TYPES = Object.freeze({
  REGISTRY: 'registry',
  HTTP_TARBALL: 'http-tarball',
  GIT: 'git',
  FILE: 'file',
  LINK: 'link',
  UNKNOWN: 'unknown',
});

export const RELATIONSHIPS = Object.freeze({
  ROOT: 'root',
  DIRECT: 'direct',
  TRANSITIVE: 'transitive',
  UNREACHABLE: 'unreachable',
});

export const RULE_IDS = Object.freeze({
  RESOLVED_MISSING: 'RESOLVED_MISSING',
  RESOLVED_OMITTED_V3: 'RESOLVED_OMITTED_V3',
  RESOLVED_HOST_UNTRUSTED: 'RESOLVED_HOST_UNTRUSTED',
  RESOLVED_SCHEME_NOT_ALLOWED: 'RESOLVED_SCHEME_NOT_ALLOWED',
  RESOLVED_NON_REGISTRY_GIT: 'RESOLVED_NON_REGISTRY_GIT',
  RESOLVED_NON_REGISTRY_FILE: 'RESOLVED_NON_REGISTRY_FILE',
  RESOLVED_NON_REGISTRY_LINK: 'RESOLVED_NON_REGISTRY_LINK',
  RESOLVED_NAME_MISMATCH: 'RESOLVED_NAME_MISMATCH',
  ALIAS_NAME_MISMATCH: 'ALIAS_NAME_MISMATCH',
  INTEGRITY_MISSING: 'INTEGRITY_MISSING',
  INTEGRITY_OMITTED_V3: 'INTEGRITY_OMITTED_V3',
  INTEGRITY_SRI_MALFORMED: 'INTEGRITY_SRI_MALFORMED',
  INTEGRITY_ALG_WEAK: 'INTEGRITY_ALG_WEAK',
  INTEGRITY_ALG_NOT_ALLOWED: 'INTEGRITY_ALG_NOT_ALLOWED',
  PACKAGE_UNREACHABLE: 'PACKAGE_UNREACHABLE',
  DIFF_RESOLVED_HOST_CHANGED: 'DIFF_RESOLVED_HOST_CHANGED',
  DIFF_RESOLVED_URL_CHANGED: 'DIFF_RESOLVED_URL_CHANGED',
  DIFF_VERSION_CHANGED: 'DIFF_VERSION_CHANGED',
  DIFF_INTEGRITY_CHANGED: 'DIFF_INTEGRITY_CHANGED',
  DIFF_NAME_CHANGED: 'DIFF_NAME_CHANGED',
  DIFF_ADDED: 'DIFF_ADDED',
  DIFF_REMOVED: 'DIFF_REMOVED',
});

let recordSeq = 0;
let findingSeq = 0;

export function createPackageRecord(partial) {
  return {
    recordId: `rec-${(recordSeq += 1)}`,
    key: '',
    lockfileVersion: null,
    name: null,
    basename: null,
    declaredName: null,
    alias: false,
    version: null,
    relationship: RELATIONSHIPS.UNREACHABLE,
    resolved: null,
    sourceType: SOURCE_TYPES.UNKNOWN,
    scheme: null,
    host: null,
    port: null,
    integrity: null,
    integrityParsed: [],
    integrityVerified: false, // 恒为 false：本工具不下载压缩包
    integrityStatus: null,
    omittedFields: [],
    inferred: false,
    from: null,
    link: false,
    dev: false,
    optional: false,
    location: '',
    raw: null,
    ...partial,
  };
}

export function createFinding(partial) {
  return {
    id: `find-${(findingSeq += 1)}`,
    ruleId: null,
    severity: 'info',
    title: '',
    message: '',
    recordId: null,
    packageKey: null,
    name: null,
    version: null,
    expected: {},
    actual: {},
    evidence: {},
    verified: false,
    status: null,
    source: 'lockfile',
    ...partial,
  };
}

// 测试之间重置自增序号，保证快照稳定。
export function resetSequences() {
  recordSeq = 0;
  findingSeq = 0;
}
