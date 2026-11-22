/*
 * 内置示例图片（程序化生成，不携带任何外部资源）：
 *  - title-ui      带界面文字的标题图（不透明）
 *  - bg-gradient   渐变背景（不透明，体积大，典型的优先压缩对象）
 *  - icon-gem      透明底小图标（必须保留透明）
 *  - panel-dialog  半透明对话框（带界面文字与透明通道）
 * 这些画布与用户导入的图片走完全相同的候选编码管线。
 */
(function (global) {
  'use strict';

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function makeTitleUI() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 220;
    const ctx = c.getContext('2d');

    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#1b2a4a');
    g.addColorStop(1, '#2c1b4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);

    // 装饰星点
    for (let i = 0; i < 60; i++) {
      const x = (i * 97) % c.width;
      const y = (i * 53) % c.height;
      ctx.fillStyle = 'rgba(255,255,255,' + (0.15 + (i % 5) * 0.12) + ')';
      ctx.fillRect(x, y, 2, 2);
    }

    ctx.textAlign = 'center';
    ctx.font = 'bold 72px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.shadowColor = 'rgba(79,140,255,.9)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#eef4ff';
    ctx.fillText('星海远征', c.width / 2, 110);

    ctx.shadowBlur = 0;
    ctx.font = '26px "PingFang SC", sans-serif';
    ctx.fillStyle = '#9db8ff';
    ctx.fillText('STAR VOYAGE · 版本 2.4', c.width / 2, 156);

    // 开始按钮
    roundRect(ctx, c.width / 2 - 110, 172, 220, 38, 19);
    const bg2 = ctx.createLinearGradient(c.width / 2 - 110, 172, c.width / 2 + 110, 210);
    bg2.addColorStop(0, '#4f8cff');
    bg2.addColorStop(1, '#8a5cff');
    ctx.fillStyle = bg2;
    ctx.fill();
    ctx.font = 'bold 18px "PingFang SC", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText('开始游戏', c.width / 2, 197);
    return c;
  }

  function makeGradientBg() {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const ctx = c.getContext('2d');

    const base = ctx.createLinearGradient(0, 0, 0, c.height);
    base.addColorStop(0, '#0b1030');
    base.addColorStop(0.55, '#1a1f4d');
    base.addColorStop(1, '#3a1d52');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, c.width, c.height);

    // 星云团
    const blobs = [
      [300, 220, 320, 'rgba(90,120,255,.35)'],
      [950, 480, 380, 'rgba(170,90,255,.30)'],
      [760, 180, 220, 'rgba(80,220,220,.22)']
    ];
    blobs.forEach(([x, y, r, color]) => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, c.width, c.height);
    });

    // 星空（确定性伪随机，保证每次生成一致）
    let seed = 42;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 420; i++) {
      const x = rand() * c.width;
      const y = rand() * c.height;
      const r = rand() * 1.6 + 0.3;
      ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + rand() * 0.7) + ')';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 远景行星
    const px = 1020, py = 160, pr = 64;
    const pg = ctx.createRadialGradient(px - 20, py - 24, 6, px, py, pr);
    pg.addColorStop(0, '#ffd9a0');
    pg.addColorStop(0.6, '#c97b4a');
    pg.addColorStop(1, '#5a2c3e');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  function makeGemIcon() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);

    // 柔光晕（半透明像素）
    const glow = ctx.createRadialGradient(64, 66, 4, 64, 66, 58);
    glow.addColorStop(0, 'rgba(110,200,255,.55)');
    glow.addColorStop(1, 'rgba(110,200,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 128, 128);

    // 宝石主体（六边形切面）
    const pts = [[64, 22], [100, 48], [88, 102], [40, 102], [28, 48]];
    const gemGrad = ctx.createLinearGradient(28, 22, 100, 102);
    gemGrad.addColorStop(0, 'rgba(180,240,255,.98)');
    gemGrad.addColorStop(0.5, 'rgba(70,160,255,.95)');
    gemGrad.addColorStop(1, 'rgba(40,80,220,.95)');
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.fillStyle = gemGrad;
    ctx.fill();

    // 切面线与高光
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(28, 48); ctx.lineTo(100, 48);
    ctx.moveTo(64, 22); ctx.lineTo(64, 102);
    ctx.moveTo(40, 102); ctx.lineTo(64, 48); ctx.lineTo(88, 102);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath();
    ctx.ellipse(52, 40, 10, 5, -0.5, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  function makeDialogPanel() {
    const c = document.createElement('canvas');
    c.width = 560; c.height = 300;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    roundRect(ctx, 10, 10, c.width - 20, c.height - 20, 18);
    ctx.fillStyle = 'rgba(18,24,40,.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,160,255,.7)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = 'bold 26px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(238,244,255,.96)';
    ctx.fillText('系统提示', 40, 58);

    ctx.font = '18px "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(200,214,240,.92)';
    const lines = [
      '检测到本次更新包空间不足，',
      '部分图片将按优先级压缩。',
      '你可以在候选表中锁定任意方案。'
    ];
    lines.forEach((t, i) => ctx.fillText(t, 40, 104 + i * 34));

    roundRect(ctx, c.width - 170, c.height - 66, 120, 38, 19);
    ctx.fillStyle = 'rgba(79,140,255,.95)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = 'bold 17px "PingFang SC", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText('确认', c.width - 110, c.height - 41);
    return c;
  }

  const DEFS = [
    {
      name: 'title-ui.png',
      priority: 'high', keepAlpha: false,
      minRatio: 0.5,
      build: makeTitleUI
    },
    {
      name: 'bg-gradient.png',
      priority: 'low', keepAlpha: false,
      minRatio: 0.25,
      build: makeGradientBg
    },
    {
      name: 'icon-gem.png',
      priority: 'mid', keepAlpha: true,
      minRatio: 1,
      build: makeGemIcon
    },
    {
      name: 'panel-dialog.png',
      priority: 'high', keepAlpha: true,
      minRatio: 0.5,
      build: makeDialogPanel
    }
  ];

  function buildSampleItems() {
    return DEFS.map((def) => {
      const sourceCanvas = def.build();
      return {
        id: Util.uid('img'),
        name: def.name,
        sourceCanvas,
        width: sourceCanvas.width,
        height: sourceCanvas.height,
        hasAlpha: ImgEncoding.canvasHasAlpha(sourceCanvas),
        priority: def.priority,
        keepAlpha: def.keepAlpha,
        minW: Math.max(1, Math.round(sourceCanvas.width * def.minRatio)),
        minH: Math.max(1, Math.round(sourceCanvas.height * def.minRatio)),
        sample: true,
        candidates: [],
        lockedPickId: null,
        encoding: false
      };
    });
  }

  global.Samples = { buildSampleItems, DEFS };
})(window);
