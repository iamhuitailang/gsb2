// 内置样例场景与同一条对照路线。
// 同一路线分别在“严格/宽松”两套规则下重放，用于对照规则改动前后的事件差异。

import { ACTION } from './events.js';
import { RULES_LENIENT, RULES_STRICT } from './events.js';
import { buildFrames } from './recorder.js';

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'];

export function buildPresetScenes() {
  // ---- 区域布局（画布 960×600）----
  const zonesBase = [
    {
      id: 'z1',
      name: '蓝圆·治疗区',
      color: PALETTE[0],
      shape: 'circle',
      center: { x: 220, y: 200 },
      radius: 90,
      stayIntervalMs: 400,
      graceMs: 150,
      rules: {}, // 取场景默认规则
    },
    {
      id: 'z2',
      name: '橙圆·加速区（与蓝圆重叠）',
      color: PALETTE[1],
      shape: 'circle',
      center: { x: 300, y: 250 },
      radius: 80,
      stayIntervalMs: 400,
      graceMs: 150,
      rules: {},
    },
    {
      id: 'z3',
      name: '绿矩形·闸门',
      color: PALETTE[2],
      shape: 'rect',
      rect: { x: 470, y: 120, w: 70, h: 240 },
      stayIntervalMs: 500,
      graceMs: 80,
      rules: {},
    },
    {
      id: 'z4',
      name: '黄多边形·机关',
      color: PALETTE[3],
      shape: 'polygon',
      points: [
        { x: 660, y: 360 },
        { x: 760, y: 320 },
        { x: 840, y: 400 },
        { x: 780, y: 500 },
        { x: 670, y: 480 },
      ],
      stayIntervalMs: 500,
      graceMs: 120,
      rules: {},
    },
  ];

  // ---- 同一条演示路线：步行穿重叠区（驻留）→ 高速穿闸门 → 边界抖动 → 短距瞬移 → 高速擦多边形 ----
  const waypoints = [
    { pos: { x: 60, y: 200 }, action: ACTION.IDLE },                 // 0 起点
    { pos: { x: 220, y: 200 }, action: ACTION.WALK },                // 1 走进蓝圆中心（重叠区）
    // 在蓝圆内驻留 900ms：蓝圆独立累计停留；随后走进橙圆时两区重叠各自计时
    { pos: { x: 220, y: 200 }, action: ACTION.IDLE, durationMs: 900 }, // 2 驻留（蓝圆停留×2）
    { pos: { x: 300, y: 250 }, action: ACTION.WALK },                // 3 走到橙圆中心（仍在蓝圆内）
    { pos: { x: 300, y: 250 }, action: ACTION.IDLE, durationMs: 600 }, // 4 重叠区驻留（两区各自停留）
    { pos: { x: 430, y: 240 }, action: ACTION.WALK },                // 5 走出两圆
    // 高速穿过绿矩形：单帧位移 260px，远超 70px 宽度，靠线段采样捕获
    { pos: { x: 690, y: 240 }, action: ACTION.DASH, durationMs: 50 }, // 4 高速穿闸门
    // 回到闸门边缘，演示边界线上来回挪动
    { pos: { x: 472, y: 240 }, action: ACTION.WALK },                // 5 进入闸门
    { pos: { x: 466, y: 240 }, action: ACTION.WALK },                // 6 挪出
    { pos: { x: 472, y: 240 }, action: ACTION.WALK },                // 7 挪回
    { pos: { x: 466, y: 240 }, action: ACTION.WALK },                // 8 再挪出（宽限内应只 1 次进入）
    { pos: { x: 560, y: 240 }, action: ACTION.WALK },                // 9 正式穿过闸门
    // 短距瞬移：从区外跳进黄多边形，再瞬移出去
    { pos: { x: 600, y: 300 }, action: ACTION.TELEPORT },            // 10 先移到多边形外
    { pos: { x: 760, y: 420 }, action: ACTION.TELEPORT },            // 11 瞬移入机关
    { pos: { x: 900, y: 540 }, action: ACTION.TELEPORT },            // 12 瞬移出机关
    // 高速擦过多边形边缘（此时 z4 已被瞬移触发，仅展示几何采样依据）
    { pos: { x: 660, y: 470 }, action: ACTION.DASH, durationMs: 50 }, // 13 高速穿多边形边缘
    { pos: { x: 920, y: 560 }, action: ACTION.IDLE, durationMs: 300 }, // 14 区外停留
  ];

  const frames = buildFrames(waypoints, { stepMs: 100, dashMs: 50 });

  const build = (rules, overrides = {}) =>
    zonesBase.map((z) => ({
      ...z,
      rules: { ...rules },
      triggerMode: overrides[z.id]?.triggerMode ?? 'every',
      enabled: overrides[z.id]?.enabled ?? true,
    }));

  return {
    canvas: { w: 960, h: 600 },
    waypoints,
    frames,
    scenes: {
      // 两套规则用完全相同的区域配置，仅动作规则不同，保证对照可解释
      lenient: {
        rules: RULES_LENIENT,
        zones: build(RULES_LENIENT),
      },
      strict: {
        rules: RULES_STRICT,
        zones: build(RULES_STRICT),
      },
    },
  };
}

// 导出/存档的完整场景包
export function exportBundle(engine, frames, meta = {}) {
  return {
    version: 1,
    meta: {
      exportedAt: new Date().toISOString(),
      ...meta,
    },
    canvas: meta.canvas ?? { w: 960, h: 600 },
    zones: engine.zones.map((z) => ({ ...z, rules: { ...z.rules } })),
    frames,
    events: engine.events.map((e) => ({ ...e })),
  };
}
