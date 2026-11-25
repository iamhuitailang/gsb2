/*
 * preview.js — 游戏预览
 *
 * 每个动画帧从 InputBus 的 held 集合出发，用当前情境的绑定解析出“生效操作”，
 * 再驱动三个迷你场景（菜单 / 步行 / 驾驶）。场景会自动跟随当前情境，
 * 也可以手动切换。操作状态条实时显示每个动作的按下/抬起，
 * 因此预览中看到的状态与配置表里的绑定始终一致。
 */
(function (global) {
  'use strict';

  function PreviewEngine(canvas, bus, getContext, actionBarEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bus = bus;
    this.getContext = getContext;       // () => 当前情境对象
    this.actionBarEl = actionBarEl;
    this.scene = null;                  // 'menu' | 'driving' | 'onFoot'
    this.autoScene = true;
    this.rafId = null;

    // 各场景的运行状态
    this.state = {
      menu: { index: 0, items: ['继续游戏', '设置', '手柄', '读取存档', '退出游戏'] },
      onFoot: { x: 380, y: 200, vx: 0, vy: 0, facing: 1, jumping: 0, crouch: false },
      driving: { x: 360, steer: 0, speed: 0, roadOffset: 0, horn: 0, cam: 0 }
    };
    this.lastActive = {};
    this._loop = this._loop.bind(this);
  }

  PreviewEngine.prototype.setScene = function (sceneId) {
    if (sceneId) { this.scene = sceneId; this.autoScene = false; }
    else { this.autoScene = true; } // 恢复自动跟随
  };

  PreviewEngine.prototype.start = function () {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this._loop);
  };

  PreviewEngine.prototype.stop = function () {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  };

  PreviewEngine.prototype._loop = function () {
    var ctxObj = this.getContext();
    if (this.autoScene || !this.scene) this.scene = ctxObj.id;
    var active = global.Bindings.resolveActiveActions(ctxObj, this.bus.held);

    this._update(active);
    this._render(ctxObj, active);
    this._renderActionBar(ctxObj, active);

    this.lastActive = active;
    this.rafId = requestAnimationFrame(this._loop);
  };

  PreviewEngine.prototype._active = function (active, id) {
    return !!active[id];
  };

  PreviewEngine.prototype._update = function (a) {
    var s;
    if (this.scene === 'menu') {
      s = this.state.menu;
      if (edge(this, a, 'menu.up')) s.index = (s.index + s.items.length - 1) % s.items.length;
      if (edge(this, a, 'menu.down')) s.index = (s.index + 1) % s.items.length;
    } else if (this.scene === 'onFoot') {
      s = this.state.onFoot;
      var sp = this._active(a, 'foot.sprint') ? 3.4 : 1.9;
      s.vx = ((this._active(a, 'foot.right') ? 1 : 0) - (this._active(a, 'foot.left') ? 1 : 0)) * sp;
      s.vy = ((this._active(a, 'foot.down') ? 1 : 0) - (this._active(a, 'foot.forward') ? 1 : 0)) * sp;
      s.x = clamp(s.x + s.vx, 24, this.canvas.width - 24);
      s.y = clamp(s.y + s.vy, 60, this.canvas.height - 26);
      if (s.vx !== 0) s.facing = s.vx > 0 ? 1 : -1;
      s.crouch = this._active(a, 'foot.crouch');
      if (edge(this, a, 'foot.jump') && s.jumping === 0) s.jumping = 1;
      if (s.jumping > 0) s.jumping += 0.09;
      if (s.jumping > 1.6) s.jumping = 0;
    } else if (this.scene === 'driving') {
      s = this.state.driving;
      var steerTarget = ((this._active(a, 'drive.steerRight') ? 1 : 0) -
                         (this._active(a, 'drive.steerLeft') ? 1 : 0));
      s.steer += (steerTarget - s.steer) * 0.18;
      if (this._active(a, 'drive.accelerate')) s.speed = Math.min(7.5, s.speed + 0.12);
      else if (this._active(a, 'drive.brake')) s.speed = Math.max(-2.5, s.speed - 0.2);
      else s.speed *= 0.985;
      if (this._active(a, 'drive.handbrake')) s.speed *= 0.92;
      s.roadOffset = (s.roadOffset + Math.max(0, s.speed) * 3) % 80;
      s.x = clamp(s.x + s.steer * Math.abs(s.speed) * 0.9, 70, this.canvas.width - 70);
      s.horn = this._active(a, 'drive.horn') ? 1 : Math.max(0, s.horn - 0.05);
      if (edge(this, a, 'drive.camera')) s.cam = (s.cam + 1) % 3;
    }
  };

  /* ---------- 渲染 ---------- */

  PreviewEngine.prototype._render = function (ctxObj, active) {
    var c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#0c111c';
    c.fillRect(0, 0, W, H);

    if (this.scene === 'menu') this._renderMenu();
    else if (this.scene === 'onFoot') this._renderOnFoot(active);
    else this._renderDriving(active);

    // 左上角情境标识
    c.fillStyle = '#93a0bb';
    c.font = '12px sans-serif';
    c.fillText('情境：' + ctxObj.icon + ' ' + ctxObj.name, 14, 20);
  };

  PreviewEngine.prototype._renderMenu = function () {
    var c = this.ctx, s = this.state.menu;
    c.fillStyle = '#141c2e';
    roundRect(c, 220, 50, 320, 250, 14); c.fill();
    c.fillStyle = '#e6ebf5';
    c.font = 'bold 17px sans-serif';
    c.fillText('暂停菜单', 250, 84);
    c.font = '15px sans-serif';
    s.items.forEach(function (item, i) {
      var y = 126 + i * 34;
      if (i === s.index) {
        c.fillStyle = '#4f7cff';
        roundRect(c, 240, y - 20, 280, 28, 8); c.fill();
        c.fillStyle = '#fff';
      } else {
        c.fillStyle = '#93a0bb';
      }
      c.fillText((i === s.index ? '▸ ' : '  ') + item, 254, y);
    });
  };

  PreviewEngine.prototype._renderOnFoot = function (active) {
    var c = this.ctx, s = this.state.onFoot, W = this.canvas.width, H = this.canvas.height;
    // 地面网格
    c.strokeStyle = '#1b2745';
    c.lineWidth = 1;
    for (var gx = 0; gx < W; gx += 40) {
      c.beginPath(); c.moveTo(gx, 40); c.lineTo(gx, H); c.stroke();
    }
    for (var gy = 40; gy < H; gy += 40) {
      c.beginPath(); c.moveTo(0, gy); c.lineTo(W, gy); c.stroke();
    }
    // 角色
    var jumpY = s.jumping ? Math.sin(s.jumping / 1.6 * Math.PI) * 34 : 0;
    var bodyH = s.crouch ? 22 : 32;
    c.save();
    c.translate(s.x, s.y - jumpY);
    c.scale(s.facing, 1);
    c.fillStyle = this._active(active, 'foot.sprint') ? '#ff9d5c' : '#6d92ff';
    roundRect(c, -11, -bodyH, 22, bodyH, 7); c.fill();
    c.fillStyle = '#cdd8f5';
    c.beginPath(); c.arc(0, -bodyH - 8, 9, 0, Math.PI * 2); c.fill();
    // 攻击/瞄准指示
    if (this._active(active, 'foot.primaryFire')) {
      c.fillStyle = '#ffd166';
      c.font = '16px sans-serif';
      c.fillText('💥', 12, -bodyH + 4);
    }
    if (this._active(active, 'foot.secondaryFire')) {
      c.strokeStyle = '#7ee0c0';
      c.beginPath(); c.moveTo(8, -bodyH / 2); c.lineTo(34, -bodyH / 2); c.stroke();
    }
    c.restore();
    // 互动/装填提示
    c.font = '12px sans-serif';
    c.fillStyle = '#93a0bb';
    if (this._active(active, 'foot.interact')) c.fillText('✋ 互动中…', s.x - 28, s.y + 22);
    if (this._active(active, 'foot.reload')) c.fillText('🔄 装填中…', s.x - 28, s.y + 38);
    if (this._active(active, 'foot.weaponWheel')) {
      c.fillStyle = 'rgba(30,42,72,.9)';
      roundRect(c, s.x - 52, s.y - 120, 104, 104, 10); c.fill();
      c.fillStyle = '#fff'; c.font = '12px sans-serif';
      ['🔫', '🏹', '💣', '🔪'].forEach(function (ic, i) {
        c.fillText(ic, s.x - 38 + (i % 2) * 44, s.y - 88 + Math.floor(i / 2) * 44);
      });
    }
  };

  PreviewEngine.prototype._renderDriving = function (active) {
    var c = this.ctx, s = this.state.driving, W = this.canvas.width, H = this.canvas.height;
    // 道路
    c.fillStyle = '#20263a';
    c.beginPath();
    c.moveTo(W / 2 - 90, H); c.lineTo(W / 2 - 40, 40);
    c.lineTo(W / 2 + 40, 40); c.lineTo(W / 2 + 90, H);
    c.closePath(); c.fill();
    // 车道虚线（随速度滚动）
    c.strokeStyle = '#d9b44a';
    c.lineWidth = 3;
    c.setLineDash([26, 26]);
    c.lineDashOffset = -s.roadOffset;
    c.beginPath(); c.moveTo(W / 2, 40); c.lineTo(W / 2, H); c.stroke();
    c.setLineDash([]);
    // 车
    var carY = H - 78;
    c.save();
    c.translate(s.x, carY);
    c.rotate(s.steer * 0.18);
    c.fillStyle = '#4f7cff';
    roundRect(c, -26, -18, 52, 36, 9); c.fill();
    c.fillStyle = '#aebdf0';
    roundRect(c, -16, -12, 32, 12, 5); c.fill();
    if (this._active(active, 'drive.handbrake')) {
      c.fillStyle = 'rgba(255,120,120,.25)';
      c.fillRect(-34, 14, 68, 8);
    }
    c.restore();
    // 速度 / 视角 / 喇叭
    c.fillStyle = '#93a0bb';
    c.font = '12px sans-serif';
    c.fillText('速度 ' + Math.abs(s.speed).toFixed(1), 16, H - 24);
    c.fillText('视角 ' + ['近景', '远景', '第一人称'][s.cam], 110, H - 24);
    if (s.horn > 0) {
      c.fillStyle = '#ffd166';
      c.font = 'bold 15px sans-serif';
      c.fillText('📢 哔——', s.x + 34, carY - 26);
    }
  };

  /* ---------- 操作状态条 ---------- */

  PreviewEngine.prototype._renderActionBar = function (ctxObj, active) {
    if (!this.actionBarEl) return;
    var html = ctxObj.actions.map(function (action) {
      var on = !!active[action.id];
      return '<span class="action-chip' + (on ? ' active' : '') + '" data-action="' +
        action.id + '">' + (on ? '● ' : '○ ') + escapeHtml(action.name) + '</span>';
    }).join('');
    if (html !== this._lastBarHtml) {
      this.actionBarEl.innerHTML = html;
      this._lastBarHtml = html;
    }
  };

  /* ---------- 工具 ---------- */

  function edge(engine, active, id) {
    return !!active[id] && !engine.lastActive[id];
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  global.PreviewEngine = PreviewEngine;
})(typeof window !== 'undefined' ? window : globalThis);
