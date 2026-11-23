/*
 * 内置样例：环路 / 窄桥 / 断供后重新接通
 * 每个样例 = 初始场景 + 每轮指令文本，可一步步对照每格变化及原因。
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Samples = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 样例 1：环路 —— 两条路通同一据点，断一条不掉线，断两条才开始倒计时
  const loop = {
    name: '环路（双路冗余）',
    desc: '据点 s 经 m1、m2 两条路连回基地。第4轮断一条仍在线，第5轮全断开始倒计时，第6轮失效。',
    scenario: {
      config: { supplyThreshold: 2 },
      nodes: [
        { id: 'a0', x: 90,  y: 210, kind: 'base',   baseOf: 'A', owner: 'A', units: { A: 3 } },
        { id: 'm1', x: 270, y: 110, kind: 'plain',  owner: 'N' },
        { id: 'm2', x: 270, y: 310, kind: 'plain',  owner: 'N' },
        { id: 's',  x: 470, y: 210, kind: 'strong', owner: 'N' },
        { id: 'b0', x: 610, y: 70,  kind: 'base',   baseOf: 'B', owner: 'B', units: { B: 1 } },
      ],
      edges: [
        { a: 'a0', b: 'm1' }, { a: 'a0', b: 'm2' },
        { a: 'm1', b: 's' },  { a: 'm2', b: 's' },
        { a: 'b0', b: 'm1' },
      ],
    },
    rounds: [
      ['A move a0 m1', 'A move a0 m2'],   // R1 分兵两路，普通区域自动归属A
      ['A move m1 s'],                    // R2 进驻据点
      ['A capture s'],                    // R3 占领据点，补给经 m1 接通
      ['B block m1 s'],                   // R4 断其中一条路 —— s 仍经 m2 在线
      ['B block m2 s'],                   // R5 两条路全断 —— s 断供 1/2
      [],                                 // R6 无人救援 —— s 断供 2/2，失效转中立
    ],
  };

  // 样例 2：窄桥 —— 桥点易主，桥后两个据点同轮一起断供；夺回桥后逐个收复
  const bridge = {
    name: '窄桥（咽喉点）',
    desc: 'g 是唯一通道。第1轮B夺桥，s1、s2 同轮断供；第2轮双双失效。A 随后反击夺桥、重新接通并收复据点。',
    scenario: {
      config: { supplyThreshold: 2 },
      nodes: [
        { id: 'a0', x: 70,  y: 220, kind: 'base',   baseOf: 'A', owner: 'A', units: { A: 4 } },
        { id: 'x',  x: 180, y: 220, kind: 'plain',  owner: 'A' },
        { id: 'g',  x: 300, y: 220, kind: 'plain',  owner: 'A' },
        { id: 'y',  x: 420, y: 150, kind: 'plain',  owner: 'A' },
        { id: 's1', x: 550, y: 150, kind: 'strong', owner: 'A' },
        { id: 's2', x: 420, y: 310, kind: 'strong', owner: 'A' },
        { id: 'b0', x: 300, y: 60,  kind: 'base',   baseOf: 'B', owner: 'B', units: { B: 2 } },
      ],
      edges: [
        { a: 'a0', b: 'x' }, { a: 'x', b: 'g' }, { a: 'g', b: 'y' },
        { a: 'y', b: 's1' }, { a: 'g', b: 's2' }, { a: 'b0', b: 'g' },
      ],
    },
    rounds: [
      ['B move b0 g 2'],                          // R1 B夺桥：g易主，s1/s2 同轮断供 1/2
      [],                                         // R2 断供 2/2：s1、s2 双双失效转中立
      ['A move a0 x 2'],                          // R3 A集结反击
      ['A move x g 2'],                           // R4 桥上 2v2 同归于尽，g 仍属B
      ['A move a0 x 2'],                          // R5 第二梯队上桥
      ['A move x g 2'],                           // R6 夺下桥点，g 自动易主A
      ['A move g y 1', 'A move g s2 1'],          // R7 兵分两路
      ['A move y s1 1', 'A capture s2'],          // R8 收复 s2（当轮重新接通补给）
      ['A capture s1'],                           // R9 收复 s1
    ],
  };

  // 样例 3：断供后重新接通 —— 倒计时中恢复补给则计数清零；无人救则失效
  const resupply = {
    name: '断供后重新接通',
    desc: '第1轮 m 被B夺走，s 断供 1/2；第2轮 A 夺回 m，s 当轮恢复补给、计数清零。第3轮路被封锁后无人救援，第4轮失效。',
    scenario: {
      config: { supplyThreshold: 2 },
      nodes: [
        { id: 'a0', x: 90,  y: 220, kind: 'base',   baseOf: 'A', owner: 'A', units: { A: 2 } },
        { id: 'm',  x: 270, y: 220, kind: 'plain',  owner: 'A' },
        { id: 's',  x: 450, y: 220, kind: 'strong', owner: 'A' },
        { id: 'b0', x: 270, y: 70,  kind: 'base',   baseOf: 'B', owner: 'B', units: { B: 1 } },
      ],
      edges: [
        { a: 'a0', b: 'm' }, { a: 'm', b: 's' }, { a: 'b0', b: 'm' },
      ],
    },
    rounds: [
      ['B move b0 m'],        // R1 m 易主B：s 断供 1/2，归属仍A
      ['A move a0 m 2'],      // R2 争夺后 m 回到A：s 当轮恢复补给，计数清零
      ['B block m s'],        // R3 路段被封锁：s 再次断供 1/2
      [],                     // R4 无人救援：s 断供 2/2，失效转中立
    ],
  };

  return { list: [loop, bridge, resupply] };
});
