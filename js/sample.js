/*
 * sample.js — 内置几何样片
 *
 * 左右各 100 帧（640x360 @25fps，4 秒），同一场景：
 *  旋转三角（强时间提示）、匀速移动方块、帧号大字、标尺、安全框、角标
 * 右眼三路“故障”：
 *  1. 晚 4 帧：右眼文件第 f 帧装的是场景第 f-4 帧的内容（开头保持首帧）
 *  2. 偏高 16px：整幅画面向上平移 16px，底部留黑
 *  3. 上下裁切：顶部多裁 10%、底部多裁 6%，再缩放回原尺寸（不可逆，模拟一边裁太多）
 *
 * 正确校回参数（界面里“一键校回（仅样片）”按钮会填这组值）：
 *  右眼 timeOffset = -4/25 = -0.16s（把晚到的内容在时间线上往前拉 4 帧）
 *  右眼 verticalOffset = +16px（把偏高的画面向下移回）
 */
(function (global) {
  'use strict';

  var W = 640, H = 360, FPS = 25, N = 100;
  var RIGHT_DELAY = 4;       // 右眼晚到的帧数
  var RIGHT_UP = 16;         // 右眼向上平移的像素
  var CROP_TOP = Math.round(H * 0.10); // 36
  var CROP_BOTTOM = Math.round(H * 0.06); // 22

  var SAMPLE_DEFS = {
    left: {
      sig: 'sample:left:v1',
      name: '内置样片 · 左眼（基准）',
      accent: '#46d17a'
    },
    right: {
      sig: 'sample:right:v1',
      name: '内置样片 · 右眼（晚4帧 / 偏高16px / 上下裁切）',
      accent: '#ff9f43'
    }
  };

  function createSceneCanvas() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }

  function drawScene(ctx, sceneFrame, eye) {
    var def = SAMPLE_DEFS[eye];
    var accent = def.accent;

    // 背景渐变
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1020');
    bg.addColorStop(1, '#16233f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 标尺：左侧竖尺 + 顶部横尺，每 40px 一格，每 80px 标数字
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    for (var y = 0; y <= H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(y % 80 === 0 ? 14 : 8, y + 0.5); ctx.stroke();
      if (y % 80 === 0) ctx.fillText(String(y), 16, y + 3);
    }
    for (var x = 0; x <= W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, x % 80 === 0 ? 14 : 8); ctx.stroke();
      if (x % 80 === 0 && x > 0) { ctx.fillText(String(x), x + 2, 12); }
    }

    // 中心十字参考线
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    // 地平线 + 刻度
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(0, 260.5); ctx.lineTo(W, 260.5); ctx.stroke();
    for (var tx = 20; tx < W; tx += 20) {
      ctx.beginPath(); ctx.moveTo(tx, 256); ctx.lineTo(tx, 265); ctx.stroke();
    }

    // 旋转三角（中心 320,180），角速度 4°/帧，尖端小圆点
    var cx = 320, cy = 180, R = 90;
    var ang = sceneFrame * 4 * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (var k = 0; k < 3; k++) {
      var a = -Math.PI / 2 + k * 2 * Math.PI / 3;
      var px = Math.cos(a) * R, py = Math.sin(a) * R;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(Math.cos(-Math.PI / 2) * R, Math.sin(-Math.PI / 2) * R, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

    // 匀速移动方块：左 -> 右
    var sq = 40;
    var sx = 40 + (W - 120) * sceneFrame / (N - 1);
    ctx.fillStyle = accent;
    ctx.fillRect(sx, 240, sq, sq);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(sx + 0.5, 240.5, sq, sq);

    // 安全框 90%
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
    ctx.setLineDash([]);

    // 四角 L 形标记
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    var m = 16, len = 18;
    var corners = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]];
    for (var ci = 0; ci < corners.length; ci++) {
      var c0 = corners[ci];
      ctx.beginPath();
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c0[0] + len * c0[2], c0[1]);
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c0[0], c0[1] + len * c0[3]);
      ctx.stroke();
    }

    // 帧号
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('F ' + String(sceneFrame).padStart(3, '0'), 28, 44);

    // 眼别徽章
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = accent;
    ctx.fillText(eye === 'left' ? 'L' : 'R', W - 24, 36);
  }

  function SampleSource(eye) {
    this.eye = eye;
    this.kind = 'sample';
    this.def = SAMPLE_DEFS[eye];
    this.sig = this.def.sig;
    this.name = this.def.name;
    this.width = W;
    this.height = H;
    this.fps = FPS;
    this.frameCount = N;
    this.duration = N / FPS;
    this.ready = true;
    this.error = null;
    this._scene = createSceneCanvas();
    this._work = createSceneCanvas();
  }

  SampleSource.prototype.destroy = function () {
    this._scene = null;
    this._work = null;
  };

  /**
   * 把第 frame 帧绘制到 ctx 中 (0,0,targetW,targetH) 的矩形内。
   * 约定：素材坐标按宽高等比映射到该矩形（样片本身与目标盒同宽高比）。
   */
  SampleSource.prototype.drawFrame = function (ctx, targetW, targetH, frame) {
    frame = StereoCore.clamp(frame, 0, this.frameCount - 1);
    var sceneFrame = this.eye === 'right' ? Math.max(0, frame - RIGHT_DELAY) : frame;
    drawScene(this._scene.getContext('2d'), sceneFrame, this.eye);

    ctx.imageSmoothingEnabled = true;
    if (this.eye === 'left') {
      ctx.drawImage(this._scene, 0, 0, targetW, targetH);
      return;
    }

    // 右眼：先上下裁切再缩放回原尺寸（不可逆，模拟一边裁太多）
    var wctx = this._work.getContext('2d');
    wctx.clearRect(0, 0, W, H);
    wctx.drawImage(
      this._scene,
      0, CROP_TOP, W, H - CROP_TOP - CROP_BOTTOM,
      0, 0, W, H
    );
    // 再整体上移 RIGHT_UP（按目标盒等比缩放），底部留黑
    var shiftY = -RIGHT_UP * (targetH / H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(this._work, 0, shiftY, targetW, targetH);
  };

  var api = {
    W: W, H: H, FPS: FPS, N: N,
    RIGHT_DELAY: RIGHT_DELAY,
    RIGHT_UP: RIGHT_UP,
    CROP_TOP: CROP_TOP,
    CROP_BOTTOM: CROP_BOTTOM,
    defs: SAMPLE_DEFS,
    create: function (eye) { return new SampleSource(eye); },
    /** 样片的正确校回参数（供“一键校回”按钮使用，真实素材无此信息） */
    correction: {
      left: { timeOffset: 0, verticalOffset: 0 },
      right: { timeOffset: -RIGHT_DELAY / FPS, verticalOffset: RIGHT_UP }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.StereoSamples = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
