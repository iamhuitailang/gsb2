import { HINTS_BY_ID } from '../catalog/hints.js';
import { ReplaySession } from '../core/replay.js';
import { compareRules } from './compare.js';
import {
  denseTriggerScenario,
  divergenceScenario,
  experiencedScenario,
  newAccountScenario,
} from './scenarios.js';
import { runScenario, type Scenario, type ScenarioRun } from './runner.js';

function title(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function printRun(run: ScenarioRun): void {
  process.stdout.write(`规则集: ${run.ruleSetId}\n`);
  process.stdout.write('上屏次序:\n');
  if (run.showOrder.length === 0) process.stdout.write('  (无提示上屏)\n');
  for (const rec of run.showOrder) {
    const spec = HINTS_BY_ID.get(rec.hintId);
    process.stdout.write(
      `  t=${String(rec.shownAt).padStart(6)}  ${rec.hintId.padEnd(12)} -> ${rec.ending.padEnd(9)}  ${spec?.title ?? ''}\n`,
    );
  }
  process.stdout.write('学习结论:\n');
  for (const [id, state] of Object.entries(run.learned)) {
    process.stdout.write(`  ${id.padEnd(12)} ${state.outcome.padEnd(9)} @t=${state.at}\n`);
  }
}

function printTraces(run: ScenarioRun, onlyKinds?: string[]): void {
  title('原因记录(每提示最近一次 trigger/filter/cancel 等)');
  for (const [id, entry] of Object.entries(run.coordinator.getAllTraces())) {
    if (onlyKinds && !onlyKinds.includes(entry.reason.kind)) continue;
    process.stdout.write(
      `  ${id.padEnd(12)} seq=${String(entry.seq).padStart(3)} t=${String(entry.now).padStart(6)}  ${JSON.stringify(entry.reason)}\n`,
    );
  }
}

function runOne(scenario: Scenario): void {
  title(`${scenario.label} [${scenario.id}]`);
  printRun(runScenario(scenario));
}

function demoCompare(): void {
  for (const scenario of [divergenceScenario, denseTriggerScenario]) {
    title(`规则对比: ${scenario.label}`);
    const cmp = compareRules(scenario);
    for (const meta of cmp.ruleSets) {
      process.stdout.write(`\n[${meta.id}] ${meta.label}\n`);
      process.stdout.write(`  次序: ${cmp.orders[meta.id]!.join(' -> ') || '(空)'}\n`);
      process.stdout.write(`  学习统计: ${JSON.stringify(cmp.learnedSummary[meta.id])}\n`);
    }
    process.stdout.write(
      `\n结论: 两套规则的上屏次序${cmp.sameOrder ? '一致' : '不同(见上)'}\n`,
    );
  }
}

function demoReplay(): void {
  title('重放演示: 在第 6 条操作记录处暂停, 再单步重走');
  const run = runScenario(newAccountScenario);
  const session = ReplaySession.fromLog(run.log);
  const pauseSeq = 6;
  session.pauseAtSeq(pauseSeq);
  const frame = session.frame();
  process.stdout.write(
    `暂停于 step=${frame.step}, 当前 active=${frame.activeHintId ?? '无'}, 队列=[${frame.queuedHintIds.join(', ')}]\n`,
  );
  for (let i = 0; i < 4; i += 1) {
    const next = session.peek();
    const f = session.step();
    const desc = next
      ? next.kind === 'event'
        ? `event seq=${next.event.seq} ${next.event.type}`
        : `trace seq=${next.entry.seq} ${next.entry.hintId} ${next.entry.reason.kind}`
      : 'EOF';
    process.stdout.write(
      `  step ${String(f.step).padStart(2)} | ${desc.padEnd(40)} | active=${f.activeHintId ?? '无'}\n`,
    );
  }
  session.runToEnd();
  const end = session.frame();
  process.stdout.write(`重放至末尾: learned=${Object.keys(end.learned).length} 条\n`);
}

const command = process.argv[2] ?? 'demo';
switch (command) {
  case 'demo':
    runOne(newAccountScenario);
    printTraces(runScenario(newAccountScenario));
    break;
  case 'experienced':
    runOne(experiencedScenario);
    printTraces(runScenario(experiencedScenario));
    break;
  case 'compare':
    demoCompare();
    break;
  case 'replay':
    demoReplay();
    break;
  default:
    process.stdout.write(
      '用法: cli.js <demo|experienced|compare|replay>\n',
    );
    process.exitCode = 1;
}
