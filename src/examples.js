/*
 * Built-in demos. Both use the default five categories; only the event sheet
 * differs.
 *
 * "dense" is constructed so that under the default settings (3 voices, 420 ms,
 * steal) every outcome is guaranteed:
 *   - three sounds land on t=0 and occupy all three channels;
 *   - the sword at t=20 is higher priority, so it must cut the footstep
 *     (kept → preempted);
 *   - the UI at t=20 then has to queue past the 180 ms mark (delayed);
 *   - seven UI clicks on the same frame at 1.5 s exceed maxDelay through the
 *     trigger interval, so the tail is dropped.
 */

export const SAMPLES = [
  {
    id: 'dense',
    name: '冲突密集',
    description:
      '0ms 三条声音占满通道，20ms 的剑击必然顶掉脚步；同帧 7 次界面连点把末尾推出最大延迟而舍弃。',
    events: [
      { id: 'e1', categoryId: 'hit', timeMs: 0, note: '受击' },
      { id: 'e2', categoryId: 'coin', timeMs: 0, note: '金币 +5' },
      { id: 'e3', categoryId: 'footstep', timeMs: 0, note: '落地（将被剑击顶掉）' },
      { id: 'e4', categoryId: 'sword', timeMs: 20, note: '起手劈砍' },
      { id: 'e5', categoryId: 'ui', timeMs: 20, note: '按钮确认（排队）' },
      { id: 'e6', categoryId: 'footstep', timeMs: 100, note: '第二步' },
      { id: 'e7', categoryId: 'hit', timeMs: 150, note: '被击中' },
      { id: 'e8', categoryId: 'coin', timeMs: 200, note: '金币 +5' },
      { id: 'e9', categoryId: 'ui', timeMs: 250, note: '确认音' },
      { id: 'e10', categoryId: 'sword', timeMs: 300, note: '连斩' },
      { id: 'e11', categoryId: 'footstep', timeMs: 340, note: '撤步' },
      { id: 'e12', categoryId: 'coin', timeMs: 360, note: '金币 +10' },
      { id: 'e13', categoryId: 'hit', timeMs: 380, note: '重击命中' },
      { id: 'e14', categoryId: 'footstep', timeMs: 400, note: '第三段' },
      { id: 'e15', categoryId: 'ui', timeMs: 430, note: '提示音' },
      { id: 'e16', categoryId: 'hit', timeMs: 560, note: '连击' },
      { id: 'e17', categoryId: 'footstep', timeMs: 600, note: '冲刺落点' },
      { id: 'e18', categoryId: 'ui', timeMs: 600, note: '同帧提示' },
      { id: 'e19', categoryId: 'coin', timeMs: 600, note: '金币雨' },
      { id: 'e20', categoryId: 'hit', timeMs: 600, note: '爆炸边缘' },
      { id: 'e21', categoryId: 'sword', timeMs: 601, note: '收招' },
      { id: 'e22', categoryId: 'footstep', timeMs: 640, note: '落地收势' },
      { id: 'e23', categoryId: 'coin', timeMs: 660, note: '金币 +5' },
      { id: 'e24', categoryId: 'ui', timeMs: 700, note: '提示音' },
      { id: 'e25', categoryId: 'hit', timeMs: 720, note: '余波' },
      // Same-frame UI spam: the trigger interval pushes the tail past maxDelay.
      { id: 'e26', categoryId: 'ui', timeMs: 1500, note: '连点 1' },
      { id: 'e27', categoryId: 'ui', timeMs: 1500, note: '连点 2' },
      { id: 'e28', categoryId: 'ui', timeMs: 1500, note: '连点 3' },
      { id: 'e29', categoryId: 'ui', timeMs: 1500, note: '连点 4' },
      { id: 'e30', categoryId: 'ui', timeMs: 1500, note: '连点 5' },
      { id: 'e31', categoryId: 'ui', timeMs: 1500, note: '连点 6' },
      { id: 'e32', categoryId: 'ui', timeMs: 1500, note: '连点 7' },
    ],
  },
  {
    id: 'roomy',
    name: '全部放完',
    description: '10 个事件间隔 500ms：默认设置下每个事件都能完整播出。',
    events: [
      { id: 'r1', categoryId: 'footstep', timeMs: 0, note: '第一步' },
      { id: 'r2', categoryId: 'coin', timeMs: 500, note: '金币 +5' },
      { id: 'r3', categoryId: 'sword', timeMs: 1000, note: '挥剑' },
      { id: 'r4', categoryId: 'hit', timeMs: 1500, note: '受击' },
      { id: 'r5', categoryId: 'ui', timeMs: 2000, note: '菜单' },
      { id: 'r6', categoryId: 'footstep', timeMs: 2500, note: '第二步' },
      { id: 'r7', categoryId: 'coin', timeMs: 3000, note: '金币 +10' },
      { id: 'r8', categoryId: 'sword', timeMs: 3500, note: '格挡' },
      { id: 'r9', categoryId: 'hit', timeMs: 4000, note: '受击' },
      { id: 'r10', categoryId: 'ui', timeMs: 4500, note: '确认' },
    ],
  },
];

export function getSample(id) {
  return SAMPLES.find((s) => s.id === id) || SAMPLES[0];
}
