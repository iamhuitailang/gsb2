/* 场景数据模型：声源 / 听者 / 墙体 / 混响区 / 移动路线（关键帧） */
'use strict';

class Scene {
  constructor() {
    this.name = '未命名场景';
    this.sources = [];   // SourceModel
    this.listener = null; // ListenerModel（唯一）
    this.walls = [];     // {id,x1,y1,x2,y2,damping}
    this.zones = [];     // {id,x,y,r,decay,wet,name}
    this.duration = 10;  // 时间轴时长（秒）
  }

  /* 关键帧插值：t 时刻实体位置/朝向。无关键帧返回 null（表示使用当前值） */
  static samplePath(path, t) {
    if (!path || path.length === 0) return null;
    if (path.length === 1 || t <= path[0].t) return { ...path[0] };
    const last = path[path.length - 1];
    if (t >= last.t) return { ...last };
    let i = 0;
    while (i < path.length - 1 && path[i + 1].t < t) i++;
    const a = path[i], b = path[i + 1];
    const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return {
      t,
      x: Util.lerp(a.x, b.x, f),
      y: Util.lerp(a.y, b.y, f),
      angle: Util.lerpAngle(a.angle || 0, b.angle || 0, f),
    };
  }

  /* 把时间轴状态应用到实体上（回放/拖动时间轴时调用） */
  applyTimeline(t) {
    for (const s of this.sources) {
      const p = Scene.samplePath(s.path, t);
      if (p) { s.x = p.x; s.y = p.y; if (p.angle !== undefined) s.angle = p.angle; }
    }
    if (this.listener && this.listener.path && this.listener.path.length) {
      const p = Scene.samplePath(this.listener.path, t);
      if (p) { this.listener.x = p.x; this.listener.y = p.y; this.listener.angle = p.angle; }
    }
  }

  maxPathTime() {
    let m = 0;
    const scan = p => { if (p && p.length) m = Math.max(m, p[p.length - 1].t); };
    this.sources.forEach(s => scan(s.path));
    if (this.listener) scan(this.listener.path);
    return m;
  }

  toJSON() {
    return {
      version: 1,
      name: this.name,
      duration: this.duration,
      sources: this.sources,
      listener: this.listener,
      walls: this.walls,
      zones: this.zones,
    };
  }

  static fromJSON(obj) {
    const sc = new Scene();
    sc.name = obj.name || '未命名场景';
    sc.duration = obj.duration || 10;
    sc.sources = (obj.sources || []).map(s => Scene.makeSource(s));
    sc.listener = obj.listener ? Scene.makeListener(obj.listener) : null;
    sc.walls = (obj.walls || []).map(w => ({
      id: w.id || Util.uid(),
      x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
      damping: w.damping !== undefined ? w.damping : 0.7,
    }));
    sc.zones = (obj.zones || []).map(z => ({
      id: z.id || Util.uid(),
      name: z.name || '混响区',
      x: z.x, y: z.y, r: z.r,
      decay: z.decay !== undefined ? z.decay : 2,
      wet: z.wet !== undefined ? z.wet : 0.5,
    }));
    return sc;
  }

  static makeSource(over) {
    return Object.assign({
      id: Util.uid(),
      name: '声源',
      x: 0, y: 0, angle: 0,          // angle: 朝向（弧度，屏幕坐标）
      volume: 0.8,
      muted: false,
      distModel: 'inverse',           // linear | inverse | exponential
      refDistance: 1,
      maxDistance: 30,
      rolloff: 1,
      coneInner: 360,                 // 方向性锥体（度），360 = 全向
      coneOuter: 360,
      coneOuterGain: 0.3,
      sound: { type: 'tone', wave: 'sine', freq: 440 },
      path: [],                       // [{t,x,y,angle}]
    }, over || {});
  }

  static makeListener(over) {
    return Object.assign({
      id: Util.uid(),
      x: 0, y: 0, angle: -Math.PI / 2,
      path: [],
    }, over || {});
  }

  static makeWall(x1, y1, x2, y2) {
    return { id: Util.uid(), x1, y1, x2, y2, damping: 0.7 };
  }

  static makeZone(x, y, r) {
    return { id: Util.uid(), name: '混响区', x, y, r, decay: 2.0, wet: 0.5 };
  }
}
