/* 内置示例工程：文字进场 → 形状条扫屏转场 → Logo/点缀落入 → 结尾停留 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const M = G.Model;

  function kf(prop, t, values, ease) {
    return M.makeKf(prop, t, values, ease || 'linear');
  }

  function buildSampleProject() {
    const p = M.createDefaultProject();
    p.name = '示例 · 灵动标题片头';
    p.duration = 6;
    p.fps = 30;

    /* ---------- 主标题 ---------- */
    const title = M.createTextLayer(p, {
      name: '主标题',
      text: '灵动标题',
      fontSize: 158,
      fontWeight: 900,
      w: 1400,
      h: 220,
      color: '#ffffff',
    });
    title.y = 566;
    title.letterSpacing = 8;
    title.keys.position = [
      kf('position', 0.25, { x: 960, y: 660 }, 'easeOutCubic'),
      kf('position', 1.05, { x: 960, y: 566 }),
    ];
    title.keys.opacity = [
      kf('opacity', 0.25, { v: 0 }, 'easeOutQuad'),
      kf('opacity', 0.8, { v: 100 }),
    ];
    title.keys.scale = [
      kf('scale', 0.25, { sx: 92, sy: 92 }, 'easeOutCubic'),
      kf('scale', 1.05, { sx: 100, sy: 100 }),
    ];

    /* ---------- 英文副标题 ---------- */
    const en = M.createTextLayer(p, {
      name: '英文副标题',
      text: 'MOTION  GRAPHICS  STUDIO',
      fontSize: 30,
      fontWeight: 600,
      w: 1300,
      h: 56,
      color: '#9db2ff',
    });
    en.y = 392;
    en.letterSpacing = 10;
    en.shadow = { enabled: false };
    en.keys.position = [
      kf('position', 0.1, { x: 960, y: 356 }, 'easeOutCubic'),
      kf('position', 0.7, { x: 960, y: 392 }),
    ];
    en.keys.opacity = [
      kf('opacity', 0.1, { v: 0 }, 'linear'),
      kf('opacity', 0.7, { v: 100 }),
    ];

    /* ---------- 中文说明 ---------- */
    const tag = M.createTextLayer(p, {
      name: '副标题文案',
      text: '文字 · 形状 · 图片，导出透明动画',
      fontSize: 38,
      fontWeight: 500,
      w: 1200,
      h: 58,
      color: '#d9e0f7',
    });
    tag.y = 786;
    tag.shadow = { enabled: false };
    tag.keys.position = [
      kf('position', 1.15, { x: 960, y: 824 }, 'easeOutCubic'),
      kf('position', 1.75, { x: 960, y: 786 }),
    ];
    tag.keys.opacity = [
      kf('opacity', 1.15, { v: 0 }),
      kf('opacity', 1.65, { v: 100 }),
    ];

    /* ---------- 胶囊底板 ---------- */
    const pill = M.createRectLayer(p, {
      name: '副标题底板',
      w: 880,
      h: 66,
      radius: 33,
      fill: '#232c4d',
    });
    pill.y = 788;
    pill.opacity = 78;
    pill.keys.scale = [
      kf('scale', 1.05, { sx: 70, sy: 70 }, 'easeOutBack'),
      kf('scale', 1.7, { sx: 100, sy: 100 }),
    ];
    pill.keys.opacity = [
      kf('opacity', 1.05, { v: 0 }),
      kf('opacity', 1.5, { v: 78 }),
    ];

    /* ---------- 装饰强调条 ---------- */
    const accent = M.createRectLayer(p, {
      name: '强调条',
      w: 380,
      h: 14,
      radius: 7,
      fill: '#37d4e8',
    });
    accent.y = 694;
    accent.shadow = { enabled: true, color: 'rgba(55,212,232,0.55)', blur: 26, offsetY: 0 };
    accent.keys.size = [
      kf('size', 0.85, { w: 0, h: 14 }, 'easeOutCubic'),
      kf('size', 1.5, { w: 380, h: 14 }),
    ];
    accent.keys.opacity = [
      kf('opacity', 0.85, { v: 0 }),
      kf('opacity', 1.05, { v: 100 }),
    ];

    /* ---------- Logo 图片 ---------- */
    const logo = M.createImageLayer(p, {
      name: 'Logo 图片',
      src: G.SampleAssets.badge,
      imgW: 240,
      imgH: 240,
      w: 158,
      h: 158,
    });
    logo.y = 212;
    logo.keys.scale = [
      kf('scale', 0.3, { sx: 0, sy: 0 }, 'easeOutBack'),
      kf('scale', 1.15, { sx: 100, sy: 100 }),
    ];
    logo.keys.rotation = [
      kf('rotation', 0.3, { v: -28 }, 'easeOutBack'),
      kf('rotation', 1.15, { v: 0 }),
    ];
    logo.keys.opacity = [
      kf('opacity', 0.3, { v: 0 }),
      kf('opacity', 0.55, { v: 100 }),
    ];

    /* ---------- Logo 光晕 ---------- */
    const glow = M.createRectLayer(p, {
      name: 'Logo 光晕',
      w: 360,
      h: 360,
      radius: 180,
      fill: '#6e8bff',
    });
    glow.y = 212;
    glow.opacity = 22;
    glow.keys.scale = [
      kf('scale', 0.4, { sx: 40, sy: 40 }, 'easeOutCubic'),
      kf('scale', 1.4, { sx: 100, sy: 100 }),
    ];
    glow.keys.opacity = [
      kf('opacity', 0.4, { v: 0 }),
      kf('opacity', 1.4, { v: 22 }),
    ];

    /* ---------- 两颗星形素材 ---------- */
    const sparkL = M.createImageLayer(p, {
      name: '星形左',
      src: G.SampleAssets.spark,
      imgW: 160,
      imgH: 160,
      w: 104,
      h: 104,
    });
    sparkL.x = 392; sparkL.y = 500;
    sparkL.keys.scale = [
      kf('scale', 0.7, { sx: 0, sy: 0 }, 'easeOutBack'),
      kf('scale', 1.35, { sx: 100, sy: 100 }),
    ];
    sparkL.keys.rotation = [
      kf('rotation', 0.7, { v: -90 }, 'easeOutCubic'),
      kf('rotation', 1.35, { v: 12 }),
    ];

    const sparkR = M.createImageLayer(p, {
      name: '星形右',
      src: G.SampleAssets.spark,
      imgW: 160,
      imgH: 160,
      w: 78,
      h: 78,
    });
    sparkR.x = 1528; sparkR.y = 470;
    sparkR.keys.scale = [
      kf('scale', 0.9, { sx: 0, sy: 0 }, 'easeOutBack'),
      kf('scale', 1.5, { sx: 100, sy: 100 }),
    ];
    sparkR.keys.rotation = [
      kf('rotation', 0.9, { v: 90 }, 'easeOutCubic'),
      kf('rotation', 1.5, { v: -10 }),
    ];

    /* ---------- 形状转场条（编组） ---------- */
    function bar(name, color, coverX, t0, t1, t2) {
      const b = M.createRectLayer(p, { name, w: 720, h: 1200, radius: 0, fill: color });
      b.y = 540;
      b.shadow = { enabled: false };
      b.keys.position = [
        kf('position', t0, { x: 2320, y: 540 }, 'easeOutCubic'),
        kf('position', t1, { x: coverX, y: 540 }, 'easeInCubic'),
        kf('position', t2, { x: -430, y: 540 }),
      ];
      return b;
    }
    const bar1 = bar('转场条 · 靛', '#5b7cfa', 300, 1.5, 2.0, 2.55);
    const bar2 = bar('转场条 · 青', '#22c7dd', 960, 1.62, 2.12, 2.67);
    const bar3 = bar('转场条 · 金', '#ffb02e', 1620, 1.74, 2.24, 2.79);

    const barGroup = M.createGroup('形状转场组');
    barGroup.children = [bar3, bar2, bar1]; // 组内顶部为最上层

    /* 面板顺序：最上层在前 */
    p.children = [
      barGroup,
      sparkR,
      sparkL,
      tag,
      pill,
      accent,
      title,
      en,
      logo,
      glow,
    ];

    return p;
  }

  G.buildSampleProject = buildSampleProject;
})();
