// 浏览器调试台与 CLI 共用的装配层: 把引擎、目录、场景、规则集打包成可直接 import 的门面。
export {
  HINT_CATALOG,
  HINTS_BY_ID,
  GLOBAL_COOLDOWN_MS,
  RETRIGGER_COOLDOWN_MS,
  SKIP_COOLDOWN_MS,
  MAX_QUEUE,
  newAccountLearned,
  experiencedAccountLearned,
} from './catalog/hints.js';
export { TutorialCoordinator } from './core/coordinator.js';
export { ReplaySession } from './core/replay.js';
export { RULE_SETS, zoneFirstRules, rescueFirstRules } from './core/rules.js';
export {
  ALL_SCENARIOS,
  newAccountScenario,
  experiencedScenario,
  denseTriggerScenario,
  divergenceScenario,
} from './sim/scenarios.js';
export { runScenario } from './sim/runner.js';
export { compareRules } from './sim/compare.js';
