/*
 * 三组程序化示例数据。真实素材到位后，可直接按同样的 manifest 结构从 JSON 导入。
 *
 * 帧字段：
 *   id        帧唯一标识
 *   source    图片路径（程序化示例为 proc:// 伪路径；真实素材填相对路径）
 *   anchorX/Y 脚底锚点（帧自身坐标系像素）
 *   duration  停留时间（毫秒）
 *   missing   true 表示该帧位置缺图（仍保留锚点和时长占位）
 *   phase     程序化绘制用的动作周期进度 [0,1)
 */
(function (root) {
  'use strict';

  const W = 160;
  const H = 180;
  const DEFAULT_ANCHOR = { x: 80, y: 152 };

  const DIRECTIONS = [
    { id: 'N',  name: '北',   angle: 0 },
    { id: 'NE', name: '东北', angle: 45 },
    { id: 'E',  name: '东',   angle: 90 },
    { id: 'SE', name: '东南', angle: 135 },
    { id: 'S',  name: '南',   angle: 180 },
    { id: 'SW', name: '西南', angle: 225 },
    { id: 'W',  name: '西',   angle: 270 },
    { id: 'NW', name: '西北', angle: 315 },
  ];

  const ACTIONS = [
    { id: 'idle', name: '待机', frameCount: 4, frameDuration: 260 },
    { id: 'walk', name: '行走', frameCount: 6, frameDuration: 150 },
  ];

  const PALETTES = {
    standard: {
      body: '#0f766e', bodyBack: '#115e59', hood: '#0d9488', pants: '#334155',
      shoe: '#111827', skin: '#e8b890', glove: '#dc2626', arrow: '#0d9488',
    },
    shift: {
      body: '#7c3aed', bodyBack: '#5b21b6', hood: '#8b5cf6', pants: '#312e81',
      shoe: '#111827', skin: '#e8b890', glove: '#dc2626', arrow: '#8b5cf6',
    },
    missing: {
      body: '#c2410c', bodyBack: '#9a3412', hood: '#ea580c', pants: '#44403c',
      shoe: '#111827', skin: '#e8b890', glove: '#dc2626', arrow: '#ea580c',
    },
  };

  function buildFrames(action, dir, opts) {
    const frames = [];
    for (let i = 0; i < action.frameCount; i++) {
      const missing = opts.missingFrames && opts.missingFrames.includes(i);
      let anchor = { x: DEFAULT_ANCHOR.x, y: DEFAULT_ANCHOR.y };
      if (opts.shiftAnchors) {
        // 故意让锚点随方向、随帧漂移：用来验证“锚点对齐”开关能否消除地面跳动
        const rad = (dir.angle * Math.PI) / 180;
        anchor = {
          x: 80 + Math.round(11 * Math.sin(rad)) + (i % 2 === 0 ? 5 : -5),
          y: 152 + ((i * 3 + dir.angle / 45) % 9) - 4,
        };
      }
      frames.push({
        id: `${action.id}-${dir.id}-${i}`,
        source: missing ? null : `proc://${action.id}/${dir.id}/${i}.png`,
        anchorX: anchor.x,
        anchorY: anchor.y,
        duration: action.frameDuration,
        missing: !!missing,
        phase: i / action.frameCount,
      });
    }
    return frames;
  }

  function buildDataset(id, name, description, palette, options) {
    const sequences = {};
    const skip = options.skip || {};
    const missingFrames = options.missingFrames || {};
    for (const action of ACTIONS) {
      for (const dir of DIRECTIONS) {
        const fullSkip = (skip[action.id] || []).includes(dir.id);
        if (fullSkip) continue; // 整条序列缺失
        const frames = buildFrames(action, dir, {
          missingFrames: (missingFrames[action.id] || {})[dir.id],
          shiftAnchors: !!options.shiftAnchors,
        });
        sequences[`${action.id}:${dir.id}`] = { actionId: action.id, directionId: dir.id, frames };
      }
    }
    return {
      id, name, description,
      frameWidth: W, frameHeight: H,
      defaultAnchor: { ...DEFAULT_ANCHOR },
      directions: JSON.parse(JSON.stringify(DIRECTIONS)),
      actions: JSON.parse(JSON.stringify(ACTIONS)),
      sequences,
      palette,
    };
  }

  const standard = buildDataset('standard', '标准版', '八个方向 × 两个动作齐全，锚点统一在脚底 (80,152)。', PALETTES.standard, {});

  const anchorShift = buildDataset(
    'anchor-shift', '锚点错位版', '同一角色的锚点随方向和帧故意漂移，用于验证锚点对齐是否消除地面跳动。',
    PALETTES.shift, { shiftAnchors: true }
  );

  const missing = buildDataset(
    'missing', '缺素材版', '行走缺西/西北/北，待机缺西；待机东南第 3 帧缺帧。北与南镜像后是自己，无法替代。',
    PALETTES.missing,
    {
      skip: {
        walk: ['W', 'NW', 'N'],
        idle: ['W'],
      },
      missingFrames: {
        idle: { SE: [2] },
      },
    }
  );

  if (typeof module === 'object' && module.exports) {
    module.exports = { DIRECTIONS, ACTIONS, PALETTES, datasets: [standard, anchorShift, missing] };
  } else {
    root.ExampleData = { DIRECTIONS, ACTIONS, PALETTES, datasets: [standard, anchorShift, missing] };
  }
})(typeof self !== 'undefined' ? self : this);
