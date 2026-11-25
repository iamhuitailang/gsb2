/*
 * scene.js — 内置场景与场景数据的序列化/校验
 *
 * 世界坐标与画布内部像素一一对应：原点 (0,0) 在左上，x 向右、y 向下，
 * 1 世界单位 = 1 画布像素。导出光照图时沿用同一坐标系并输出映射 JSON。
 */
(function (root, factory) {
  root.Scene = factory(root.Geometry);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Scene;
})(typeof window !== 'undefined' ? window : globalThis, function (Geom) {
  'use strict';

  const WORLD = { width: 1000, height: 700 };

  /*
   * 内置调试场景：
   *  - 四周封闭外墙（含凹角）
   *  - 一道 L 形墙，制造凹角与长阴影
   *  - 一道留 28px 窄缝的横墙
   *  - 一个矩形小挡块
   *  - M1/M2 两个标记点相距仅 30px，分别正对/错开窄缝，
   *    把灯拖到 M1 与 M2 可看到“看着相近、实际遮挡不同”的效果
   */
  function createDefaultScene() {
    const uid = () => Geom.uid('w');
    const walls = [
      // 封闭外墙
      {
        id: Geom.uid('w'),
        name: '外墙',
        points: [
          { x: 40, y: 40 }, { x: 960, y: 40 },
          { x: 960, y: 660 }, { x: 40, y: 660 }, { x: 40, y: 40 },
        ],
      },
      // L 形墙（凹角）
      {
        id: Geom.uid('w'),
        name: 'L 形墙',
        points: [
          { x: 180, y: 180 }, { x: 430, y: 180 },
          { x: 430, y: 400 },
        ],
      },
      // 窄缝横墙：y=480，x ∈ [220, 520) ∪ [548, 800]，缝宽 28px
      {
        id: Geom.uid('w'),
        name: '窄缝墙（左段）',
        points: [{ x: 220, y: 480 }, { x: 520, y: 480 }],
      },
      {
        id: Geom.uid('w'),
        name: '窄缝墙（右段）',
        points: [{ x: 548, y: 480 }, { x: 800, y: 480 }],
      },
      // 矩形小挡块
      {
        id: Geom.uid('w'),
        name: '矩形挡块',
        points: [
          { x: 620, y: 250 }, { x: 720, y: 250 },
          { x: 720, y: 330 }, { x: 620, y: 330 }, { x: 620, y: 250 },
        ],
      },
    ];

    const lights = [
      { id: Geom.uid('l'), name: '暖光灯', x: 130, y: 120, color: '#ffd27d', radius: 360, intensity: 1.0, on: true },
      { id: Geom.uid('l'), name: '冷光灯', x: 880, y: 140, color: '#8fc6ff', radius: 330, intensity: 0.95, on: true },
      { id: Geom.uid('l'), name: '红灯', x: 360, y: 600, color: '#ff7a7a', radius: 300, intensity: 0.9, on: true },
    ];

    const markers = [
      // 正对窄缝（缝 x∈[520,548]）：灯在此处可穿过缝照亮下方
      { id: Geom.uid('m'), name: 'M1 正对窄缝', x: 534, y: 430 },
      // 错开 30px，被右段实墙挡住
      { id: Geom.uid('m'), name: 'M2 错开窄缝', x: 564, y: 430 },
    ];

    return { version: 1, world: { ...WORLD }, walls, lights, markers };
  }

  function createEmptyScene() {
    return {
      version: 1,
      world: { ...WORLD },
      walls: [
        {
          id: Geom.uid('w'), name: '外墙',
          points: [
            { x: 40, y: 40 }, { x: 960, y: 40 },
            { x: 960, y: 660 }, { x: 40, y: 660 }, { x: 40, y: 40 },
          ],
        },
      ],
      lights: [
        { id: Geom.uid('l'), name: '灯 1', x: 500, y: 350, color: '#ffe9b0', radius: 260, intensity: 1, on: true },
      ],
      markers: [],
    };
  }

  /* 宽松校验 + 规范化，载入外部 JSON 时调用；失败抛带中文说明的 Error */
  function validateScene(data) {
    if (!data || typeof data !== 'object') throw new Error('场景数据不是 JSON 对象');
    const world = data.world && Number.isFinite(data.world.width) && Number.isFinite(data.world.height)
      ? { width: data.world.width, height: data.world.height }
      : { ...WORLD };

    const num = (v, fallback) => Number.isFinite(v) ? v : fallback;
    const walls = [];
    if (!Array.isArray(data.walls)) throw new Error('walls 必须是数组');
    for (const w of data.walls) {
      if (!w || !Array.isArray(w.points) || w.points.length < 2) {
        throw new Error('存在点数不足 2 的墙链');
      }
      const points = w.points
        .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map(p => ({ x: +p.x, y: +p.y }));
      if (points.length < 2) throw new Error('存在没有有效端点的墙链');
      walls.push({ id: w.id || Geom.uid('w'), name: w.name || '墙', points });
    }

    const lights = [];
    if (!Array.isArray(data.lights)) throw new Error('lights 必须是数组');
    for (const l of data.lights) {
      if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) {
        throw new Error('存在缺少坐标的灯');
      }
      lights.push({
        id: l.id || Geom.uid('l'),
        name: l.name || '灯',
        x: +l.x, y: +l.y,
        color: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#ffffff',
        radius: Math.max(10, num(l.radius, 260)),
        intensity: Math.max(0, Math.min(3, num(l.intensity, 1))),
        on: l.on !== false,
      });
    }

    const markers = Array.isArray(data.markers)
      ? data.markers
        .filter(m => m && Number.isFinite(m.x) && Number.isFinite(m.y))
        .map(m => ({ id: m.id || Geom.uid('m'), name: m.name || '标记', x: +m.x, y: +m.y }))
      : [];

    return { version: 1, world, walls, lights, markers };
  }

  return { WORLD, createDefaultScene, createEmptyScene, validateScene };
});
