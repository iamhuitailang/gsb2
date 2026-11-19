/*
 * samples.js — 内置示例素材（Canvas 程序化生成，完全离线）
 *
 * 覆盖：不同长宽比（横幅/竖条/方形/小颗粒）、不同透明边距、
 * 不同子目录下的同名文件（hero.png / gem.png 各出现两次）、
 * 以及一张几乎全透明的极端裁剪样例。
 *
 * tools/generate_samples.py 会用 Pillow 生成等价的 PNG 文件到
 * public/samples/，两边内容定位一致，方便用文件导入方式复现。
 */
(function (root) {
  'use strict';

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function diamond(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - ry);
    ctx.lineTo(cx + rx, cy);
    ctx.lineTo(cx, cy + ry);
    ctx.lineTo(cx - rx, cy);
    ctx.closePath();
  }

  // 每个 spec：name 含相对目录以制造重名；margin 为设计时预留的透明边距
  var SPECS = [
    {
      name: 'hero_wide.png',
      width: 240,
      height: 140,
      draw: function (ctx) {
        // 横向胶囊，四周约 18px 透明边距
        var g = ctx.createLinearGradient(20, 30, 220, 110);
        g.addColorStop(0, '#5b8cff');
        g.addColorStop(1, '#7a5bff');
        ctx.fillStyle = g;
        roundedRect(ctx, 22, 34, 196, 72, 36);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 4;
        ctx.stroke();
      },
    },
    {
      name: 'hero_tall.png',
      width: 96,
      height: 220,
      draw: function (ctx) {
        // 竖条药水瓶，顶部/底部留透明边距
        ctx.fillStyle = '#ff7a59';
        roundedRect(ctx, 26, 30, 44, 160, 18);
        ctx.fill();
        ctx.fillStyle = '#c94f33';
        roundedRect(ctx, 34, 12, 28, 26, 6);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        roundedRect(ctx, 34, 48, 10, 120, 5);
        ctx.fill();
      },
    },
    {
      name: 'gem.png',
      width: 128,
      height: 128,
      draw: function (ctx) {
        // 菱形宝石，大量透明边距（实际内容约 72x72）
        var g = ctx.createRadialGradient(60, 56, 6, 64, 64, 44);
        g.addColorStop(0, '#b8f5ff');
        g.addColorStop(1, '#18b6d6');
        ctx.fillStyle = g;
        diamond(ctx, 64, 64, 36, 40);
        ctx.fill();
        ctx.strokeStyle = '#0d6f86';
        ctx.lineWidth = 3;
        ctx.stroke();
      },
    },
    {
      name: 'particle.png',
      width: 64,
      height: 64,
      draw: function (ctx) {
        // 圆形粒子，软边
        var g = ctx.createRadialGradient(32, 32, 2, 32, 32, 22);
        g.addColorStop(0, 'rgba(255,236,150,1)');
        g.addColorStop(0.7, 'rgba(255,190,60,0.8)');
        g.addColorStop(1, 'rgba(255,190,60,0)');
        ctx.fillStyle = g;
        ctx.fillRect(8, 8, 48, 48);
      },
    },
    {
      name: 'title_banner.png',
      width: 360,
      height: 90,
      draw: function (ctx) {
        // 超宽横幅，上下透明边距较大
        ctx.fillStyle = '#3ddc97';
        roundedRect(ctx, 10, 26, 340, 38, 12);
        ctx.fill();
        ctx.fillStyle = '#123b2c';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('LEVEL  CLEAR', 180, 46);
      },
    },
    {
      name: 'icon_square.png',
      width: 96,
      height: 96,
      draw: function (ctx) {
        // 方形图标，仅 6px 透明边距
        ctx.fillStyle = '#ffd166';
        roundedRect(ctx, 6, 6, 84, 84, 14);
        ctx.fill();
        ctx.strokeStyle = '#8a5a00';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.fillStyle = '#8a5a00';
        ctx.font = 'bold 44px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', 48, 50);
      },
    },
    {
      name: 'chars/hero.png',
      width: 140,
      height: 160,
      draw: function (ctx) {
        // 同名文件之一：蓝色小人
        ctx.fillStyle = '#4d7cff';
        ctx.beginPath();
        ctx.arc(70, 48, 26, 0, Math.PI * 2);
        ctx.fill();
        roundedRect(ctx, 40, 78, 60, 66, 16);
        ctx.fill();
        ctx.fillStyle = '#1e3a8a';
        ctx.fillRect(48, 140, 16, 14);
        ctx.fillRect(76, 140, 16, 14);
      },
    },
    {
      name: 'items/hero.png',
      width: 160,
      height: 120,
      draw: function (ctx) {
        // 同名文件之二：绿色徽章（与 chars/hero.png 基础名相同）
        ctx.fillStyle = '#34d399';
        ctx.beginPath();
        ctx.arc(80, 56, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#065f46';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.fillStyle = '#065f46';
        ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('H', 80, 58);
      },
    },
    {
      name: 'items/gem.png',
      width: 128,
      height: 128,
      draw: function (ctx) {
        // 与根目录 gem.png 重名，颜色不同
        var g = ctx.createRadialGradient(60, 56, 6, 64, 64, 44);
        g.addColorStop(0, '#ffd6f5');
        g.addColorStop(1, '#e045b5');
        ctx.fillStyle = g;
        diamond(ctx, 64, 64, 36, 40);
        ctx.fill();
        ctx.strokeStyle = '#86146a';
        ctx.lineWidth = 3;
        ctx.stroke();
      },
    },
    {
      name: 'almost_blank.png',
      width: 80,
      height: 80,
      draw: function (ctx) {
        // 极端样例：80x80 画布中心只有 4x4 不透明像素
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(38, 38, 4, 4);
      },
    },
  ];

  function toCanvas(spec) {
    var c = makeCanvas(spec.width, spec.height);
    spec.draw(c.getContext('2d'));
    return c;
  }

  /** 生成 [{name, dataUrl, width, height}]，供应用走与文件导入相同的管线。 */
  function buildSampleDataUrls() {
    return SPECS.map(function (spec) {
      var c = toCanvas(spec);
      return {
        name: spec.name,
        dataUrl: c.toDataURL('image/png'),
        width: spec.width,
        height: spec.height,
      };
    });
  }

  root.SpriteSamples = {
    SPECS: SPECS,
    buildSampleDataUrls: buildSampleDataUrls,
    toCanvas: toCanvas,
  };
})(typeof self !== 'undefined' ? self : this);
