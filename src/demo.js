// demo.js — 虚构标记的示例规则集 + 三回合可走完的演示脚本
//
// 标记：ember 余烬 / drop 水滴 / dust 晶尘
// 单元：src 源火台 / rest 安息处 / pool 蓄水池 / forge 熔炉
// 资源：emberStock 余烬储备（整局，不随回合重置）/ mana 灵能（每回合重置）
//
// 两条互触发规则（循环演示）：
//   r_flow 顺流：余烬到达「源火台」→ 移到安息处
//   r_back 回流：余烬到达「安息处」→ 移回源火台
//   各自 cap=4，链在 8 次移动后被单规则上限截断。
//
// 触发顺序演示：
//   r_evap 蒸发(优先级10) 在 r_flow 顺流(优先级20) 之前。
//   在源火台放余烬（台上还有水滴）：先蒸发掉水滴、再顺流移动。
//   若把 r_flow 调到 r_evap 前面，余烬先被移走，蒸发条件不再成立，水滴会存活。

export const demoRuleset = {
  schema: 1,
  id: 'rs-ember-tide',
  name: '余烬潮汐（演示规则集）',
  version: 1,
  config: {
    turnOrder: ['red', 'blue'],
    chainCap: 24,
    perRuleDefaultCap: 8,
  },
  markers: [
    { id: 'ember', name: '余烬' },
    { id: 'drop', name: '水滴' },
    { id: 'dust', name: '晶尘' },
  ],
  cells: [
    { id: 'src', name: '源火台' },
    { id: 'rest', name: '安息处' },
    { id: 'pool', name: '蓄水池' },
    { id: 'forge', name: '熔炉' },
  ],
  pools: [
    { id: 'emberStock', name: '余烬储备', scope: 'game', initial: 3 },
    { id: 'mana', name: '灵能', scope: 'turn', initial: 2 },
  ],
  turnLimits: {
    a_place: 2,
    a_move: 2,
    a_consume: 2,
  },
  actions: [
    {
      id: 'a_place',
      name: '放置余烬',
      kind: 'place',
      marker: 'ember',
      cost: { pool: 'mana', count: 1 },
      params: [{ key: 'cellId', label: '目标单元', kind: 'cell' }],
      checks: [
        { type: 'resourceAtLeast', pool: 'emberStock', count: 1 },
        { type: 'resourceAtLeast', pool: 'mana', count: 1 },
      ],
    },
    {
      id: 'a_move',
      name: '移动标记',
      kind: 'move',
      params: [
        { key: 'from', label: '来源单元', kind: 'cell' },
        { key: 'to', label: '目标单元', kind: 'cell' },
        { key: 'marker', label: '标记', kind: 'marker' },
      ],
      checks: [
        { type: 'not', cond: { type: 'cellIs', cell: '$from', value: '$to' } },
        { type: 'cellHas', cell: '$from', marker: '$marker', count: 1 },
      ],
    },
    {
      id: 'a_consume',
      name: '消耗标记',
      kind: 'consume',
      params: [
        { key: 'cellId', label: '单元', kind: 'cell' },
        { key: 'marker', label: '标记', kind: 'marker' },
      ],
      checks: [{ type: 'cellHas', cell: '$cellId', marker: '$marker', count: 1 }],
    },
  ],
  rules: [
    {
      id: 'r_takeStock',
      name: '取料',
      priority: 5,
      cap: 4,
      trigger: { type: 'placed', filter: { marker: 'ember' } },
      conditions: [],
      effects: [{ type: 'spendResource', pool: 'emberStock', count: 1 }],
    },
    {
      id: 'r_evap',
      name: '蒸发',
      priority: 10,
      cap: 2,
      trigger: { type: 'placed', filter: { marker: 'ember' } },
      conditions: [
        { type: 'cellHas', cell: '$cell', marker: 'drop', count: 1 },
        { type: 'cellHas', cell: '$cell', marker: 'ember', count: 1 },
      ],
      effects: [{ type: 'consume', cell: '$cell', marker: 'drop', count: 1 }],
    },
    {
      id: 'r_condense',
      name: '凝结',
      priority: 15,
      cap: 2,
      trigger: { type: 'consumed', filter: { marker: 'drop' } },
      conditions: [],
      effects: [{ type: 'place', cell: '$cell', marker: 'dust', count: 1 }],
    },
    {
      id: 'r_flow',
      name: '顺流',
      priority: 20,
      cap: 4,
      trigger: { type: ['placed', 'moved'], filter: { marker: 'ember' } },
      conditions: [{ type: 'cellIs', cell: '$cellId', value: 'src' }],
      effects: [{ type: 'move', from: 'src', to: 'rest', marker: 'ember', count: 1 }],
    },
    {
      id: 'r_back',
      name: '回流',
      priority: 25,
      cap: 4,
      trigger: { type: 'moved', filter: { marker: 'ember' } },
      conditions: [{ type: 'cellIs', cell: '$cellId', value: 'rest' }],
      effects: [{ type: 'move', from: 'rest', to: 'src', marker: 'ember', count: 1 }],
    },
  ],
  initialBoard: [
    { cell: 'src', marker: 'drop', count: 1 },
    { cell: 'pool', marker: 'drop', count: 2 },
    { cell: 'forge', marker: 'dust', count: 1 },
  ],
};

// 三回合（red → blue → red）演示脚本；expectValid:false 的步骤用于展示被阻止的行动
export const demoScript = [
  {
    turn: 1,
    side: 'red',
    actionId: 'a_place',
    params: { cellId: 'src' },
    expectValid: true,
    note: '源火台放余烬：蒸发(优先级10)先吃掉水滴并凝结出晶尘，随后顺流/回流互触发 8 次后被 cap 截断',
  },
  {
    turn: 1,
    side: 'red',
    actionId: 'a_consume',
    params: { cellId: 'rest', marker: 'drop' },
    expectValid: false,
    note: '安息处没有水滴，行动被阻止且不消耗次数',
  },
  {
    turn: 1,
    side: 'red',
    actionId: 'a_move',
    params: { from: 'src', to: 'forge', marker: 'dust' },
    expectValid: true,
    note: '把凝结出的晶尘移到熔炉（不触发任何余烬规则）',
  },
  {
    turn: 2,
    side: 'blue',
    actionId: 'a_move',
    params: { from: 'pool', to: 'rest', marker: 'ember' },
    expectValid: false,
    note: '蓄水池没有余烬，移动被阻止',
  },
  {
    turn: 2,
    side: 'blue',
    actionId: 'a_move',
    params: { from: 'src', to: 'rest', marker: 'ember' },
    expectValid: true,
    note: '余烬从源火台移到安息处，回流立刻把它送回，顺流/回流再次互触发直到 cap 截断',
  },
  {
    turn: 3,
    side: 'red',
    actionId: 'a_place',
    params: { cellId: 'pool' },
    expectValid: true,
    note: '蓄水池放余烬：蒸发 1 个水滴并凝结晶尘；顺流条件（单元=源火台）不成立而跳过',
  },
  {
    turn: 3,
    side: 'red',
    actionId: 'a_consume',
    params: { cellId: 'pool', marker: 'dust' },
    expectValid: true,
    note: '消耗刚凝结的晶尘，演示消耗类行动',
  },
];
