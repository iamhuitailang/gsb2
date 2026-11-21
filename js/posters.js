/*
 * posters.js — 两张程序生成的试验海报（Canvas 2D，无外部素材）
 *
 * posterA「星穹远征」1600×2000：标题与角色距离适中，
 *   横幅 / 方图 / 竖图三种尺寸都能完整保留两个必须区 —— 用于演示理想路径。
 * posterB「机甲纪元」1600×2000：标题在左上、角色在右下，横向相隔很远，
 *   横幅与竖图无法同时完整保留两个必须区 —— 用于演示冲突报告与改策略
 *   （换带留白、或舍弃其中一个必须区）。
 *
 * regions 为归一化坐标，直接作为项目关注区预设。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SCPosters = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 1600;
  const H = 2000;

  // 可复现的伪随机，保证每次生成的星空一致
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawStars(ctx, rand, count, maxR) {
    for (let i = 0; i < count; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = 0.5 + rand() * maxR;
      const a = 0.25 + rand() * 0.75;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 海报 A 的角色：头在画面上部（约 0.235H），与标题纵向靠近，
  // 保证 2.4:1 横幅（裁切高度仅原图 33%）也能同时完整保留标题与脸。
  function drawCharacterA(ctx) {
    const cx = W * 0.5;
    const headY = 470;
    // 身体（宇航服剪影）
    ctx.fillStyle = '#dfe6f2';
    ctx.beginPath();
    ctx.moveTo(cx - 135, 1180);
    ctx.bezierCurveTo(cx - 150, 900, cx - 135, 760, cx - 85, 700);
    ctx.lineTo(cx + 85, 700);
    ctx.bezierCurveTo(cx + 135, 760, cx + 150, 900, cx + 135, 1180);
    ctx.closePath();
    ctx.fill();
    // 胸前装甲高光
    ctx.fillStyle = '#9fb4d4';
    roundRectPath(ctx, cx - 72, 780, 144, 200, 22);
    ctx.fill();
    ctx.fillStyle = '#57d6ff';
    roundRectPath(ctx, cx - 30, 838, 60, 36, 8);
    ctx.fill();
    // 头盔
    ctx.fillStyle = '#eef3fb';
    ctx.beginPath();
    ctx.arc(cx, headY, 105, 0, Math.PI * 2);
    ctx.fill();
    // 面罩 —— 角色脸必须保留的核心
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, headY + 4, 82, 0, Math.PI * 2);
    ctx.clip();
    const fg = ctx.createLinearGradient(0, headY - 80, 0, headY + 90);
    fg.addColorStop(0, '#0b2a52');
    fg.addColorStop(1, '#123f73');
    ctx.fillStyle = fg;
    ctx.fillRect(cx - 82, headY - 82, 164, 168);
    ctx.strokeStyle = 'rgba(87,214,255,0.9)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx - 54, headY - 8);
    ctx.lineTo(cx - 16, headY - 8);
    ctx.moveTo(cx + 16, headY - 8);
    ctx.lineTo(cx + 54, headY - 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(87,214,255,0.35)';
    ctx.fillRect(cx - 82, headY - 60, 164, 16);
    ctx.restore();
    ctx.strokeStyle = '#7f97ba';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, headY, 105, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawPosterA() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const rand = mulberry32(20260722);

    // 深空背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1230');
    bg.addColorStop(0.55, '#10234f');
    bg.addColorStop(1, '#0b1736');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    drawStars(ctx, rand, 260, 2.4);

    // 星云
    const neb = ctx.createRadialGradient(W * 0.78, H * 0.32, 40, W * 0.78, H * 0.32, 620);
    neb.addColorStop(0, 'rgba(120,90,255,0.45)');
    neb.addColorStop(1, 'rgba(120,90,255,0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, W, H);

    // 行星（右上）
    const px = W * 0.82;
    const py = H * 0.24;
    const pr = 150;
    const pg = ctx.createRadialGradient(px - 50, py - 60, 30, px, py, pr);
    pg.addColorStop(0, '#ffd9a8');
    pg.addColorStop(0.6, '#e08b4e');
    pg.addColorStop(1, '#7a3c26');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,180,0.55)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.ellipse(px, py, pr * 1.55, pr * 0.42, -0.25, 0, Math.PI * 2);
    ctx.stroke();

    // 底部地面光
    const floor = ctx.createLinearGradient(0, H * 0.82, 0, H);
    floor.addColorStop(0, 'rgba(60,120,220,0)');
    floor.addColorStop(1, 'rgba(60,120,220,0.35)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, H * 0.8, W, H * 0.2);

    drawCharacterA(ctx);

    // 标题（顶部居中，紧贴角色上方，保证横向裁切时与脸同框）
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 132px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.shadowColor = 'rgba(87,214,255,0.8)';
    ctx.shadowBlur = 30;
    ctx.fillText('星穹远征', W / 2, H * 0.105);
    ctx.shadowBlur = 0;
    ctx.font = '40px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#9fd8ff';
    ctx.fillText('跨 星 海 · 赴 未 知', W / 2, H * 0.145);

    // 行动按钮
    roundRectPath(ctx, W * 0.31, H * 0.86, W * 0.38, 96, 48);
    const btn = ctx.createLinearGradient(W * 0.31, 0, W * 0.69, 0);
    btn.addColorStop(0, '#36c4ff');
    btn.addColorStop(1, '#6d7bff');
    ctx.fillStyle = btn;
    ctx.fill();
    ctx.fillStyle = '#06122b';
    ctx.font = 'bold 44px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('立即预约', W / 2, H * 0.86 + 62);

    return canvas;
  }

  function drawMechB(ctx) {
    const cx = W * 0.72;
    // 长腿机甲
    ctx.fillStyle = '#3a3f4c';
    roundRectPath(ctx, cx - 70, 1480, 60, 320, 14);
    ctx.fill();
    roundRectPath(ctx, cx + 10, 1480, 60, 320, 14);
    ctx.fill();
    // 躯干
    const body = ctx.createLinearGradient(cx - 180, 1100, cx + 180, 1500);
    body.addColorStop(0, '#5b6272');
    body.addColorStop(0.5, '#8b93a6');
    body.addColorStop(1, '#4a505e');
    ctx.fillStyle = body;
    roundRectPath(ctx, cx - 170, 1150, 340, 380, 30);
    ctx.fill();
    // 反应堆核心
    const core = ctx.createRadialGradient(cx, 1330, 8, cx, 1330, 70);
    core.addColorStop(0, '#fff3d0');
    core.addColorStop(0.4, '#ff9d3c');
    core.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, 1330, 70, 0, Math.PI * 2);
    ctx.fill();
    // 肩甲与手臂
    ctx.fillStyle = '#6d7485';
    roundRectPath(ctx, cx - 250, 1150, 110, 200, 20);
    ctx.fill();
    roundRectPath(ctx, cx + 140, 1150, 110, 200, 20);
    ctx.fill();
    ctx.fillStyle = '#3a3f4c';
    roundRectPath(ctx, cx - 235, 1350, 80, 260, 16);
    ctx.fill();
    roundRectPath(ctx, cx + 155, 1350, 80, 260, 16);
    ctx.fill();
    // 头部（驾驶舱 = 角色脸）
    ctx.fillStyle = '#9099ad';
    roundRectPath(ctx, cx - 95, 950, 190, 170, 28);
    ctx.fill();
    ctx.save();
    roundRectPath(ctx, cx - 70, 985, 140, 95, 16);
    ctx.clip();
    const visor = ctx.createLinearGradient(0, 985, 0, 1080);
    visor.addColorStop(0, '#ff5d2e');
    visor.addColorStop(1, '#7a1503');
    ctx.fillStyle = visor;
    ctx.fillRect(cx - 70, 985, 140, 95);
    ctx.fillStyle = 'rgba(255,220,180,0.85)';
    ctx.fillRect(cx - 55, 1020, 46, 12);
    ctx.fillRect(cx + 9, 1020, 46, 12);
    ctx.restore();
    ctx.strokeStyle = '#ff7a3c';
    ctx.lineWidth = 4;
    roundRectPath(ctx, cx - 70, 985, 140, 95, 16);
    ctx.stroke();
    // 天线
    ctx.strokeStyle = '#b8c0d0';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(cx + 60, 950);
    ctx.lineTo(cx + 90, 870);
    ctx.stroke();
  }

  function drawPosterB() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const rand = mulberry32(9917);

    // 暗红工业风背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c0d10');
    bg.addColorStop(0.5, '#2a1213');
    bg.addColorStop(1, '#120809');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 网格地平线 + 城市剪影
    ctx.strokeStyle = 'rgba(255,90,60,0.18)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 16; i++) {
      const x = (W / 16) * i;
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(W / 2 + (x - W / 2) * 0.25, H * 0.62);
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const y = H * 0.62 + ((H * 0.38) / 8) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#0d0607';
    for (let i = 0; i < 14; i++) {
      const bw = 70 + rand() * 120;
      const bh = 180 + rand() * 420;
      const bx = rand() * W;
      ctx.fillRect(bx, H * 0.62 - bh, bw, bh + 20);
    }

    // 火星光晕（右下，机甲后方）
    const glow = ctx.createRadialGradient(W * 0.72, H * 0.55, 60, W * 0.72, H * 0.55, 700);
    glow.addColorStop(0, 'rgba(255,110,40,0.4)');
    glow.addColorStop(1, 'rgba(255,110,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // 左侧装饰光效（尽量保留区，允许被裁）
    ctx.save();
    ctx.translate(W * 0.12, H * 0.52);
    ctx.rotate(-0.35);
    const beam = ctx.createLinearGradient(-60, 0, 60, 0);
    beam.addColorStop(0, 'rgba(255,90,60,0)');
    beam.addColorStop(0.5, 'rgba(255,120,70,0.55)');
    beam.addColorStop(1, 'rgba(255,90,60,0)');
    ctx.fillStyle = beam;
    ctx.fillRect(-60, -520, 120, 1040);
    ctx.restore();

    drawMechB(ctx);

    // 标题（左上，离右下机甲很远）
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffe9dd';
    ctx.font = 'bold 138px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.shadowColor = 'rgba(255,90,50,0.85)';
    ctx.shadowBlur = 26;
    ctx.fillText('机甲纪元', W * 0.06, H * 0.12);
    ctx.shadowBlur = 0;
    ctx.font = '40px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#ff9d7a';
    ctx.fillText('钢 铁 重 启 · 反 叛 序 章', W * 0.065, H * 0.165);

    // 左下小标（尽量保留区）
    ctx.font = '36px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(255,210,190,0.85)';
    ctx.fillText('2026 跨平台重磅新作', W * 0.07, H * 0.86);

    // 右下 CTA
    roundRectPath(ctx, W * 0.55, H * 0.9, W * 0.36, 92, 46);
    const btn = ctx.createLinearGradient(W * 0.55, 0, W * 0.91, 0);
    btn.addColorStop(0, '#ff6a3c');
    btn.addColorStop(1, '#c22e1e');
    ctx.fillStyle = btn;
    ctx.fill();
    ctx.fillStyle = '#fff2ec';
    ctx.font = 'bold 42px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('立即开战', W * 0.73, H * 0.9 + 59);

    return canvas;
  }

  // 关注区预设（归一化坐标，绑定原图）
  const specs = [
    {
      id: 'posterA',
      name: '海报 A · 星穹远征（可全保留）',
      width: W,
      height: H,
      draw: drawPosterA,
      regions: [
        { id: 'a-title', label: '标题「星穹远征」', priority: 'required', x: 0.15, y: 0.025, w: 0.7, h: 0.12 },
        { id: 'a-face', label: '角色面罩（脸）', priority: 'required', x: 0.435, y: 0.185, w: 0.13, h: 0.095 },
        { id: 'a-body', label: '角色全身', priority: 'preferred', x: 0.39, y: 0.18, w: 0.22, h: 0.41 },
        { id: 'a-cta', label: '预约按钮', priority: 'preferred', x: 0.3, y: 0.85, w: 0.4, h: 0.07 },
      ],
    },
    {
      id: 'posterB',
      name: '海报 B · 机甲纪元（标题/角色过远，需改策略）',
      width: W,
      height: H,
      draw: drawPosterB,
      regions: [
        { id: 'b-title', label: '标题「机甲纪元」', priority: 'required', x: 0.05, y: 0.04, w: 0.42, h: 0.13 },
        { id: 'b-face', label: '驾驶舱（角色脸）', priority: 'required', x: 0.64, y: 0.49, w: 0.18, h: 0.1 },
        { id: 'b-mech', label: '机甲全身', priority: 'preferred', x: 0.55, y: 0.43, w: 0.34, h: 0.47 },
        { id: 'b-tag', label: '左侧光效与小标', priority: 'preferred', x: 0.04, y: 0.42, w: 0.17, h: 0.46 },
      ],
    },
  ];

  return { W, H, specs, mulberry32 };
});
