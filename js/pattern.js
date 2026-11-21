/* 投影校正工具 —— 测试图生成
 *
 * 三种基础测试图（网格、文字、圆形）加一个组合图，全部程序化绘制到离屏 canvas，
 * 不依赖任何外部图片文件；也支持载入本地图片作为自定义素材。
 * 源素材统一画在规范正方形 (0..1)² 坐标系里，单应矩阵只负责这个规范面到幕面的映射。
 */
(function (global) {
  'use strict';

  var PCAL = global.PCAL;
  var SRC_SIZE = 1024; // 规范源面分辨率（正方形）

  var CORNER_NAMES = ['左上 TL', '右上 TR', '右下 BR', '左下 BL'];

  function drawGrid(ctx, W, H) {
    var nMinor = 40, nMajor = 8;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (var i = 1; i < nMinor; i++) {
      if (i % (nMinor / nMajor) === 0) continue;
      var p = i / nMinor * W;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    for (var m = 0; m <= nMajor; m++) {
      var q = m / nMajor * W;
      ctx.beginPath(); ctx.moveTo(q, 0); ctx.lineTo(q, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, q); ctx.lineTo(W, q); ctx.stroke();
    }
    // 中线加粗，便于找消失点
    ctx.strokeStyle = '#ffd54a';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.restore();
  }

  function drawCircles(ctx, W, H) {
    var cx = W / 2, cy = H / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,220,255,0.9)';
    ctx.lineWidth = 2.5;
    for (var r = 1; r <= 8; r++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r / 9 * W * 0.48, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 网格交点上的小圆，检查透视后各向变形
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    for (var gx = 1; gx <= 3; gx++) {
      for (var gy = 1; gy <= 3; gy++) {
        ctx.beginPath();
        ctx.arc(gx / 4 * W, gy / 4 * H, W * 0.03, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // 正圆轮廓参考线（贴边），变形后应为椭圆
    ctx.strokeStyle = '#ff8a5c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, W * 0.46, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function drawText(ctx, W, H) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var sizes = [112, 80, 56, 40, 28];
    sizes.forEach(function (size, idx) {
      ctx.font = '600 ' + size + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('投影校正 Projection ' + (idx + 1), W / 2, H * (0.16 + idx * 0.13));
    });
    // 角标：四角拖动后文字方向是否正确，看角标最直观
    ctx.font = '700 44px "PingFang SC","Microsoft YaHei",sans-serif';
    var anchors = [
      { x: 0.08, y: 0.06, t: CORNER_NAMES[0] },
      { x: 0.92, y: 0.06, t: CORNER_NAMES[1] },
      { x: 0.92, y: 0.94, t: CORNER_NAMES[2] },
      { x: 0.08, y: 0.94, t: CORNER_NAMES[3] }
    ];
    anchors.forEach(function (a) {
      ctx.fillStyle = '#ffd54a';
      ctx.fillText(a.t, a.x * W, a.y * H);
    });
    // 刻度尺：检查横向/纵向压缩比例
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.font = '24px monospace';
    for (var i = 0; i <= 20; i++) {
      var x = i / 20 * W;
      var len = i % 5 === 0 ? 28 : 14;
      ctx.beginPath(); ctx.moveTo(x, H - 40); ctx.lineTo(x, H - 40 - len); ctx.stroke();
      if (i % 5 === 0) ctx.fillText(String(i * 5), x, H - 18);
    }
    ctx.restore();
  }

  function drawFrame(ctx, W, H) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    // 四角 L 形定位标记
    ctx.strokeStyle = '#ff5c7a';
    ctx.lineWidth = 8;
    var L = W * 0.05;
    function corner(x, y, sx, sy) {
      ctx.beginPath();
      ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L);
      ctx.stroke();
    }
    corner(10, 10, 1, 1);
    corner(W - 10, 10, -1, 1);
    corner(W - 10, H - 10, -1, -1);
    corner(10, H - 10, 1, -1);
    ctx.restore();
  }

  /** 在给定画布上绘制测试图（type: grid|circles|text|combo|custom）。 */
  function renderSource(ctx, W, H, type, customImage) {
    // 中灰底：重叠区加亮时整面都能看出差异，而不只是白色线条
    ctx.fillStyle = '#2a2f36';
    ctx.fillRect(0, 0, W, H);

    if (type === 'custom' && customImage) {
      // contain 方式装入规范正方形，空余区域留黑条
      var img = customImage;
      var scale = Math.min(W / img.width, H / img.height);
      var dw = img.width * scale, dh = img.height * scale;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      drawFrame(ctx, W, H);
      return;
    }

    if (type === 'grid' || type === 'combo') drawGrid(ctx, W, H);
    if (type === 'circles' || type === 'combo') drawCircles(ctx, W, H);
    if (type === 'text' || type === 'combo') drawText(ctx, W, H);
    drawFrame(ctx, W, H);
  }

  PCAL.pattern = {
    SRC_SIZE: SRC_SIZE,
    CORNER_NAMES: CORNER_NAMES,
    renderSource: renderSource
  };
})(window);
