const E = require('../js/engine.js');
const S = require('../js/samples.js');
S.samples.forEach((s) => {
  ['setupA', 'setupB'].forEach((k) => {
    const r = E.simulate(s[k]);
    console.log(
      s.id, k, 'winner=' + r.winner, 'dur=' + r.duration,
      'allyHp=' + r.allyHp + '/' + r.allyMaxHp,
      'enemyHp=' + r.enemyHp + '/' + r.enemyMaxHp,
      'events=' + r.events.length, 'truncated=' + r.eventsTruncated
    );
  });
});

// 确定性检查
const a = E.simulate(S.getSample('stacking-dot').setupA);
const b = E.simulate(S.getSample('stacking-dot').setupA);
console.log('deterministic:', JSON.stringify(a) === JSON.stringify(b));

// 批量
const batch = E.simulateBatch(S.getSample('random-batch').setupA, { runs: 200, seed: '9' });
console.log('batch winRate', JSON.stringify(batch.winRate));
console.log('duration p10/p50/p90', batch.duration.p10, batch.duration.p50, batch.duration.p90);
console.log('hist buckets', batch.durationHistogram.length);
