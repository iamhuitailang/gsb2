'use strict';
/* ============================================================
 * 预设场景
 * 1) shared-door：两个入口最后共用一扇门 —— 限流 + 中途关门（要求 6）
 * 2) fork-route ：分叉路线 + 权重选路 + 一路临时关闭后换路
 * 每个场景带 variants（另一套节奏），用于并排对比（要求 5）
 * ============================================================ */

const SCENARIOS = [
  {
    id: 'shared-door',
    name: '双入口共用大门（限流 + 中途关门）',
    desc: '入口 A、B 各限 2 人同行，汇入后共用一扇限 1 人的大门；25s–40s 大门检修关闭，未出发角色改走绕行侧门，已在门上的继续通过。点击画布上的通道可手动临时关/开。',
    config: {
      name: '双入口共用大门',
      seed: 20261123,
      nodes: [
        { id: 'A', x: 70,  y: 140, type: 'entrance', label: '入口A' },
        { id: 'B', x: 70,  y: 460, type: 'entrance', label: '入口B' },
        { id: 'JA', x: 240, y: 140, type: 'junction', label: '' },
        { id: 'JB', x: 240, y: 460, type: 'junction', label: '' },
        { id: 'M', x: 430, y: 300, type: 'junction', label: '汇合点' },
        { id: 'F', x: 740, y: 300, type: 'field', label: '场内', rx: 110, ry: 90 },
        { id: 'X', x: 920, y: 300, type: 'exit', label: '出口' },
      ],
      edges: [
        { id: 'eA',  from: 'A',  to: 'JA', time: 1.5, cap: 2 },
        { id: 'eB',  from: 'B',  to: 'JB', time: 1.5, cap: 2 },
        { id: 'eA2', from: 'JA', to: 'M',  time: 2.0, cap: 2 },
        { id: 'eB2', from: 'JB', to: 'M',  time: 2.0, cap: 2 },
        { id: 'eDoor', from: 'M', to: 'F', time: 2.0, cap: 1,
          closures: [{ start: 25, end: 40, label: '大门检修' }] },
        { id: 'eSide', from: 'M', to: 'F', time: 7.0, cap: 1 },   // 绕行侧门（慢）
        { id: 'eOut', from: 'F', to: 'X',  time: 1.5, cap: 3 },
      ],
      routes: [
        { id: 'rA', enter: [[{ edge: 'eA' }], [{ edge: 'eA2' }], [{ edge: 'eDoor' }, { edge: 'eSide' }]],
                    exit:  [[{ edge: 'eOut' }]] },
        { id: 'rB', enter: [[{ edge: 'eB' }], [{ edge: 'eB2' }], [{ edge: 'eDoor' }, { edge: 'eSide' }]],
                    exit:  [[{ edge: 'eOut' }]] },
      ],
      waves: [
        { id: 'W1', name: '红队', color: '#e2554f', priority: 1, batches: [
          { id: 'W1b1', count: 12, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'time', at: 2 } },
          { id: 'W1b2', count: 12, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'afterBatch', batch: 'W1b1', delay: 3 } },
          { id: 'W1b3', count: 10, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'fieldBelow', value: 8, notBefore: 10 } },
        ]},
        { id: 'W2', name: '蓝队', color: '#3f8fe2', priority: 2, batches: [
          { id: 'W2b1', count: 12, entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'time', at: 5 } },
          { id: 'W2b2', count: 12, entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'afterBatch', batch: 'W2b1', delay: 2 } },
          { id: 'W2b3', count: 8,  entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'time', at: 34 } },
        ]},
      ],
    },
    variants: [
      { id: 'staggered', name: '错峰节奏（蓝队推迟 + 批次间隔拉长）', waves: [
        { id: 'W1', name: '红队', color: '#e2554f', priority: 1, batches: [
          { id: 'W1b1', count: 12, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'time', at: 2 } },
          { id: 'W1b2', count: 12, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'afterBatch', batch: 'W1b1', delay: 8 } },
          { id: 'W1b3', count: 10, entrance: 'A', route: 'rA', dwell: 10, trigger: { type: 'fieldBelow', value: 6, notBefore: 10 } },
        ]},
        { id: 'W2', name: '蓝队', color: '#3f8fe2', priority: 2, batches: [
          { id: 'W2b1', count: 12, entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'time', at: 14 } },
          { id: 'W2b2', count: 12, entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'afterBatch', batch: 'W2b1', delay: 8 } },
          { id: 'W2b3', count: 8,  entrance: 'B', route: 'rB', dwell: 12, trigger: { type: 'time', at: 55 } },
        ]},
      ]},
    ],
  },

  {
    id: 'fork-route',
    name: '分叉路线 + 一路临时关闭',
    desc: '单入口限 3 人，汇合后按 1:1 权重分叉到上/下两条门；30s–45s 上门关闭：还在分叉点的改走下门，已经走上支路的原地等门开（已出发不回头）。',
    config: {
      name: '分叉路线',
      seed: 77120,
      nodes: [
        { id: 'C', x: 70,  y: 300, type: 'entrance', label: '入口C' },
        { id: 'J', x: 300, y: 300, type: 'junction', label: '分叉点' },
        { id: 'JU', x: 520, y: 170, type: 'junction', label: '' },
        { id: 'JD', x: 520, y: 430, type: 'junction', label: '' },
        { id: 'F', x: 760, y: 300, type: 'field', label: '场内', rx: 100, ry: 90 },
        { id: 'X', x: 920, y: 300, type: 'exit', label: '出口' },
      ],
      edges: [
        { id: 'eC',  from: 'C',  to: 'J',  time: 2.0, cap: 3 },
        { id: 'eJ1', from: 'J',  to: 'JU', time: 1.5, cap: 2 },
        { id: 'eJ2', from: 'J',  to: 'JD', time: 1.5, cap: 2 },
        { id: 'eDoorL', from: 'JU', to: 'F', time: 2.0, cap: 1,
          closures: [{ start: 30, end: 45, label: '上门封闭' }] },
        { id: 'eDoorR', from: 'JD', to: 'F', time: 2.0, cap: 1 },
        { id: 'eOut', from: 'F', to: 'X',  time: 1.5, cap: 3 },
      ],
      routes: [
        { id: 'rC', enter: [[{ edge: 'eC' }],
                            [{ edge: 'eJ1', weight: 1 }, { edge: 'eJ2', weight: 1 }],
                            [{ edge: 'eDoorL' }, { edge: 'eDoorR' }]],
                    exit:  [[{ edge: 'eOut' }]] },
      ],
      waves: [
        { id: 'W1', name: '绿队', color: '#46a05e', priority: 1, batches: [
          { id: 'W1b1', count: 10, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 2 } },
          { id: 'W1b2', count: 10, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'afterBatch', batch: 'W1b1', delay: 2 } },
          { id: 'W1b3', count: 8,  entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'fieldBelow', value: 6, notBefore: 12 } },
        ]},
        { id: 'W2', name: '橙队', color: '#e08a3c', priority: 2, batches: [
          { id: 'W2b1', count: 10, entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'time', at: 8 } },
          { id: 'W2b2', count: 8,  entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'afterBatch', batch: 'W2b1', delay: 4 } },
        ]},
      ],
    },
    variants: [
      { id: 'small-batches', name: '均匀小批（每批减半、间隔固定）', waves: [
        { id: 'W1', name: '绿队', color: '#46a05e', priority: 1, batches: [
          { id: 'W1b1', count: 5, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 2 } },
          { id: 'W1b2', count: 5, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 12 } },
          { id: 'W1b3', count: 5, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 22 } },
          { id: 'W1b4', count: 5, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 32 } },
          { id: 'W1b5', count: 4, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 42 } },
          { id: 'W1b6', count: 4, entrance: 'C', route: 'rC', dwell: 9, trigger: { type: 'time', at: 52 } },
        ]},
        { id: 'W2', name: '橙队', color: '#e08a3c', priority: 2, batches: [
          { id: 'W2b1', count: 5, entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'time', at: 7 } },
          { id: 'W2b2', count: 5, entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'time', at: 17 } },
          { id: 'W2b3', count: 4, entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'time', at: 27 } },
          { id: 'W2b4', count: 4, entrance: 'C', route: 'rC', dwell: 11, trigger: { type: 'time', at: 37 } },
        ]},
      ]},
    ],
  },
];
