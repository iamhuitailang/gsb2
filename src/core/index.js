// 核心逻辑统一入口：浏览器与 Node（server/CLI/测试）共用同一份实现。
export { parsePolicy, parseHeaderText } from './parser.js';
export { lintPolicy, lintPolicies, lintAll } from './linter.js';
export { analyzeCoverage } from './coverage.js';
export { evaluateSample } from './evaluator.js';
export { comparePolicies } from './compare.js';
export {
  parseSourceToken,
  parseUrl,
  sourceMatches,
  canonicalSource,
  canonicalToken,
  breadthRank,
} from './sources.js';
export {
  FETCH_DIRECTIVES,
  DOCUMENT_DIRECTIVES,
  BOOLEAN_DIRECTIVES,
  KNOWN_DIRECTIVES,
  FALLBACK_CHAINS,
  RESOURCE_TYPE_LABELS,
  INLINE_CAPABLE,
} from './directives.js';
