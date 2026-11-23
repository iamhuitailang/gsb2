// 时间线 / 音频编排的单元测试：直接跑纯模型，不依赖浏览器或 ffmpeg。
import assert from 'node:assert/strict';
import {
  buildTimeline, resolveDissolves, videoLayersAt, transitionFramesAt,
  dissolveBudget, maxDissolveAt, projectFps,
} from '../src/timeline.js';
import { createProject, normalizeProject, setTrim, setTransition, validateProject } from '../src/project.js';
import { buildAudioPlan, audioTransitionPlan, gainAt, planGainAt } from '../src/audio.js';
import { clipAudioDuration, clipLength } from '../src/model.js';

let passed = 0;
const failures = [];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}
function group(name) {
  console.log(`\n${name}`);
}

function clip(over = {}) {
  return {
    id: over.id || 'c',
    name: over.name || 'clip',
    src: over.src || 'a.mp4',
    duration: over.duration ?? 10,
    srcIn: over.srcIn ?? 0,
    srcOut: over.srcOut ?? (over.duration ?? 10),
    fps: over.fps ?? 30,
    width: 640, height: 360,
    hasAudio: over.hasAudio ?? true,
    audioDuration: over.audioDuration ?? (over.duration ?? 10),
    locked: false,
    ...over,
  };
}

function project(clips, transitions, over = {}) {
  return normalizeProject(createProject({ clips, transitions, ...over }));
}

group('时长与叠化占用');
test('三处硬切时总长等于各段截取之和', () => {
  const p = project([
    clip({ id: 'a', srcIn: 1, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0.5, srcOut: 2.5 }),
    clip({ id: 'c', srcIn: 2, srcOut: 4 }),
  ], [{ type: 'cut' }, { type: 'cut' }]);
  const tl = buildTimeline(p);
  assert.equal(tl.duration, 2 + 2 + 2);
  assert.equal(tl.hardCutTotal, 6);
  assert.equal(tl.dissolveTotal, 0);
  assert.equal(tl.clips[0].start, 0);
  assert.equal(tl.clips[1].start, 2);
  assert.equal(tl.clips[2].start, 4);
});

test('一处叠化让总长减少叠化时长，重叠窗口正确', () => {
  const p = project([
    clip({ id: 'a', srcIn: 1, srcOut: 3 }), // len 2
    clip({ id: 'b', srcIn: 0.5, srcOut: 2.5 }), // len 2
  ], [{ type: 'dissolve', duration: 0.8 }]);
  const tl = buildTimeline(p);
  assert.ok(near(tl.clips[1].start, 1.2), `B 应从 1.2 开始，实际 ${tl.clips[1].start}`);
  assert.ok(near(tl.duration, 3.2), `成片应为 3.2，实际 ${tl.duration}`);
  assert.equal(tl.hardCutTotal, 4);
  assert.ok(near(tl.dissolveTotal, 0.8));
  const tr = tl.transitions[0];
  assert.ok(near(tr.start, 1.2));
  assert.ok(near(tr.end, 2));
  const b = dissolveBudget(tl);
  assert.ok(near(b.saved, 0.8));
  assert.ok(Math.abs(b.percentOfHard - 20) < 1e-6);
});

test('叠化占据硬切总时长的比例可被明确读出', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 5 }),
    clip({ id: 'b', srcIn: 0, srcOut: 5 }),
  ], [{ type: 'dissolve', duration: 1.5 }]);
  const tl = buildTimeline(p);
  const b = dissolveBudget(tl);
  assert.ok(near(b.dissolveTotal, 1.5), `叠化总量应为 1.5，实际 ${b.dissolveTotal}`);
  assert.ok(near(b.finalDuration, 8.5), `成片应为 8.5，实际 ${b.finalDuration}`);
  assert.ok(Math.abs(b.percentOfFinal - (1.5 / 8.5) * 100) < 0.05);
});

group('叠化可用画面上限');
test('叠化超过右侧可用画面被收窄，并给出原因', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 0.4 }),
  ], [{ type: 'dissolve', duration: 2 }]);
  const tl = buildTimeline(p);
  assert.ok(tl.transitions[0].duration <= 0.4 + 1e-6);
  assert.ok(tl.issues.some((x) => /片段 2|右侧片段 2/.test(x.message)), '应指出是第 2 段画面不够');
});

test('两侧叠化在同一段上互相挤占', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 1.0 }),
    clip({ id: 'c', srcIn: 0, srcOut: 3 }),
  ], [{ type: 'dissolve', duration: 0.7 }, { type: 'dissolve', duration: 0.7 }]);
  const tl = buildTimeline(p);
  const sum = tl.transitions[0].duration + tl.transitions[1].duration;
  assert.ok(sum <= 1.0 + 1e-6, `两侧叠化合计 ${sum} 超过 1.0 s`);
  assert.ok(tl.issues.length >= 1);
});

test('maxDissolveAt 反映当前可借用的画面', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2 }),
    clip({ id: 'b', srcIn: 0, srcOut: 5 }),
  ], [{ type: 'cut' }]);
  const max = maxDissolveAt(p, 0);
  assert.ok(Math.abs(max - 2) < 1e-6, `期望 2，实际 ${max}`);
});

test('叠化时长对齐到项目帧率的整帧', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 5 }),
    clip({ id: 'b', srcIn: 0, srcOut: 5 }),
  ], [{ type: 'dissolve', duration: 0.777 }], { fps: 30 });
  const tl = buildTimeline(p);
  const frames = tl.transitions[0].duration * 30;
  assert.ok(Math.abs(frames - Math.round(frames)) < 1e-3, `叠化应对齐整帧，实际 ${frames} 帧`);
  assert.ok(tl.transitions[0].duration <= 0.777 + 1e-9);
});

group('统一时间 → 各源帧');
test('不同帧率素材在同一统一时间按各自帧率定位', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2, fps: 30 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, fps: 25 }),
  ], [{ type: 'cut' }]);
  const tl = buildTimeline(p);
  const t = 2.5; // 在 B 段，统一时间 2.5
  const layers = videoLayersAt(tl, t);
  assert.equal(layers.length, 1);
  const b = tl.clips[1];
  const expectedSrc = b.srcIn + (t - b.start);
  assert.ok(Math.abs(layers[0].srcTime - expectedSrc) < 1e-6);
  assert.equal(layers[0].fps, 25);
  assert.equal(layers[0].frame, Math.floor(expectedSrc * 25));
});

test('同一秒在 30fps 与 25fps 下的帧号各自正确', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3, fps: 30 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, fps: 25 }),
  ], [{ type: 'cut' }]);
  const tl = buildTimeline(p);
  const aFrameAt1 = videoLayersAt(tl, 1)[0].frame;
  const bFrameAt4 = videoLayersAt(tl, 4)[0].frame;
  assert.equal(aFrameAt1, 30);
  assert.equal(bFrameAt4, 25);
});

test('叠化窗口内给出两层与正确 alpha', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3 }),
  ], [{ type: 'dissolve', duration: 1 }]);
  const tl = buildTimeline(p);
  const tr = tl.transitions[0];
  const mid = (tr.start + tr.end) / 2;
  const layers = videoLayersAt(tl, mid);
  assert.equal(layers.length, 2);
  assert.ok(Math.abs(layers[0].weight - 0.5) < 1e-6);
  assert.ok(Math.abs(layers[1].weight - 0.5) < 1e-6);
  const f = transitionFramesAt(tl, tr, mid);
  assert.ok(Math.abs(f.alpha - 0.5) < 1e-6);
  assert.equal(f.left.clipIndex, 0);
  assert.equal(f.right.clipIndex, 1);
});

test('叠化起点 alpha 约为 0、终点约为 1', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3 }),
  ], [{ type: 'dissolve', duration: 1 }]);
  const tl = buildTimeline(p);
  const tr = tl.transitions[0];
  const fStart = transitionFramesAt(tl, tr, tr.start + 0.01);
  const fEnd = transitionFramesAt(tl, tr, tr.end - 0.01);
  assert.ok(fStart.alpha < 0.05);
  assert.ok(fEnd.alpha > 0.95);
});

group('锁定与波纹');
test('锁定段的取点在改动其它段后保持不变', () => {
  let p = project([
    clip({ id: 'a', srcIn: 1, srcOut: 3 }),
    clip({ id: 'b', srcIn: 0.5, srcOut: 2.5 }),
    clip({ id: 'c', srcIn: 1, srcOut: 3 }),
  ], [{ type: 'dissolve', duration: 0.5 }, { type: 'cut' }]);
  p.clips[0].locked = true;
  p = setTrim(p, 1, { srcIn: 2.0, srcOut: 3.5 });
  assert.equal(p.clips[0].srcIn, 1);
  assert.equal(p.clips[0].srcOut, 3);
});

test('中间段变短后后续时间线同步前移', () => {
  let p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3 }),
    clip({ id: 'c', srcIn: 0, srcOut: 2 }),
  ], [{ type: 'cut' }, { type: 'cut' }]);
  let tl = buildTimeline(p);
  const beforeC = tl.clips[2].start;
  p = setTrim(p, 1, { srcIn: 0, srcOut: 1 });
  tl = buildTimeline(p);
  assert.equal(tl.clips[2].start, beforeC - 2);
  assert.equal(tl.duration, 2 + 1 + 2);
});

group('音频编排');
test('音频只从入点开始，不重播片头', () => {
  const p = project([
    clip({ id: 'a', srcIn: 1.5, srcOut: 4, hasAudio: true, audioDuration: 10 }),
  ], []);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  assert.equal(plan[0].srcOffset, 1.5);
  assert.equal(plan[0].start, 0);
  assert.ok(Math.abs(plan[0].end - 2.5) < 1e-6);
});

test('缺音轨时相邻有声段平滑淡入淡出到静音', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2, hasAudio: true, audioDuration: 2 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, hasAudio: false }),
  ], [{ type: 'cut' }], { missingAudioFade: 0.3 });
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  assert.equal(plan[1].silent, true);
  // A 在结尾前 0.3 s 淡出
  const gAtEnd = gainAt(plan[0].points, 1.99);
  assert.ok(gAtEnd < 0.15, `结尾增益应接近 0，实际 ${gAtEnd}`);
  const gAtMid = gainAt(plan[0].points, 1.0);
  assert.ok(gAtMid > 0.9);
});

test('无音轨段之后的段由静音平滑淡入', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2, hasAudio: false }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, hasAudio: true, audioDuration: 2 }),
  ], [{ type: 'cut' }], { missingAudioFade: 0.3 });
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  assert.equal(plan[0].silent, true);
  const gAtStart = gainAt(plan[1].points, 2.01);
  assert.ok(gAtStart < 0.1, `起点增益应接近 0，实际 ${gAtStart}`);
  const gAfter = gainAt(plan[1].points, 2.6);
  assert.ok(gAfter > 0.95);
});

test('定点切换在叠化交叠窗口里让左源淡出、右源淡入', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
  ], [{ type: 'dissolve', duration: 1, audio: { mode: 'switch', switchTime: 2.5 } }]);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  const at = (t) => planGainAt(plan, t);
  // 交叠窗口 2–3 s，切换点在 2.5
  assert.ok(at(2.2) > 0.8, '切换前左源应有声');
  assert.ok(at(2.5) < 0.25, '切换点附近应基本静音');
  assert.ok(at(2.7) > 0.8, '切换后右源应有声');
});

test('硬切的定点切换退化为在切点切换', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
  ], [{ type: 'cut', audio: { mode: 'switch', switchTime: 8 } }]);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  const at = (t) => planGainAt(plan, t);
  assert.ok(at(2.9) > 0.8, '切点前左源应有声');
  assert.ok(at(3.2) > 0.8, '切点后右源应有声');
  // 切换点被夹到切点，不会跑到第二段中间
  const info = audioTransitionPlan(tl, tl.transitions[0], p);
  assert.ok(Math.abs(info.switchAt - 3) < 1e-6);
});

test('转场处静音模式在交界处两侧都归零', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 2, hasAudio: true, audioDuration: 2 }),
    clip({ id: 'b', srcIn: 0, srcOut: 2, hasAudio: true, audioDuration: 2 }),
  ], [{ type: 'cut', audio: { mode: 'mute' } }]);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  const at = (t) => planGainAt(plan, t);
  assert.ok(at(2.0) < 0.2, `交界处应接近静音，实际 ${at(2.0)}`);
  assert.ok(at(1.5) > 0.8);
  assert.ok(at(2.5) > 0.8);
});

test('音频比画面短时在结束前淡出，而不是骤然截断', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 4, hasAudio: true, audioDuration: 2 }),
  ], []);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  assert.ok(Math.abs(plan[0].end - 2) < 1e-6);
  assert.ok(gainAt(plan[0].points, 1.99) < 0.15);
  assert.ok(plan[0].shortAudio);
});

test('叠化跟随模式在窗口内让两段音频等功率交叠', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
  ], [{ type: 'dissolve', duration: 1 }]);
  const tl = buildTimeline(p);
  const plan = buildAudioPlan(tl, p);
  const tr = tl.transitions[0];
  const mid = (tr.start + tr.end) / 2;
  const gA = gainAt(plan[0].points, mid);
  const gB = gainAt(plan[1].points, mid);
  assert.ok(gA > 0.4 && gA < 0.9);
  assert.ok(gB > 0.4 && gB < 0.9);
  const power = gA * gA + gB * gB;
  assert.ok(Math.abs(power - 1) < 0.05, `等功率应接近 1，实际 ${power}`);
});

test('音频转场说明区分跟随 / 切换 / 静音', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
    clip({ id: 'b', srcIn: 0, srcOut: 3, hasAudio: true, audioDuration: 3 }),
  ], [{ type: 'dissolve', duration: 1, audio: { mode: 'switch', switchTime: 2.6 } }]);
  const tl = buildTimeline(p);
  const plan = audioTransitionPlan(tl, tl.transitions[0], p);
  assert.equal(plan.mode, 'switch');
  assert.ok(plan.details.some((d) => d.includes('定点切换')));
});

group('校验');
test('合法三连通过校验', () => {
  const p = project([
    clip({ id: 'a', srcIn: 0.5, srcOut: 3.5 }),
    clip({ id: 'b', srcIn: 1, srcOut: 3, fps: 25 }),
    clip({ id: 'c', srcIn: 0.4, srcOut: 2.6, hasAudio: false, audioDuration: 0 }),
  ], [{ type: 'dissolve', duration: 0.8 }, { type: 'cut' }]);
  const v = validateProject(p);
  assert.equal(v.ok, true, v.checks.filter((c) => !c.ok).map((c) => c.label).join('; '));
});

test('零长度截取被校验拦截', () => {
  const p = project([clip({ id: 'a', srcIn: 2, srcOut: 2 })], []);
  const v = validateProject(p);
  assert.equal(v.ok, false);
});

test('设出点小于入点时自动纠正为至少一帧', () => {
  let p = project([clip({ id: 'a', srcIn: 1, srcOut: 3, fps: 30 })], []);
  p = setTrim(p, 0, { srcOut: 0.5 });
  assert.ok(p.clips[0].srcOut > p.clips[0].srcIn);
  assert.ok(p.clips[0].srcOut - p.clips[0].srcIn >= 1 / 30 - 1e-9);
});

test('projectFps 默认 30', () => {
  assert.equal(projectFps({}), 30);
  assert.equal(projectFps({ fps: 25 }), 25);
});

test('clipAudioDuration 从入点算起', () => {
  assert.equal(clipAudioDuration({ hasAudio: true, audioDuration: 10, duration: 10, srcIn: 2, srcOut: 6 }), 4);
  assert.equal(clipAudioDuration({ hasAudio: false }), 0);
});

test('clipLength 始终非负', () => {
  assert.equal(clipLength({ srcIn: 3, srcOut: 1 }), 0);
  assert.equal(clipLength({ srcIn: 1, srcOut: 3 }), 2);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`- ${f.name}\n  ${f.err.stack.split('\n').slice(0, 4).join('\n  ')}`);
  process.exit(1);
}
