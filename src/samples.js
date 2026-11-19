/**
 * 内置示例：场景绘制与标注真值共用同一组几何参数，
 * 因此示例里的图形与标注框严格对齐，方便验证坐标、重叠和导出。
 *
 * 这些图片由代码在本地生成（浏览器内生成位图，或由
 * `npm run generate:samples` 落盘为 PNG），不依赖任何外部资源。
 */

import {
  fillCircle,
  fillEllipse,
  fillPolygon,
  fillRect,
  fillRoundedRect,
  mulberry32,
  scatterDots,
  strokeLine,
  verticalGradient,
} from './paint.js';

export const SAMPLE_LABELS = [
  { key: 'road', name: '道路', color: '#f5a623' },
  { key: 'vehicle', name: '车辆', color: '#e5484d' },
  { key: 'building', name: '建筑', color: '#6e56cf' },
  { key: 'pedestrian', name: '行人', color: '#12a594' },
  { key: 'shelf', name: '货架', color: '#0090ff' },
  { key: 'box', name: '纸箱', color: '#8d4e2a' },
  { key: 'aisle', name: '通道', color: '#f2e14c' },
  { key: 'lamp', name: '灯具', color: '#b8bcd0' },
  { key: 'field', name: '田地', color: '#46a758' },
  { key: 'water', name: '水域', color: '#d6409f' },
  { key: 'sky', name: '天空', color: '#8b8d98' },
];

const LABEL_BY_KEY = new Map(SAMPLE_LABELS.map((label) => [label.key, label]));

/* ---------------- 场景一：街景 ---------------- */

const streetScene = {
  id: 'sample-street',
  name: 'street-scene.png',
  width: 960,
  height: 640,
  draw(buffer) {
    const W = buffer.width;
    const H = buffer.height;
    verticalGradient(buffer, [46, 62, 88], [122, 150, 186], 0, 300);
    // 天空云层
    fillEllipse(buffer, 220, 96, 90, 30, [255, 255, 255, 46]);
    fillEllipse(buffer, 300, 112, 70, 24, [255, 255, 255, 38]);
    fillEllipse(buffer, 720, 70, 110, 28, [255, 255, 255, 30]);
    // 建筑
    fillRect(buffer, 0, 150, 310, 250, [42, 48, 62]);
    fillRect(buffer, 20, 176, 64, 46, [70, 82, 105]);
    fillRect(buffer, 104, 176, 64, 46, [70, 82, 105]);
    fillRect(buffer, 190, 176, 64, 46, [70, 82, 105]);
    fillRect(buffer, 20, 248, 64, 46, [70, 82, 105]);
    fillRect(buffer, 104, 248, 64, 46, [70, 82, 105]);
    fillRect(buffer, 660, 120, 300, 280, [56, 50, 70]);
    fillRect(buffer, 690, 150, 52, 60, [96, 84, 120]);
    fillRect(buffer, 766, 150, 52, 60, [96, 84, 120]);
    fillRect(buffer, 842, 150, 52, 60, [96, 84, 120]);
    fillRect(buffer, 690, 232, 52, 60, [96, 84, 120]);
    fillRect(buffer, 766, 232, 52, 60, [96, 84, 120]);
    fillRect(buffer, 842, 232, 52, 60, [96, 84, 120]);
    // 树冠与树干
    fillRect(buffer, 596, 300, 12, 74, [86, 64, 44]);
    fillCircle(buffer, 602, 284, 54, [58, 112, 70]);
    fillCircle(buffer, 574, 300, 34, [66, 126, 78]);
    fillCircle(buffer, 632, 302, 32, [50, 102, 62]);
    // 人行道与路缘
    fillRect(buffer, 0, 374, W, 34, [130, 132, 136]);
    fillRect(buffer, 0, 404, W, 8, [96, 98, 102]);
    // 道路
    fillRect(buffer, 0, 412, W, H - 412, [58, 60, 66]);
    for (let x = -40; x < W; x += 96) {
      fillRect(buffer, x, 520, 56, 7, [214, 206, 168]);
    }
    // 远处的小汽车（重叠在道路上）
    fillRoundedRect(buffer, 96, 396, 132, 52, 12, [196, 74, 74]);
    fillRect(buffer, 122, 404, 76, 24, [48, 56, 68]);
    fillCircle(buffer, 126, 450, 13, [28, 28, 32]);
    fillCircle(buffer, 198, 450, 13, [28, 28, 32]);

    // 主车辆（与道路、建筑重叠）
    fillRoundedRect(buffer, 346, 448, 262, 96, 16, [214, 166, 58]);
    fillRect(buffer, 390, 432, 168, 40, [228, 186, 88]);
    fillRect(buffer, 402, 440, 66, 24, [70, 92, 118]);
    fillRect(buffer, 480, 440, 66, 24, [70, 92, 118]);
    fillRect(buffer, 360, 490, 234, 10, [128, 96, 34]);
    fillCircle(buffer, 392, 544, 25, [24, 24, 28]);
    fillCircle(buffer, 560, 544, 25, [24, 24, 28]);
    fillCircle(buffer, 392, 544, 11, [110, 112, 118]);
    fillCircle(buffer, 560, 544, 11, [110, 112, 118]);
    fillCircle(buffer, 596, 490, 7, [255, 238, 180]);
    fillCircle(buffer, 358, 490, 6, [255, 120, 110]);

    // 行人（与车辆、道路重叠）
    for (const [x, y, scale, shirt] of [
      [262, 424, 1, [64, 120, 200]],
      [310, 430, 0.92, [70, 160, 120]],
      [650, 420, 1.05, [188, 88, 160]],
    ]) {
      const s = scale;
      fillCircle(buffer, x, y - 30 * s, 10 * s, [222, 186, 156]);
      fillRoundedRect(buffer, x - 11 * s, y - 20 * s, 22 * s, 32 * s, 6 * s, [...shirt, 255]);
      strokeLine(buffer, x - 6 * s, y + 12 * s, x - 8 * s, y + 38 * s, 7 * s, [46, 48, 58]);
      strokeLine(buffer, x + 6 * s, y + 12 * s, x + 9 * s, y + 38 * s, 7 * s, [46, 48, 58]);
    }

    // 路面细节
    const random = mulberry32(7);
    for (let i = 0; i < 160; i += 1) {
      fillCircle(buffer, random() * W, 412 + random() * (H - 412), 1.1, [74, 76, 82]);
    }
    // 标注提示线（斑马线）
    for (let i = 0; i < 7; i += 1) {
      fillRect(buffer, 120 + i * 54, 580, 30, 46, [226, 228, 232]);
    }
    scatterDots(buffer, 1.4, 1.4, 0, 412, W, H - 412, [88, 90, 96], 60, 3);
  },
  annotations: [
    { label: 'sky', type: 'polygon', points: [[0, 0], [960, 0], [960, 148], [660, 148], [660, 398], [0, 398]] },
    { label: 'building', type: 'rect', rect: { x: 0, y: 150, width: 310, height: 250 } },
    { label: 'building', type: 'rect', rect: { x: 660, y: 120, width: 300, height: 280 } },
    { label: 'road', type: 'polygon', points: [[0, 404], [960, 404], [960, 640], [0, 640]] },
    { label: 'vehicle', type: 'rect', rect: { x: 96, y: 396, width: 132, height: 64 } },
    { label: 'vehicle', type: 'polygon', points: [[346, 432], [558, 432], [604, 470], [608, 544], [346, 544]] },
    { label: 'pedestrian', type: 'rect', rect: { x: 246, y: 388, width: 34, height: 82 } },
    { label: 'pedestrian', type: 'rect', rect: { x: 294, y: 394, width: 32, height: 78 } },
    { label: 'pedestrian', type: 'polygon', points: [[634, 386], [668, 386], [670, 482], [636, 482]] },
    { label: 'road', type: 'rect', rect: { x: 118, y: 576, width: 408, height: 54 }, hidden: false },
    // 隐藏标注：示例展示“隐藏后不参与导出，也不影响其他标注”
    { label: 'vehicle', type: 'rect', rect: { x: 0, y: 410, width: 40, height: 40 }, hidden: true },
  ],
};

/* ---------------- 场景二：仓库货架 ---------------- */

const warehouseScene = {
  id: 'sample-warehouse',
  name: 'warehouse.png',
  width: 900,
  height: 600,
  draw(buffer) {
    const W = buffer.width;
    const H = buffer.height;
    fillRect(buffer, 0, 0, W, H, [38, 40, 46]);
    // 地面与透视地面
    fillPolygon(buffer, [[0, 300], [W, 300], [W, H], [0, H]], [66, 68, 76]);
    for (let i = 0; i < 9; i += 1) {
      fillRect(buffer, 0, 310 + i * 34, W, 2, [76, 78, 88]);
    }
    // 左货架
    fillRect(buffer, 70, 120, 250, 360, [50, 60, 76]);
    for (let row = 0; row < 4; row += 1) {
      fillRect(buffer, 70, 150 + row * 82, 250, 9, [98, 110, 132]);
      for (let col = 0; col < 3; col += 1) {
        fillRect(buffer, 84 + col * 78, 104 + row * 82, 62, 46, [128, 104, 78]);
        fillRect(buffer, 84 + col * 78, 104 + row * 82, 62, 8, [152, 126, 96]);
      }
    }
    // 右货架（部分被纸箱堆遮挡）
    fillRect(buffer, 600, 100, 230, 380, [48, 56, 70]);
    for (let row = 0; row < 4; row += 1) {
      fillRect(buffer, 600, 128 + row * 88, 230, 9, [94, 106, 128]);
    }
    fillRect(buffer, 612, 138, 70, 46, [116, 92, 66]);
    fillRect(buffer, 692, 138, 70, 46, [140, 112, 78]);
    fillRect(buffer, 612, 226, 70, 46, [116, 92, 66]);
    fillRect(buffer, 692, 226, 70, 46, [140, 112, 78]);
    fillRect(buffer, 612, 314, 70, 46, [116, 92, 66]);

    // 地面纸箱堆（与货架、地面重叠）
    for (const [x, y, w, h, tint] of [
      [340, 330, 120, 96, 0],
      [468, 348, 96, 82, -16],
      [350, 430, 112, 86, 12],
      [478, 436, 90, 78, -22],
      [566, 402, 58, 112, 4],
    ]) {
      const base = [176, 134, 88];
      fillRect(buffer, x, y, w, h, [base[0] + tint, base[1] + tint, base[2] + tint, 255]);
      fillRect(buffer, x, y, w, 10, [base[0] + tint + 18, base[1] + tint + 18, base[2] + tint + 18, 255]);
      strokeLine(buffer, x + w / 2, y + 10, x + w / 2, y + h, 3, [138, 102, 64]);
      fillRect(buffer, x + w / 2 - 14, y + h / 2 - 8, 28, 16, [226, 216, 196]);
    }
    // 托盘
    fillRect(buffer, 322, 512, 270, 16, [104, 80, 54]);
    fillRect(buffer, 322, 548, 270, 16, [104, 80, 54]);

    // 安全通道斜线区域（与货架、纸箱重叠）
    fillPolygon(buffer, [[250, 560], [560, 560], [620, 476], [300, 476]], [220, 184, 54, 42]);
    for (let i = 0; i < 6; i += 1) {
      fillPolygon(
        buffer,
        [[290 + i * 52, 476], [316 + i * 52, 476], [286 + i * 52, 560], [260 + i * 52, 560]],
        [234, 200, 76, 56],
      );
    }

    // 顶部照明
    fillRoundedRect(buffer, 250, 40, 380, 16, 6, [222, 226, 214, 220]);
    for (let i = 0; i < 5; i += 1) {
      fillEllipse(buffer, 290 + i * 80, 96, 32, 12, [255, 250, 220, 26]);
    }
    const random = mulberry32(21);
    for (let i = 0; i < 90; i += 1) {
      fillCircle(buffer, random() * W, random() * H, 1, [52, 54, 62]);
    }
  },
  annotations: [
    { label: 'shelf', type: 'rect', rect: { x: 70, y: 104, width: 250, height: 376 } },
    { label: 'shelf', type: 'rect', rect: { x: 600, y: 100, width: 230, height: 380 } },
    { label: 'box', type: 'rect', rect: { x: 340, y: 330, width: 120, height: 96 } },
    { label: 'box', type: 'rect', rect: { x: 468, y: 348, width: 96, height: 82 } },
    { label: 'box', type: 'rect', rect: { x: 350, y: 430, width: 112, height: 86 } },
    { label: 'box', type: 'rect', rect: { x: 478, y: 436, width: 90, height: 78 } },
    { label: 'box', type: 'polygon', points: [[566, 402], [624, 402], [624, 514], [566, 514]] },
    { label: 'aisle', type: 'polygon', points: [[250, 560], [560, 560], [620, 476], [300, 476]] },
    // 锁定的标注：示例展示锁定后不可编辑，但依然导出
    { label: 'lamp', type: 'rect', rect: { x: 250, y: 40, width: 380, height: 16 }, locked: true },
  ],
};

/* ---------------- 场景三：航拍田地 ---------------- */

const farmScene = {
  id: 'sample-farm',
  name: 'aerial-farm.png',
  width: 768,
  height: 768,
  draw(buffer) {
    const W = buffer.width;
    const H = buffer.height;
    fillRect(buffer, 0, 0, W, H, [92, 118, 70]);
    // 田地
    fillPolygon(buffer, [[0, 0], [430, 0], [470, 300], [380, 520], [0, 560]], [112, 140, 80]);
    fillPolygon(buffer, [[430, 0], [768, 0], [768, 260], [500, 300], [470, 300]], [96, 124, 66]);
    fillPolygon(buffer, [[0, 560], [380, 520], [470, 300], [768, 260], [768, 768], [0, 768]], [124, 148, 86]);
    // 田地垄沟
    for (let i = 0; i < 42; i += 1) {
      const t = i / 42;
      strokeLine(buffer, 20 + t * 400, 20, 400 + t * 40, 740, 2, [104, 132, 74, 160]);
    }
    for (let i = 0; i < 26; i += 1) {
      strokeLine(buffer, 470 + i * 12, 10, 380 + i * 15, 750, 2, [110, 136, 78, 140]);
    }
    // 灌溉水渠
    fillPolygon(buffer, [[330, 768], [392, 768], [420, 520], [452, 500], [452, 300], [432, 296], [404, 500], [376, 520]], [64, 96, 112]);
    // 矩形地块（与多边形田地重叠）
    fillRect(buffer, 560, 330, 180, 140, [156, 160, 96]);
    fillRect(buffer, 560, 330, 180, 10, [176, 180, 112]);
    // 水塘
    fillEllipse(buffer, 560, 610, 150, 96, [52, 96, 120]);
    fillEllipse(buffer, 540, 604, 110, 70, [64, 116, 144]);
    fillEllipse(buffer, 610, 640, 40, 22, [52, 96, 120, 200]);
    // 建筑与小道
    fillRect(buffer, 70, 600, 150, 96, [176, 170, 154]);
    fillRect(buffer, 70, 600, 150, 12, [198, 192, 176]);
    fillRect(buffer, 100, 632, 34, 28, [96, 104, 118]);
    fillRect(buffer, 156, 632, 34, 28, [96, 104, 118]);
    strokeLine(buffer, 0, 690, 540, 690, 14, [186, 172, 140]);
    strokeLine(buffer, 0, 690, 540, 690, 10, [206, 194, 166]);
    // 树木
    const random = mulberry32(99);
    for (let i = 0; i < 16; i += 1) {
      const x = 20 + random() * 720;
      const y = 20 + random() * 420;
      const r = 8 + random() * 10;
      fillCircle(buffer, x, y, r, [58, 92, 56]);
      fillCircle(buffer, x - r * 0.3, y - r * 0.3, r * 0.65, [74, 112, 66]);
    }
    // 收割机
    fillRoundedRect(buffer, 300, 650, 62, 34, 6, [214, 176, 52]);
    fillRect(buffer, 318, 644, 28, 12, [228, 196, 80]);
    fillRect(buffer, 310, 684, 44, 8, [60, 62, 66]);
  },
  annotations: [
    { label: 'field', type: 'polygon', points: [[0, 0], [430, 0], [470, 300], [380, 520], [0, 560]] },
    { label: 'field', type: 'polygon', points: [[430, 0], [768, 0], [768, 260], [500, 300], [470, 300]] },
    { label: 'field', type: 'polygon', points: [[0, 560], [380, 520], [470, 300], [768, 260], [768, 768], [0, 768]] },
    { label: 'field', type: 'rect', rect: { x: 560, y: 330, width: 180, height: 140 } },
    { label: 'water', type: 'polygon', points: [[430, 496], [540, 520], [666, 548], [704, 610], [668, 682], [560, 706], [452, 664], [420, 580]] },
    { label: 'water', type: 'rect', rect: { x: 340, y: 300, width: 112, height: 468 } },
    { label: 'building', type: 'rect', rect: { x: 70, y: 600, width: 150, height: 96 } },
    { label: 'vehicle', type: 'rect', rect: { x: 300, y: 644, width: 62, height: 48 } },
  ],
};

export const SAMPLE_SCENES = [streetScene, warehouseScene, farmScene];

/**
 * 生成示例位图。
 * @param {object} scene
 * @param {{createBuffer: (w:number,h:number,color?:number[]) => {width:number,height:number,rgba:Uint8ClampedArray}}} factory
 */
export function drawScene(scene, factory) {
  const buffer = factory(scene.width, scene.height, [12, 14, 18, 255]);
  scene.draw(buffer);
  return buffer;
}

/** 构造示例项目（标注坐标与图片同源）。 */
export function buildSampleProject(ids) {
  const labels = SAMPLE_LABELS.map((label) => ({
    id: ids.label(label.key),
    name: label.name,
    color: label.color,
  }));
  const labelIdByKey = new Map(SAMPLE_LABELS.map((label) => [label.key, ids.label(label.key)]));
  const images = SAMPLE_SCENES.map((scene) => ({
    id: ids.image(scene.id),
    name: scene.name,
    width: scene.width,
    height: scene.height,
    source: { kind: 'sample', sceneId: scene.id },
    annotations: scene.annotations.map((annotation, index) => ({
      id: ids.annotation(scene.id, index),
      type: annotation.type,
      labelId: labelIdByKey.get(annotation.label),
      ...(annotation.type === 'polygon'
        ? { points: annotation.points.map(([x, y]) => [x, y]) }
        : { rect: { ...annotation.rect } }),
      hidden: Boolean(annotation.hidden),
      locked: Boolean(annotation.locked),
    })),
  }));
  return {
    version: 1,
    labels,
    images,
    activeImageId: images[0].id,
  };
}

export function sampleLabelName(key) {
  return LABEL_BY_KEY.get(key)?.name ?? key;
}
