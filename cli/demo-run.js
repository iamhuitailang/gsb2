// demo-run.js — 命令行回放三回合演示，打印完整结算记录
import { applyAction, createGame, endTurn, countAt } from '../src/engine.js';
import { demoRuleset, demoScript } from '../src/demo.js';

const ICON = {
  action: '▶',
  event: '·',
  trigger: '  ⚡',
  effect: '    ',
  skip: '  ↷',
  loop: '  ⏹',
  blocked: '⛔',
  turn: '━━',
};

let state = createGame(demoRuleset);
let failures = 0;
for (const step of demoScript) {
  while (state.turn.index !== step.turn || state.turn.side !== step.side) {
    state = endTurn(state, demoRuleset);
  }
  const before = state.log.length;
  const result = applyAction(state, demoRuleset, step.actionId, step.params);
  const ok = result.ok === step.expectValid;
  if (!ok) failures++;
  console.log(`\n=== T${step.turn}/${step.side} ${step.actionId} ${JSON.stringify(step.params)} 预期${step.expectValid ? '合法' : '被阻止'} → 实际${result.ok ? '合法' : '被阻止'} ${ok ? '✓' : '✗'}`);
  console.log(`    说明：${step.note}`);
  for (const line of state.log.slice(before)) console.log(`${ICON[line.kind] ?? ' '} ${line.text}`);
  state = result.state;
}

console.log('\n=== 终局棋盘 ===');
for (const cell of demoRuleset.cells) {
  const markers = Object.entries(state.board.markers[cell.id] ?? {})
    .map(([m, n]) => `${demoRuleset.markers.find((x) => x.id === m).name}×${n}`)
    .join('，') || '空';
  console.log(`${cell.name}：${markers}`);
}
console.log(`资源：余烬储备=${state.poolValues.emberStock}，灵能=${state.poolValues.mana}`);
console.log(`\n${failures === 0 ? '全部步骤符合预期 ✓' : failures + ' 个步骤不符合预期 ✗'}`);
process.exit(failures === 0 ? 0 : 1);
