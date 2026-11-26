import {
  advanceRun,
  createComponent,
  createEmptyGraph,
  createRun,
  scheduleSwitch,
} from './core.js';

function wire(id, fromComponentId, toComponentId, toPortId, fromPortId = 'out') {
  return {
    id,
    from: { componentId: fromComponentId, portId: fromPortId },
    to: { componentId: toComponentId, portId: toPortId },
  };
}

export function dualSwitchGraph() {
  const graph = createEmptyGraph();
  graph.notes = [
    {
      id: 'note_dual',
      x: 40,
      y: 34,
      w: 430,
      title: '示例 · 双开关解锁',
      text: '两个开关同时为 1 时“解锁条件”灯亮；信号再经过 2 步延时，“解锁执行”灯才亮。',
      tone: 'good',
    },
  ];
  graph.components = [
    createComponent('switch', 80, 130, { name: '开关 A', value: false }, 'dual_sw_a'),
    createComponent('switch', 80, 260, { name: '开关 B', value: false }, 'dual_sw_b'),
    createComponent('and', 330, 185, { name: '双开与门' }, 'dual_and'),
    createComponent('lamp', 585, 120, { name: '解锁条件' }, 'dual_lamp_condition'),
    createComponent('delay', 585, 235, { name: '门锁延时', delayTicks: 2, initialValue: 0 }, 'dual_delay'),
    createComponent('lamp', 835, 235, { name: '解锁执行' }, 'dual_lamp_unlock'),
  ];
  graph.connections = [
    wire('dual_w_1', 'dual_sw_a', 'dual_and', 'a'),
    wire('dual_w_2', 'dual_sw_b', 'dual_and', 'b'),
    wire('dual_w_3', 'dual_and', 'dual_lamp_condition', 'in'),
    wire('dual_w_4', 'dual_and', 'dual_delay', 'in'),
    wire('dual_w_5', 'dual_delay', 'dual_lamp_unlock', 'in'),
  ];
  return graph;
}

export function illegalFeedbackGraph() {
  const graph = createEmptyGraph();
  graph.notes = [
    {
      id: 'note_bad',
      x: 40,
      y: 34,
      w: 460,
      title: '示例 · 非法组合反馈',
      text: '非门输出在同一时步直接回到输入：0→1、1→0，没有稳定状态。运行后相关元件和线会被标出，该组暂停。',
      tone: 'critical',
    },
  ];
  graph.components = [
    createComponent('not', 170, 170, { name: '自相矛盾的非门' }, 'bad_not'),
  ];
  graph.connections = [wire('bad_w_1', 'bad_not', 'bad_not', 'in')];
  return graph;
}

export function delayedFeedbackGraph() {
  const graph = createEmptyGraph();
  graph.notes = [
    {
      id: 'note_delayed',
      x: 40,
      y: 34,
      w: 470,
      title: '示例 · 合法延时反馈',
      text: '反馈环中存在 1 步延时器，因此矛盾被时步切开：每个时步只更新一次，形成确定的交替时序。',
      tone: 'info',
    },
  ];
  graph.components = [
    createComponent('not', 170, 170, { name: '反相器' }, 'dly_not'),
    createComponent('delay', 410, 170, { name: '1 步状态', delayTicks: 1, initialValue: 0 }, 'dly_delay'),
    createComponent('lamp', 660, 170, { name: '节拍灯' }, 'dly_lamp'),
  ];
  graph.connections = [
    wire('dly_w_1', 'dly_not', 'dly_delay', 'in'),
    wire('dly_w_2', 'dly_delay', 'dly_not', 'in'),
    wire('dly_w_3', 'dly_not', 'dly_lamp', 'in'),
  ];
  return graph;
}

export function unknownStateGraph() {
  const graph = createEmptyGraph();
  graph.notes = [
    {
      id: 'note_unknown',
      x: 40,
      y: 34,
      w: 470,
      title: '状态说明 · 未知输入',
      text: '常量 1 接到 A，但 B 断开。AND 无法确定结果，因此门和显示灯都标作“?”；接上 B 后会恢复确定时序。',
      tone: 'info',
    },
  ];
  graph.components = [
    createComponent('constant', 90, 180, { name: '常量 1', value: true }, 'unk_const'),
    createComponent('and', 330, 165, { name: '缺少 B 的与门' }, 'unk_and'),
    createComponent('lamp', 590, 165, { name: '未知态灯' }, 'unk_lamp'),
  ];
  graph.connections = [
    wire('unk_w_1', 'unk_const', 'unk_and', 'a'),
    wire('unk_w_2', 'unk_and', 'unk_lamp', 'in'),
  ];
  return graph;
}

export function starterGraph() {
  const dual = dualSwitchGraph();
  const bad = illegalFeedbackGraph();
  const delayed = delayedFeedbackGraph();
  const unknown = unknownStateGraph();

  // Move the two feedback examples to the right/below while keeping stable IDs.
  bad.notes[0].x = 1120;
  bad.notes[0].y = 34;
  bad.components[0].x = 1240;
  bad.components[0].y = 150;

  delayed.notes[0].x = 1120;
  delayed.notes[0].y = 330;
  delayed.components = delayed.components.map((c) => ({ ...c, y: 430 }));
  delayed.components[0].x = 1180;
  delayed.components[1].x = 1420;
  delayed.components[2].x = 1670;

  unknown.notes[0].x = 1120;
  unknown.notes[0].y = 650;
  unknown.components = unknown.components.map((component) => ({
    ...component,
    x: component.x + 1080,
    y: component.y + 560,
  }));

  return {
    version: 1,
    notes: [
      dual.notes[0],
      bad.notes[0],
      delayed.notes[0],
      unknown.notes[0],
    ],
    components: [...dual.components, ...bad.components, ...delayed.components, ...unknown.components],
    connections: [...dual.connections, ...bad.connections, ...delayed.connections, ...unknown.connections],
  };
}

function makeSeededRun(graph, number, name, events) {
  const run = createRun(graph, { number, name });
  for (const event of events) {
    const result = scheduleSwitch(run, event.tick, event.componentId, event.value);
    if (!result.ok) throw new Error(result.message);
  }
  advanceRun(run, 10);
  return run;
}

export function createSeededProject() {
  const graph = starterGraph();
  const slowRun = makeSeededRun(graph, 1, '演示 A · 先后按下', [
    { tick: 1, componentId: 'dual_sw_a', value: true },
    { tick: 4, componentId: 'dual_sw_b', value: true },
    { tick: 8, componentId: 'dual_sw_a', value: false },
  ]);
  const fastRun = makeSeededRun(graph, 2, '演示 B · 很快齐按', [
    { tick: 1, componentId: 'dual_sw_a', value: true },
    { tick: 2, componentId: 'dual_sw_b', value: true },
    { tick: 7, componentId: 'dual_sw_b', value: false },
  ]);

  return {
    version: 1,
    graph,
    runs: [slowRun, fastRun],
    activeRunId: fastRun.id,
    compareAId: slowRun.id,
    compareBId: fastRun.id,
    selectedTick: fastRun.ticks.length - 1,
    selectedWireId: null,
    inspectionRunId: fastRun.id,
    updatedAt: new Date().toISOString(),
  };
}

export function createBlankProject() {
  const graph = createEmptyGraph();
  graph.notes = [];
  return {
    version: 1,
    graph,
    runs: [],
    activeRunId: null,
    compareAId: null,
    compareBId: null,
    selectedTick: 0,
    selectedWireId: null,
    inspectionRunId: null,
    updatedAt: new Date().toISOString(),
  };
}
