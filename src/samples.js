// 内置样例图标：均为 64x64，包含贝塞尔曲线、重叠图层、自相交等场景
import { anchor, V, ellipseSubpaths, rectSubpaths } from './geometry.js';
import { createPath, setSmooth } from './model.js';

const A = (x, y, hi = [0, 0], ho = [0, 0], smooth = false) =>
  anchor(x, y, V(hi[0], hi[1]), V(ho[0], ho[1]), smooth);

// 心形：6 个锚点的对称平滑闭合曲线，演示贝塞尔 + 闭合填充
function heart() {
  // 锚点顺序：底尖 -> 左外弧 -> 左顶 -> 中凹 -> 右顶 -> 右外弧，闭合回底尖
  const pts = [
    [32, 54], [12, 30], [16, 14], [32, 22], [48, 14], [52, 30],
  ];
  const anchors = pts.map(([x, y]) => anchor(x, y));
  const sp = { closed: true, anchors };
  const body = createPath([sp], {
    fill: '#ef4444', stroke: '#991b1b', strokeWidth: 2, fillRule: 'nonzero',
  }, '心形');
  // 统一设为平滑锚点，按相邻锚点方向生成共线镜像控制柄，保证闭合段切线连续
  for (let i = 0; i < anchors.length; i++) setSmooth(body, 0, i, true);
  const shine = createPath(ellipseSubpaths(22, 22, 5, 3.5), {
    fill: '#fecaca', stroke: 'none', strokeWidth: 0,
  }, '高光');
  return [body, shine];
}

// 月亮 + 星星：重叠图层，星星演示 evenodd 自相交镂空
function moonStar() {
  // 新月：外圆与内圆两条子路径，evenodd 镂空
  const moon = createPath([
    ...ellipseSubpaths(30, 32, 22, 22),
    ...ellipseSubpaths(38, 26, 19, 19),
  ], { fill: '#f59e0b', stroke: '#b45309', strokeWidth: 1.5, fillRule: 'evenodd' }, '新月');

  // 五角星（自相交折线），evenodd 下中心呈星形镂空
  const pts = [];
  const cx = 46, cy = 46, R = 11, r = 4.6;
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(A(cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)));
  }
  const star = createPath([{ closed: true, anchors: pts }], {
    fill: '#fde047', stroke: '#a16207', strokeWidth: 1.5, fillRule: 'evenodd',
  }, '五角星');
  return [moon, star];
}

// 铃铛：曲线铃身 + 矩形底座 + 圆形铃锤，多图层重叠
function bell() {
  // 铃身：底边两角为角点，肩部三点平滑，形成圆顶喇叭轮廓
  const dome = {
    closed: true,
    anchors: [
      anchor(14, 44),          // 左下（角点）
      anchor(16, 26),          // 左肩
      anchor(32, 12),          // 顶
      anchor(48, 26),          // 右肩
      anchor(50, 44),          // 右下（角点）
    ],
  };
  const body = createPath([dome], {
    fill: '#3b82f6', stroke: '#1e3a8a', strokeWidth: 2, fillRule: 'nonzero',
  }, '铃身');
  // 仅肩部三锚点平滑，底角保持尖角
  for (const i of [1, 2, 3]) setSmooth(body, 0, i, true);
  const base = createPath(rectSubpaths(10, 42, 44, 6), {
    fill: '#2563eb', stroke: '#1e3a8a', strokeWidth: 2,
  }, '铃口');
  const clapper = createPath(ellipseSubpaths(32, 54, 5, 5), {
    fill: '#1d4ed8', stroke: '#1e3a8a', strokeWidth: 2,
  }, '铃锤');
  const handle = createPath([{
    closed: false,
    anchors: [anchor(32, 12), anchor(32, 6), anchor(38, 6)],
  }], { fill: 'none', stroke: '#1e3a8a', strokeWidth: 2.5, strokeLinecap: 'round' }, '提手');
  // 栈序：提手在最底，铃身、铃口、铃锤依次在上
  return [handle, body, base, clapper];
}

// 云 + 闪电：连续曲线凸起 + 多边形叠加，闪电用 evenodd 表现穿层
function cloudBolt() {
  // 云朵：底边两角为角点，上沿 6 个平滑锚点形成连续凸起
  const cloud = {
    closed: true,
    anchors: [
      anchor(12, 44),          // 左下
      anchor(14, 32),
      anchor(24, 28),
      anchor(30, 18),
      anchor(44, 20),
      anchor(48, 30),
      anchor(54, 34),
      anchor(52, 44),          // 右下
    ],
  };
  const cloudNode = createPath([cloud], {
    fill: '#e0f2fe', stroke: '#0369a1', strokeWidth: 2, fillRule: 'nonzero',
  }, '云朵');
  for (let i = 1; i <= 6; i++) setSmooth(cloudNode, 0, i, true);
  const bolt = createPath([{
    closed: true,
    anchors: [anchor(34, 30), anchor(26, 44), anchor(33, 44), anchor(30, 56), anchor(42, 40), anchor(35, 40), anchor(39, 30)],
  }], { fill: '#f59e0b', stroke: '#b45309', strokeWidth: 1.5, fillRule: 'evenodd' }, '闪电');
  return [cloudNode, bolt];
}

export const SAMPLES = [
  { id: 'heart', name: '心形图标（曲线 + 高光层）', size: 64, build: heart },
  { id: 'moon', name: '星月图标（重叠图层 + evenodd 镂空）', size: 64, build: moonStar },
  { id: 'bell', name: '铃铛图标（曲线铃身 + 多部件）', size: 64, build: bell },
  { id: 'cloud', name: '云与闪电（连续曲线 + 多边形叠加）', size: 64, build: cloudBolt },
];

export function buildSampleDoc(sample) {
  const layers = sample.build();
  return { version: 1, width: sample.size, height: sample.size, layers };
}
