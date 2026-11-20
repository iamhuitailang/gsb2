/* 本地模拟世界：角色移动、视野检测、动作处理器、Canvas 渲染与场景标记编辑 */
(function (global) {
  'use strict';

  const WORLD_W = 900;
  const WORLD_H = 260;

  /** 动作类型目录（供属性面板与新节点默认参数使用） */
  const ACTION_TYPES = {
    wait:          { label: '等待',     params: { duration: 1000 }, desc: '等待指定毫秒后成功（暂停时不计时）' },
    goto:          { label: '移动到',   params: { target: 'home', speed: 60 }, desc: '朝场景标记移动，到达后成功；无目标则失败' },
    log:           { label: '输出日志', params: { text: '' }, desc: '向运行日志输出一行文本，立即成功' },
    setBlackboard: { label: '设置黑板', params: { key: '', value: '', mode: 'assign', modulo: '' }, desc: '赋值或自增（可按模回绕）黑板字段' },
    patrol:        { label: '巡逻下一点', params: { speed: 50 }, desc: '按顺序走向下一个巡逻点，自动推进巡逻索引' }
  };

  function defaultScene() {
    return {
      agent: { x: 80, y: 150, speed: 60, visionRange: 130, visionAngle: 70 },
      player: { x: 430, y: 90 },
      home: { x: 60, y: 210 },
      patrolPoints: [
        { id: 'pp1', x: 180, y: 80 },
        { id: 'pp2', x: 360, y: 200 },
        { id: 'pp3', x: 620, y: 90 },
        { id: 'pp4', x: 780, y: 205 }
      ]
    };
  }

  function defaultBlackboard() {
    return {
      hp: 100,
      playerVisible: false,
      patrolIndex: 0,
      state: 'idle'
    };
  }

  class Simulation {
    /**
     * @param canvas 模拟区 canvas
     * @param bb Blackboard 实例
     * @param logger { log(level,msg) }
     * @param onSceneChange 场景编辑后的回调
     */
    constructor(canvas, bb, logger, onSceneChange) {
      this.canvas = canvas;
      this.ctx2d = canvas.getContext('2d');
      this.bb = bb;
      this.logger = logger;
      this.scene = defaultScene();
      this.onSceneChange = onSceneChange || (() => {});
      this.agentFacing = 0;          // 朝向（弧度）
      this.trail = [];               // 最近走过的位置
      this.patrolIndex = 0;
      this.dragTarget = null;        // 正在拖动的场景标记
      this._bindPointer();
      this.draw();
    }

    /* ---------------- 生命周期 ---------------- */

    reset(sceneSnapshot, bbSnapshot) {
      this.scene = sceneSnapshot ? BTUtils.deepClone(sceneSnapshot) : defaultScene();
      if (bbSnapshot) this.bb.load(bbSnapshot);
      this.agentFacing = 0;
      this.trail = [];
      this.patrolIndex = Number(this.bb.get('patrolIndex')) || 0;
      this._updateVision();
      this.draw();
    }

    getSnapshot() { return BTUtils.deepClone(this.scene); }

    loadScene(scene) {
      this.scene = BTUtils.deepClone(scene || defaultScene());
      this.trail = [];
      this._updateVision();
      this.draw();
    }

    /** 每个 tick 引擎执行前调用：移动角色并更新视野，dt 毫秒 */
    prepareTick(dt) {
      const a = this.scene.agent;
      // 移动由动作处理器在 data 中记录目标；这里做基于速度的连续推进
      if (this._moveGoal) {
        const step = (this._moveGoal.speed * dt) / 1000;
        const dx = this._moveGoal.x - a.x;
        const dy = this._moveGoal.y - a.y;
        const d = Math.hypot(dx, dy);
        this.agentFacing = Math.atan2(dy, dx);
        if (d <= step || d === 0) {
          a.x = this._moveGoal.x;
          a.y = this._moveGoal.y;
          this._moveGoal = null;
        } else {
          a.x += (dx / d) * step;
          a.y += (dy / d) * step;
        }
        this.trail.push({ x: a.x, y: a.y });
        if (this.trail.length > 120) this.trail.shift();
      }
      this._updateVision();
    }

    _updateVision() {
      const a = this.scene.agent;
      const p = this.scene.player;
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const d = Math.hypot(dx, dy);
      let visible = false;
      if (d <= a.visionRange && d > 0) {
        const ang = Math.atan2(dy, dx);
        let diff = Math.abs(ang - this.agentFacing);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        visible = diff <= (a.visionAngle * Math.PI / 180) / 2;
      }
      const old = this.bb.get('playerVisible');
      if (old !== visible) {
        this.bb.set('playerVisible', visible);
        this.logger.log(visible ? 'success' : 'info', visible ? '👁 玩家进入视野，playerVisible = true' : '玩家离开视野，playerVisible = false');
      }
    }

    findMarker(name) {
      if (name === 'home') return this.scene.home;
      if (name === 'player') return this.scene.player;
      const pp = this.scene.patrolPoints.find((p) => p.id === name);
      return pp || null;
    }

    /* ---------------- 动作处理器（注册给引擎） ---------------- */

    getActionHandlers() {
      const self = this;
      return {
        wait(h) {
          h.data.elapsed = (h.data.elapsed || 0) + h.dt;
          const need = Math.max(0, Number(h.params.duration) || 0);
          if (h.data.elapsed >= need) {
            h.data.elapsed = 0;
            return 'success';
          }
          return 'running';
        },

        goto(h) {
          const target = self.findMarker(h.params.target);
          if (!target) {
            h.logger.log('warn', `移动失败：场景中不存在标记「${h.params.target}」`);
            return 'failure';
          }
          const speed = Number(h.params.speed) || self.scene.agent.speed || 60;
          const d = BTUtils.dist(self.scene.agent.x, self.scene.agent.y, target.x, target.y);
          if (d < 4) {
            self._moveGoal = null;
            return 'success';
          }
          self._moveGoal = { x: target.x, y: target.y, speed };
          return 'running';
        },

        patrol(h) {
          const points = self.scene.patrolPoints;
          if (!points.length) {
            h.logger.log('warn', '巡逻失败：场景中没有巡逻点，请在调试场景面板添加');
            return 'failure';
          }
          if (self.patrolIndex >= points.length) self.patrolIndex = 0;
          const target = points[self.patrolIndex];
          const speed = Number(h.params.speed) || self.scene.agent.speed || 50;
          const d = BTUtils.dist(self.scene.agent.x, self.scene.agent.y, target.x, target.y);
          if (d < 4) {
            self._moveGoal = null;
            self.patrolIndex = (self.patrolIndex + 1) % points.length;
            self.bb.set('patrolIndex', self.patrolIndex);
            h.logger.log('info', `到达巡逻点 ${target.id}，下一个索引 patrolIndex = ${self.patrolIndex}`);
            return 'success';
          }
          self._moveGoal = { x: target.x, y: target.y, speed };
          return 'running';
        },

        log(h) {
          h.logger.log('info', `📝 ${h.params.text || ''}`);
          return 'success';
        },

        setBlackboard(h) {
          const { key, value, mode, modulo } = h.params;
          if (!key) {
            h.logger.log('warn', '设置黑板失败：没有填写字段名');
            return 'failure';
          }
          if (mode === 'increment') {
            const cur = Number(self.bb.get(key)) || 0;
            const inc = Number(value);
            let next = cur + (Number.isNaN(inc) ? 1 : inc);
            const m = Number(modulo);
            if (!Number.isNaN(m) && m > 0) next = ((next % m) + m) % m;
            self.bb.set(key, next);
          } else {
            self.bb.set(key, BTUtils.coerceValue(value == null ? '' : value));
          }
          return 'success';
        }
      };
    }

    /* ---------------- Canvas 渲染 ---------------- */

    draw() {
      const c = this.ctx2d;
      c.clearRect(0, 0, WORLD_W, WORLD_H);
      this._drawGrid(c);
      this._drawVision(c);
      this._drawTrail(c);
      this._drawPatrolLinks(c);
      this._drawMarker(c, this.scene.home, '#36c46e', '⌂', 'home 家');
      this._drawMarker(c, this.scene.player, '#e5534b', '✚', 'player 玩家');
      for (const pp of this.scene.patrolPoints) {
        this._drawMarker(c, pp, '#e3a008', '⚑', pp.id);
      }
      this._drawAgent(c);
    }

    _drawGrid(c) {
      c.strokeStyle = 'rgba(255,255,255,.045)';
      c.lineWidth = 1;
      for (let x = 0; x <= WORLD_W; x += 45) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, WORLD_H); c.stroke();
      }
      for (let y = 0; y <= WORLD_H; y += 45) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(WORLD_W, y); c.stroke();
      }
    }

    _drawVision(c) {
      const a = this.scene.agent;
      const half = (a.visionAngle * Math.PI / 180) / 2;
      const start = this.agentFacing - half;
      const end = this.agentFacing + half;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.arc(a.x, a.y, a.visionRange, start, end);
      c.closePath();
      c.fillStyle = this.bb.get('playerVisible') ? 'rgba(54,196,110,.20)' : 'rgba(79,140,255,.12)';
      c.fill();
      c.strokeStyle = 'rgba(79,140,255,.35)';
      c.stroke();
    }

    _drawTrail(c) {
      if (this.trail.length < 2) return;
      c.beginPath();
      c.moveTo(this.trail[0].x, this.trail[0].y);
      for (const p of this.trail) c.lineTo(p.x, p.y);
      c.strokeStyle = 'rgba(79,140,255,.35)';
      c.lineWidth = 1.5;
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
    }

    _drawPatrolLinks(c) {
      const pts = this.scene.patrolPoints;
      if (pts.length < 2) return;
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.strokeStyle = 'rgba(227,160,8,.25)';
      c.lineWidth = 1;
      c.setLineDash([3, 6]);
      c.stroke();
      c.setLineDash([]);
    }

    _drawMarker(c, m, color, icon, label) {
      c.beginPath();
      c.arc(m.x, m.y, 9, 0, Math.PI * 2);
      c.fillStyle = color;
      c.globalAlpha = .85;
      c.fill();
      c.globalAlpha = 1;
      c.fillStyle = '#fff';
      c.font = '11px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(icon, m.x, m.y + .5);
      c.fillStyle = 'rgba(255,255,255,.75)';
      c.font = '10px monospace';
      c.textAlign = 'left';
      c.fillText(label, m.x + 13, m.y - 10);
    }

    _drawAgent(c) {
      const a = this.scene.agent;
      c.beginPath();
      c.arc(a.x, a.y, 11, 0, Math.PI * 2);
      c.fillStyle = '#4f8cff';
      c.fill();
      c.strokeStyle = '#cfe0ff';
      c.lineWidth = 2;
      c.stroke();
      // 朝向小箭头
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + Math.cos(this.agentFacing) * 16, a.y + Math.sin(this.agentFacing) * 16);
      c.strokeStyle = '#cfe0ff';
      c.lineWidth = 2;
      c.stroke();
      c.fillStyle = '#fff';
      c.font = '10px sans-serif';
      c.textAlign = 'left';
      c.fillText('agent', a.x + 14, a.y + 4);
    }

    /* ---------------- 场景标记拖动 / 巡逻点编辑 ---------------- */

    _toWorld(ev) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) * WORLD_W / rect.width,
        y: (ev.clientY - rect.top) * WORLD_H / rect.height
      };
    }

    _hitMarker(pos) {
      const hit = (m) => BTUtils.dist(pos.x, pos.y, m.x, m.y) <= 14;
      if (hit(this.scene.agent)) return { kind: 'agent' };
      if (hit(this.scene.player)) return { kind: 'player' };
      if (hit(this.scene.home)) return { kind: 'home' };
      for (const pp of this.scene.patrolPoints) {
        if (hit(pp)) return { kind: 'patrol', id: pp.id };
      }
      return null;
    }

    _bindPointer() {
      this.canvas.addEventListener('pointerdown', (ev) => {
        const pos = this._toWorld(ev);
        const target = this._hitMarker(pos);
        if (target) {
          this.dragTarget = target;
          this.canvas.setPointerCapture(ev.pointerId);
        }
      });
      this.canvas.addEventListener('pointermove', (ev) => {
        const pos = this._toWorld(ev);
        if (this.dragTarget) {
          const t = this.dragTarget;
          const x = BTUtils.clamp(pos.x, 8, WORLD_W - 8);
          const y = BTUtils.clamp(pos.y, 8, WORLD_H - 8);
          if (t.kind === 'patrol') {
            const pp = this.scene.patrolPoints.find((p) => p.id === t.id);
            if (pp) { pp.x = x; pp.y = y; }
          } else {
            this.scene[t.kind].x = x;
            this.scene[t.kind].y = y;
          }
          this._updateVision();
          this.draw();
        } else {
          this.canvas.style.cursor = this._hitMarker(pos) ? 'grab' : 'default';
        }
      });
      const finish = (ev) => {
        if (this.dragTarget) {
          this.dragTarget = null;
          try { this.canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
          this.onSceneChange();
        }
      };
      this.canvas.addEventListener('pointerup', finish);
      this.canvas.addEventListener('pointercancel', finish);
    }

    addPatrolPoint() {
      const id = 'pp' + (this.scene.patrolPoints.length + 1) + '_' + Date.now().toString(36);
      this.scene.patrolPoints.push({
        id,
        x: BTUtils.clamp(120 + Math.random() * 600, 20, WORLD_W - 20),
        y: BTUtils.clamp(60 + Math.random() * 160, 20, WORLD_H - 20)
      });
      this.onSceneChange();
      this.draw();
      return id;
    }

    removePatrolPoint(id) {
      this.scene.patrolPoints = this.scene.patrolPoints.filter((p) => p.id !== id);
      this.onSceneChange();
      this.draw();
    }
  }

  const api = { Simulation, ACTION_TYPES, defaultScene, defaultBlackboard, WORLD_W, WORLD_H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
