/* 算法级单测：在 Node 中直接加载 src/revision.js，用合成指纹验证 DP 对齐。
 * 场景模拟样片：90 帧旧版，在第 40 帧后插入 15 个独特帧 → 105 帧新版。 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const sandbox = {
  console, Math, Date, JSON, Float32Array, Float64Array, Uint8Array, Array, Object,
  crypto: globalThis.crypto,
  document: { createElement: () => ({ getContext: () => { throw new Error('no canvas in node'); } }) },
};
vm.createContext(sandbox);
for (const f of ['util.js', 'thumbnails.js', 'revision.js']) {
  const code = fs.readFileSync(path.join(REPO, 'src', f), 'utf8');
  // 脚本顶层 const/let 不挂 global，追加一行显式导出
  const exportLine = f === 'revision.js' ? '\nthis.Revision = Revision;'
    : f === 'thumbnails.js' ? '\nthis.Thumbnails = Thumbnails;' : '';
  vm.runInContext(code + exportLine, sandbox, { filename: f });
}
const Revision = sandbox.Revision;
const Thumbnails = sandbox.Thumbnails;

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { failures++; console.error('  ❌', msg); }
};

// 每帧一个确定性“指纹”：前 143 维为帧号编码，保证不同帧相似度低、相同帧完全一致
function sigOf(frameId) {
  const s = new Float32Array(144);
  s[0] = frameId + 5;                       // 主判别维度（+5 避免帧 0 退化为全零）
  s[1] = (frameId * 7) % 13 + 1;
  for (let i = 2; i < 144; i++) s[i] = (frameId * (i + 3)) % 17 + 1;
  return s;
}
const INSERT_AT = 40, GAP = 15, N_OLD = 90;
const oldSigs = Array.from({ length: N_OLD }, (_, i) => sigOf(i));
const newSigs = [];
for (let i = 0; i < INSERT_AT; i++) newSigs.push(sigOf(i));
for (let k = 0; k < GAP; k++) newSigs.push(sigOf(10000 + k));   // 插入的独有帧
for (let i = INSERT_AT; i < N_OLD; i++) newSigs.push(sigOf(i));

console.log('[A] 插入场景对齐（90 → 105，插入 15 帧）');
const al = Revision.align(oldSigs, newSigs);
let insertMappedRight = true;
for (let i = 0; i < INSERT_AT; i++) if (al.mapOldToNew[i] !== i) insertMappedRight = false;
assert(insertMappedRight, '插入点之前的 40 帧一一对应（0..39 → 0..39）');
let shiftRight = true;
for (let i = INSERT_AT; i < N_OLD; i++) if (al.mapOldToNew[i] !== i + GAP) shiftRight = false;
assert(shiftRight, '插入点之后的帧整体后移 15（40..89 → 55..104）');
const matched = al.scores.filter((s) => s >= Revision.CONF_AUTO).length;
assert(matched === N_OLD, `全部 ${N_OLD} 个旧帧高置信匹配（实际 ${matched}）`);

console.log('[B] 意见映射：时间段意见 60-74 应迁移到 75-89');
const comments = [
  { id: 'a', startFrame: 12, endFrame: null },
  { id: 'b', startFrame: 25, endFrame: null },
  { id: 'c', startFrame: 60, endFrame: 74 },
];
const mappings = Revision.mapComments(comments, al, newSigs.length);
const mA = mappings.find((m) => m.commentId === 'a');
const mC = mappings.find((m) => m.commentId === 'c');
assert(mA.newStart === 12 && mA.confidence >= 0.85, '点意见 #a 留在第 12 帧且高置信');
assert(mC.newStart === 75 && mC.newEnd === 89, `时间段 #c 迁移 60-74 → ${mC.newStart}-${mC.newEnd}`);

console.log('[C] 删除场景（新版删掉旧版第 30..34 共 5 帧，90 → 85）');
const delSigs = oldSigs.filter((_, i) => i < 30 || i >= 35);
const al2 = Revision.align(delSigs, oldSigs); // 注意参数顺序：old=删后(85), new=原始(90) → 反向验证
// 正向：old=原始90, new=删后85
const al3 = Revision.align(oldSigs, delSigs);
let delOk = true;
for (let i = 0; i < 30; i++) if (al3.mapOldToNew[i] !== i) delOk = false;
for (let i = 35; i < N_OLD; i++) if (al3.mapOldToNew[i] !== i - 5) delOk = false;
assert(delOk, '删除点前不动、删除点后整体前移 5');
const deletedFrames = [30, 31, 32, 33, 34].map((i) => al3.mapOldToNew[i]);
assert(deletedFrames.every((f) => f >= 29 && f <= 35), `被删帧落到 gap 边界供人工确认（${deletedFrames.join(',')}）`);
assert(al3.scores[30] === 0, '被删帧置信度为 0 → 触发待人工确认');

console.log('[D] NCC 基本性质');
const s1 = sigOf(5), s2 = sigOf(5);
assert(Math.abs(Thumbnails.ncc(s1, s2) - 1) < 1e-9, '相同指纹 NCC = 1');
assert(Thumbnails.ncc(sigOf(1), sigOf(2)) < Revision.CONF_SOFT, '不同指纹 NCC 低于软阈值');

console.log(failures ? `\n❌ ${failures} 项失败` : '\n🎉 算法单测全部通过');
process.exitCode = failures ? 1 : 0;
