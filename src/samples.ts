import { EngineConfig, InputEvent } from './engine.js';

// 默认指令表：多条指令共用前缀（轻击/双击/连段 都以 短按A 开头；长按斩与它们共用 A 的按下）
export const DEFAULT_CONFIG: EngineConfig = {
  tapMaxMs: 250,
  bufferMs: 400,
  commands: [
    { name: '轻击',   shape: 'circle',   color: '#4fc3f7', steps: [{ kind: 'tap', key: 'A' }],                        stepWindowMs: 350, priority: 1, actionMs: 400, interruptible: true },
    { name: '双击',   shape: 'triangle', color: '#aed581', steps: [{ kind: 'tap', key: 'A' }, { kind: 'tap', key: 'A' }], stepWindowMs: 350, priority: 2, actionMs: 600, interruptible: true },
    { name: '连段',   shape: 'pentagon', color: '#f06292', steps: [{ kind: 'tap', key: 'A' }, { kind: 'tap', key: 'B' }], stepWindowMs: 400, priority: 2, actionMs: 600, interruptible: true },
    { name: '长按斩', shape: 'square',   color: '#ffb74d', steps: [{ kind: 'hold', key: 'A', minMs: 400 }],            stepWindowMs: 350, priority: 2, actionMs: 900, interruptible: false },
    { name: '合击',   shape: 'diamond',  color: '#ba68c8', steps: [{ kind: 'chord', keys: ['A', 'B'], windowMs: 100 }], stepWindowMs: 350, priority: 3, actionMs: 800, interruptible: false },
  ],
};

let nid = 1;
function ev(t: number, key: string, type: 'down' | 'up'): InputEvent { return { id: nid++, t, key, type }; }
function seq(build: (e: typeof ev) => InputEvent[]): InputEvent[] {
  nid = 1;
  return build(ev);
}

export interface Sample {
  group: string;
  label: string;
  note: string;
  events: InputEvent[];
}

export const SAMPLE_GROUPS: { name: string; desc: string; samples: Sample[] }[] = [
  {
    name: '① 同时按偏了一点',
    desc: '合击 = A+B 在 100ms 内先后按下。对比：偏差 40ms 成立 / 偏差 160ms 不成立（A 退化为轻击）/ 完全同帧。',
    samples: [
      {
        group: '① 同时按偏了一点', label: '1a 偏差40ms → 合击',
        note: 'B 比 A 晚 40ms，落在 100ms 窗口内 →「合击」成立，A 的按下事件被合击消费，轻击候选被丢弃。',
        events: seq(e => [e(0, 'A', 'down'), e(40, 'B', 'down'), e(200, 'A', 'up'), e(240, 'B', 'up')]),
      },
      {
        group: '① 同时按偏了一点', label: '1b 偏差160ms → 轻击',
        note: 'B 比 A 晚 160ms，超出 100ms 窗口 → 合击候选超时丢弃；A 的短按成立为「轻击」（等更长候选超时后生效）。',
        events: seq(e => [e(0, 'A', 'down'), e(160, 'B', 'down'), e(200, 'A', 'up'), e(360, 'B', 'up')]),
      },
      {
        group: '① 同时按偏了一点', label: '1c 同帧按下 → 合击',
        note: 'A、B 同一时刻按下 →「合击」立即成立。',
        events: seq(e => [e(0, 'A', 'down'), e(0, 'B', 'down'), e(200, 'A', 'up'), e(200, 'B', 'up')]),
      },
    ],
  },
  {
    name: '② 长短指令共用开头',
    desc: '轻击/双击/连段 都以 短按A 开头，长按斩与短按共用 A 的按下。对比：单按 / 双按 / 长按。',
    samples: [
      {
        group: '② 长短指令共用开头', label: '2a 单按A → 轻击(挂起后生效)',
        note: '短按 A 凑齐「轻击」，但「双击」「连段」候选还活着 → 轻击挂起，等它们步间窗口超时后才生效。',
        events: seq(e => [e(0, 'A', 'down'), e(120, 'A', 'up')]),
      },
      {
        group: '② 长短指令共用开头', label: '2b 快速双按A → 双击',
        note: '第二次短按让「双击」凑齐：优先级 2 > 轻击 1，双击生效；两个轻击候选的事件都被消费而丢弃。',
        events: seq(e => [e(0, 'A', 'down'), e(120, 'A', 'up'), e(400, 'A', 'down'), e(520, 'A', 'up')]),
      },
      {
        group: '② 长短指令共用开头', label: '2c 按住A 600ms → 长按斩',
        note: '按住 400ms 时「长按斩」成立；短按候选因超过 250ms 未松开被丢弃。',
        events: seq(e => [e(0, 'A', 'down'), e(600, 'A', 'up')]),
      },
      {
        group: '② 长短指令共用开头', label: '2d 长按斩期间输入 → 预存生效',
        note: '长按斩(不可打断, 400→1300ms)期间短按 A：「轻击」1220ms 生效时被预存，1300ms 动作结束后立即切换，日志说明由哪条指令触发。',
        events: seq(e => [e(0, 'A', 'down'), e(600, 'A', 'up'), e(700, 'A', 'down'), e(820, 'A', 'up')]),
      },
      {
        group: '② 长短指令共用开头', label: '2e 预存超时失效',
        note: '长按斩(400→1300ms)刚开始就短按 A：「轻击」895ms 生效被预存，有效期 400ms，1295ms 时动作仍未结束 → 预存超时失效，动作结束后无切换。',
        events: seq(e => [e(0, 'A', 'down'), e(450, 'A', 'up'), e(455, 'A', 'down'), e(495, 'A', 'up')]),
      },
    ],
  },
  {
    name: '③ 按住时重复上报',
    desc: '有些设备按住不放会周期性重复上报 down。引擎按键状态去重：已按下的键再收到 down 直接忽略。',
    samples: [
      {
        group: '③ 按住时重复上报', label: '3a 长按+重复上报 → 长按斩×1',
        note: '按住 A 期间每 100ms 重复上报一次 down，全部被忽略，「长按斩」只触发一次。',
        events: seq(e => [
          e(0, 'A', 'down'), e(100, 'A', 'down'), e(200, 'A', 'down'), e(300, 'A', 'down'),
          e(400, 'A', 'down'), e(500, 'A', 'down'), e(600, 'A', 'up'),
        ]),
      },
      {
        group: '③ 按住时重复上报', label: '3b 干净长按 → 结果相同',
        note: '没有任何重复上报的干净长按。与 3a 对比：动作序列与消费事件完全一致。',
        events: seq(e => [e(0, 'A', 'down'), e(600, 'A', 'up')]),
      },
      {
        group: '③ 按住时重复上报', label: '3c 松开后真重复 → 轻击×2',
        note: '松开再按才是两次输入：两次短按各自成立为「轻击」（第二次落在双击窗口外）。与 3a 对比可见重复上报 ≠ 真实重复。',
        events: seq(e => [e(0, 'A', 'down'), e(120, 'A', 'up'), e(900, 'A', 'down'), e(1020, 'A', 'up')]),
      },
    ],
  },
];
