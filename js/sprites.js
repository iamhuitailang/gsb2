/*
 * 程序化角色帧生成：不依赖外部图片，直接在 canvas 上画一个可辨识的 2D 人形。
 * 刻意加入了大量“角度校验线索”：
 *  - 头顶朝向箭头（随方向旋转）
 *  - 左上角方向字母、右上角帧序号
 *  - 左手戴红色 L 手套（不对称标记），镜像补齐后手套会跑到右边且字母翻转
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sprites = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 160;
  const H = 180;
  const GROUND_Y = 152;

  function facing(angle) {
    const rad = (angle * Math.PI) / 180;
    return { x: Math.sin(rad), y: Math.cos(rad) }; // y>0 朝南（朝向镜头）
  }

  function limb(ctx, x1, y1, x2, y2, cx, cy, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (cx === undefined) ctx.lineTo(x2, y2);
    else {
      ctx.quadraticCurveTo(cx, cy, x2, y2);
    }
    ctx.stroke();
  }

  function drawFrame(canvas, spec) {
    const ctx = canvas.getContext('2d');
    const a = spec.angle;
    const f = facing(a);
    const fx = f.x;
    const isBack = Math.abs(f.y + 1) < 0.01;      // 朝北=背对镜头
    const isFront = Math.abs(f.y - 1) < 0.01;     // 朝南=正对镜头
    const isSide = Math.abs(Math.abs(fx) - 1) < 0.01;
    const widthScale = isSide ? 0.62 : Math.abs(fx) > 0.5 ? 0.82 : 1;
    const pal = spec.palette;

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, 0);
    ctx.scale(widthScale, 1);
    ctx.translate(-W / 2, 0);

    const phase = spec.phase || 0;
    const walking = spec.actionId === 'walk';
    const swing = walking ? Math.sin(phase * Math.PI * 2) * 11 : 0;
    const bob = walking
      ? Math.abs(Math.sin(phase * Math.PI * 2)) * 2.2
      : Math.sin(phase * Math.PI * 2) * 2; // idle 呼吸起伏

    const hipY = 108 + bob;
    const shoulderY = 72 + bob;
    const headY = 53 + bob;

    // 腿
    const bend = Math.abs(swing) * 0.5;
    limb(ctx, 76, hipY, 76 + swing, GROUND_Y, 76 + swing * 0.5, hipY + 18 - bend, 7, pal.pants);
    limb(ctx, 84, hipY, 84 - swing, GROUND_Y, 84 - swing * 0.5, hipY + 18 - bend, 7, pal.pants);
    // 鞋
    ctx.fillStyle = pal.shoe;
    ctx.beginPath(); ctx.ellipse(76 + swing + fx * 3, GROUND_Y, 6, 3.5, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(84 - swing + fx * 3, GROUND_Y, 6, 3.5, 0, 0, 7); ctx.fill();

    // 躯干
    ctx.fillStyle = isBack ? pal.bodyBack : pal.body;
    ctx.beginPath();
    ctx.roundRect(70, shoulderY - 2, 20, hipY - shoulderY + 8, 7);
    ctx.fill();

    // 手臂（与腿反向摆动），左手红手套
    const armSwing = -swing;
    const lElbow = { x: 72 + armSwing * 0.6, y: shoulderY + 16 };
    const lHand = { x: 70 + armSwing, y: shoulderY + 32 + (walking ? 0 : Math.sin(phase * Math.PI * 2) * 1.5) };
    const rElbow = { x: 88 - armSwing * 0.6, y: shoulderY + 16 };
    const rHand = { x: 90 - armSwing, y: shoulderY + 32 };
    limb(ctx, 74, shoulderY + 2, lElbow.x, lElbow.y, undefined, undefined, 6, pal.body);
    limb(ctx, lElbow.x, lElbow.y, lHand.x, lHand.y, undefined, undefined, 5, pal.body);
    limb(ctx, 86, shoulderY + 2, rElbow.x, rElbow.y, undefined, undefined, 6, pal.body);
    limb(ctx, rElbow.x, rElbow.y, rHand.x, rHand.y, undefined, undefined, 5, pal.body);
    ctx.fillStyle = pal.skin;
    ctx.beginPath(); ctx.arc(rHand.x, rHand.y, 3.4, 0, 7); ctx.fill();
    ctx.fillStyle = pal.glove;
    ctx.beginPath(); ctx.arc(lHand.x, lHand.y, 4.2, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('L', lHand.x, lHand.y + 0.5);

    // 头
    ctx.fillStyle = isBack ? pal.hood : pal.skin;
    ctx.beginPath();
    ctx.arc(80 + fx * 2, headY, 12.5, 0, 7);
    ctx.fill();

    if (isBack) {
      // 背对镜头：看不到脸，画兜帽缝
      ctx.strokeStyle = pal.bodyBack;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(80, headY + 1, 8, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else {
      // 眼睛随朝向偏移；侧面只画一只
      const ex = fx * 3;
      const ey = -f.y * 1.5;
      ctx.fillStyle = '#1f2937';
      if (isSide) {
        ctx.beginPath(); ctx.arc(80 + fx * 5, headY + ey, 1.8, 0, 7); ctx.fill();
        ctx.strokeStyle = '#b98a63';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(80 + fx * 10, headY + 2);
        ctx.lineTo(80 + fx * 14, headY + 4);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(75 + ex, headY + ey, 1.8, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(85 + ex, headY + ey, 1.8, 0, 7); ctx.fill();
      }
    }
    ctx.restore();

    // 头顶朝向箭头（不做宽度压缩，保证角度直观）
    const ax = W / 2;
    const ay = 22;
    ctx.strokeStyle = pal.arrow;
    ctx.fillStyle = pal.arrow;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + fx * 15, ay - f.y * 15);
    ctx.stroke();
    const tipX = ax + fx * 15;
    const tipY = ay - f.y * 15;
    const base = Math.atan2(-f.y, fx);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 7 * Math.cos(base - 0.45), tipY - 7 * Math.sin(base - 0.45));
    ctx.lineTo(tipX - 7 * Math.cos(base + 0.45), tipY - 7 * Math.sin(base + 0.45));
    ctx.closePath();
    ctx.fill();

    // 角标：方向字母 + 帧序号
    if (spec.showBadges !== false) {
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(17,24,39,.78)';
      roundTag(ctx, 4, 4, 26, 18, spec.label || '?');
      ctx.textAlign = 'right';
      roundTag(ctx, W - 40, 4, 36, 18, spec.badgeText || '');
    }
  }

  function roundTag(ctx, x, y, w, h, text) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + w - 5, y + 2.5);
    ctx.fillStyle = 'rgba(17,24,39,.78)';
  }

  /** 离屏缓存一张帧图 */
  function toCanvas(spec, scale = 1) {
    const c = document.createElement('canvas');
    c.width = W * scale;
    c.height = H * scale;
    c.getContext('2d').scale(scale, scale);
    drawFrame(c, spec);
    return c;
  }

  return { W, H, GROUND_Y, drawFrame, toCanvas, facing };
});
