/**
 * 程序绘制的角色样例：「苔灯蘑菇」。
 *
 * 40×40，4 个图层（影子 / 身体 / 菌伞 / 表情），8 帧呼吸+踏步循环，
 * 每帧停留时间刻意不同（100–240ms），总循环 1120ms。
 * 浏览器端和 Node 端共用此模块：页面启动时可一键载入，脚本也能导出一份
 * 工程 JSON 放在 samples/ 下。
 */
import {
  fillEllipse,
  fillEllipseHalf,
  fillRect,
  line,
  createBuffer,
  setPixel,
  setPixelIfOpaque,
} from '../core/raster.js';
import { createProject } from '../core/project.js';

export const SAMPLE_NAME = '苔灯蘑菇 · 呼吸循环';

const W = 40;
const H = 40;

const COLORS = {
  outline: '#241b2f',
  shadow: '#1a1c2c',
  capDark: '#a82f3e',
  cap: '#d94f4f',
  capLight: '#f2716e',
  spot: '#ffe0c2',
  bodyShade: '#d3b083',
  body: '#f2d7a8',
  bodyLight: '#ffeccc',
  eye: '#2a2130',
  white: '#ffffff',
  blush: '#e88b7d',
  stemShade: '#8a6b4f',
};

const PALETTE = [
  COLORS.outline,
  COLORS.shadow,
  COLORS.capDark,
  COLORS.cap,
  COLORS.capLight,
  COLORS.spot,
  COLORS.stemShade,
  COLORS.bodyShade,
  COLORS.body,
  COLORS.bodyLight,
  COLORS.eye,
  COLORS.white,
  COLORS.blush,
  '#a7f070',
  '#38b764',
  '#73eff7',
];

// 可复现的 id，保证生成的 JSON 稳定。
export const LAYERS = [
  { id: 'layer-shadow', name: '影子', visible: true, locked: false },
  { id: 'layer-body', name: '身体', visible: true, locked: false },
  { id: 'layer-cap', name: '菌伞', visible: true, locked: false },
  { id: 'layer-face', name: '表情', visible: true, locked: false },
];

/**
 * 每帧的姿势与停留时间。durations 刻意不等长：吸气快、呼气慢、眨眼时停顿。
 * bob: 身体垂直偏移；squash: 身体压扁量；footL/footR: 脚抬起像素；
 * blink: 闭眼；arm: 手臂摆动 -1/0/1；tilt: 菌伞左右倾斜。
 */
export const POSES = [
  { duration: 160, bob: 0, squash: 0, footL: 0, footR: 0, blink: false, arm: 0, tilt: 0 },
  { duration: 100, bob: -1, squash: 0, footL: 1, footR: 0, blink: false, arm: -1, tilt: -1 },
  { duration: 100, bob: -2, squash: 0, footL: 1, footR: 1, blink: false, arm: -1, tilt: -1 },
  { duration: 140, bob: -1, squash: 0, footL: 0, footR: 1, blink: false, arm: 0, tilt: 0 },
  { duration: 240, bob: 0, squash: 1, footL: 0, footR: 0, blink: true, arm: 0, tilt: 1 },
  { duration: 100, bob: 0, squash: 0, footL: 0, footR: 0, blink: true, arm: 1, tilt: 1 },
  { duration: 120, bob: -1, squash: 0, footL: 0, footR: 1, blink: false, arm: 1, tilt: 0 },
  { duration: 160, bob: -2, squash: 0, footL: 1, footR: 1, blink: false, arm: 0, tilt: -1 },
];

function rgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
    255,
  ];
}

const C = Object.fromEntries(Object.entries(COLORS).map(([key, hex]) => [key, rgb(hex)]));
// GIF 只有 1 位透明度（阈值 50%），因此影子保持半透明但不低于 128，
// 导出 GIF 时仍可保留柔和的投影。
const SHADOW_COLOR = [C.shadow[0], C.shadow[1], C.shadow[2], 150];

function outlinedEllipse(buf, cx, cy, rx, ry, fill, outline = C.outline) {
  fillEllipse(buf, W, H, cx, cy, rx + 1, ry + 1, outline);
  fillEllipse(buf, W, H, cx, cy, rx, ry, fill);
}

function outlinedEllipseHalf(buf, cx, cy, rx, ry, fill, outline = C.outline) {
  fillEllipseHalf(buf, W, H, cx, cy, rx + 1, ry + 1, outline, true);
  fillEllipseHalf(buf, W, H, cx, cy, rx, ry, fill, true);
}

function drawShadow(buf) {
  fillEllipse(buf, W, H, 20, 34.5, 11, 2.6, SHADOW_COLOR);
}

function drawBody(buf, pose) {
  const baseY = 27 + pose.bob;
  const squash = pose.squash;
  const bodyRx = 7 + squash;
  const bodyRy = 6.5 - squash * 0.6;

  // 脚（先画，让身体压住脚踝）
  const footY = 32.5 + pose.bob * 0.5 - pose.squash * 0.4;
  for (const [footX, lift] of [
    [15.5, pose.footL],
    [24.5, pose.footR],
  ]) {
    outlinedEllipse(buf, footX, footY - lift, 3, 1.8, C.bodyShade);
  }

  // 手臂
  const armY = baseY + 1;
  const armDrop = pose.arm;
  outlinedEllipse(buf, 12.5, armY + armDrop, 2.2, 3, C.body);
  outlinedEllipse(buf, 27.5, armY - armDrop, 2.2, 3, C.body);
  line(buf, W, H, 11, armY + armDrop + 2, 11, armY + armDrop + 3, C.outline);
  line(buf, W, H, 29, armY - armDrop + 2, 29, armY - armDrop + 3, C.outline);

  // 身体
  outlinedEllipse(buf, 20, baseY, bodyRx, bodyRy, C.body);
  // 右侧阴影
  for (let y = Math.floor(baseY - bodyRy); y <= Math.ceil(baseY + bodyRy); y += 1) {
    for (let x = 20; x <= 20 + bodyRx; x += 1) {
      const nx = (x - 20) / bodyRx;
      const ny = (y - baseY) / bodyRy;
      if (nx * nx + ny * ny > 0.92) continue;
      if (nx > 0.55) setPixelIfOpaque(buf, W, H, x, y, C.bodyShade);
    }
  }
  // 左侧高光
  fillEllipse(buf, W, H, 17, baseY - 2, 1.6, 2.2, C.bodyLight);
  // 身体下沿的一圈菌褶阴影
  for (let x = 14; x <= 26; x += 1) {
    setPixelIfOpaque(buf, W, H, x, Math.round(baseY + bodyRy - 1.5), C.stemShade);
  }
}

function drawCap(buf, pose) {
  const capY = 21 + pose.bob + pose.squash * 0.6;
  const cx = 20 + pose.tilt * 0.6;
  const rx = 12;
  const ry = 7.5;

  outlinedEllipseHalf(buf, cx, capY, rx, ry, C.cap);
  // 下沿加深
  for (let x = Math.floor(cx - rx + 1); x <= Math.ceil(cx + rx - 1); x += 1) {
    for (let y = Math.floor(capY - 2); y <= Math.ceil(capY); y += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - capY) / ry;
      if (nx * nx + ny * ny <= 1 && ny > -0.35) {
        setPixelIfOpaque(buf, W, H, x, y, C.capDark);
      }
    }
  }
  // 左上方高光
  fillEllipseHalf(buf, W, H, cx - 4.5, capY - 3.2, 4.2, 2.6, C.capLight, true);
  // 菌盖斑点（固定位置，随帽子整体平移）
  const spots = [
    [-6, -4.5, 1.6],
    [0.5, -6, 1.3],
    [6, -4, 1.8],
    [8.5, -1.5, 1.1],
    [-9.5, -1.5, 1.0],
    [3.5, -3, 0.9],
  ];
  for (const [dx, dy, r] of spots) {
    fillEllipse(buf, W, H, cx + dx + pose.tilt * 0.2, capY + dy, r, r * 0.85, C.spot);
  }
  // 伞柄
  fillRect(buf, W, H, 18, Math.round(capY), 4, 2, C.bodyShade);
  line(buf, W, H, 21, Math.round(capY), 21, Math.round(capY) + 2, C.stemShade);
  line(buf, W, H, 17, Math.round(capY), 17, Math.round(capY) + 1, C.outline);
  line(buf, W, H, 22, Math.round(capY), 22, Math.round(capY) + 1, C.outline);
}

function drawFace(buf, pose) {
  const eyeY = 26 + pose.bob + pose.squash * 0.5;
  const eyeXs = [16, 23];
  if (pose.blink) {
    for (const x of eyeXs) {
      for (let dx = 0; dx < 3; dx += 1) {
        setPixel(buf, W, H, x + dx, Math.round(eyeY) + 1, C.eye);
      }
    }
  } else {
    for (const x of eyeXs) {
      for (let dx = 0; dx < 2; dx += 1) {
        for (let dy = 0; dy < 3; dy += 1) {
          setPixel(buf, W, H, x + dx, Math.round(eyeY) + dy, C.eye);
        }
      }
      setPixel(buf, W, H, x, Math.round(eyeY), C.white);
    }
  }
  // 嘴
  const mouthY = Math.round(eyeY) + 4;
  if (pose.squash) {
    line(buf, W, H, 19, mouthY, 21, mouthY, C.eye);
  } else {
    setPixel(buf, W, H, 19, mouthY, C.eye);
    setPixel(buf, W, H, 20, mouthY + 1, C.eye);
    setPixel(buf, W, H, 21, mouthY, C.eye);
  }
}

/** 腮红画在身体图层上：表情图层是透明的，叠上去会遮掉身体。 */
function drawBlush(buf, pose) {
  const eyeY = 26 + pose.bob + pose.squash * 0.5;
  setPixelIfOpaque(buf, W, H, 13, Math.round(eyeY) + 2, C.blush);
  setPixelIfOpaque(buf, W, H, 14, Math.round(eyeY) + 3, C.blush);
  setPixelIfOpaque(buf, W, H, 26, Math.round(eyeY) + 2, C.blush);
  setPixelIfOpaque(buf, W, H, 25, Math.round(eyeY) + 3, C.blush);
}

export function createMosslingProject() {
  const project = createProject({
    width: W,
    height: H,
    name: SAMPLE_NAME,
    palette: PALETTE,
  });
  project.palette = PALETTE.map((hex, index) => ({ id: `color-${index}`, hex }));
  project.layers = LAYERS.map((layer) => ({ ...layer }));

  const frames = POSES.map((pose, index) => {
    const cels = {};
    const shadow = createBuffer(W, H);
    drawShadow(shadow);
    cels['layer-shadow'] = shadow;

    const body = createBuffer(W, H);
    drawBody(body, pose);
    drawBlush(body, pose);
    cels['layer-body'] = body;

    const cap = createBuffer(W, H);
    drawCap(cap, pose);
    cels['layer-cap'] = cap;

    const face = createBuffer(W, H);
    drawFace(face, pose);
    cels['layer-face'] = face;

    return {
      id: `frame-${String(index + 1).padStart(2, '0')}`,
      duration: pose.duration,
      cels,
    };
  });

  project.frames = frames;
  return project;
}
