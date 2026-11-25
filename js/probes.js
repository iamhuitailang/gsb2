// 两套取样标记,均直接读取 GPU 纹理,逐帧留痕:
//  GhostProbe(屏幕拖影):盯移动边缘,记录 |TAA-单帧|、历史权重、显露标记、速度
//  JitterProbe(画面抖动):盯静止细线,记录单帧亮度与 TAA 亮度的逐帧相位变化
// 另有点追踪:记录"同一个世界点"逐帧落点,直观展示前一帧位置与当前位置。

export class ProbeBank {
  constructor(renderer) {
    this.r = renderer;
    this.ghost = [];
    this.jitter = [];
    this.tracks = [];
    this.history = new Map(); // id -> 逐帧记录数组
    this._idc = 0;
  }

  _nextId(prefix) { return `${prefix}-${++this._idc}`; }

  addGhost(u, v, label = '') {
    const id = this._nextId('g');
    this.ghost.push({ id, u, v, label: label || `拖影 ${this.ghost.length + 1}` });
    this.history.set(id, []);
    return id;
  }

  addJitter(u, v, label = '') {
    const id = this._nextId('j');
    this.jitter.push({ id, u, v, label: label || `抖动 ${this.jitter.length + 1}` });
    this.history.set(id, []);
    return id;
  }

  addTrack(u, v, label = '') {
    const id = this._nextId('t');
    this.tracks.push({ id, u, v, label: label || `追踪点 ${this.tracks.length + 1}` });
    this.history.set(id, []);
    return id;
  }

  remove(id) {
    this.ghost = this.ghost.filter((p) => p.id !== id);
    this.jitter = this.jitter.filter((p) => p.id !== id);
    this.tracks = this.tracks.filter((p) => p.id !== id);
    this.history.delete(id);
  }

  clear() {
    this.ghost = []; this.jitter = []; this.tracks = [];
    this.history.clear();
  }

  // seek/重开后历史轨迹作废
  clearTrails() {
    for (const k of this.history.keys()) this.history.set(k, []);
  }

  _px(u, v) {
    return {
      x: Math.min(this.r.w - 1, Math.max(0, Math.round(u * this.r.w))),
      y: Math.min(this.r.h - 1, Math.max(0, Math.round((1 - v) * this.r.h))),
    };
  }

  sample(frame) {
    const r = this.r;
    const luma = (c, i) => 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];

    const sampleOne = (u, v) => {
      const { x, y } = this._px(u, v);
      const cur = r.readTexture('scene', x, y);
      const taa = r.readTexture('resolved', x, y);
      const dbg = r.readTexture('debug', x, y);
      const vel = r.readTexture('velocity', x, y);
      return {
        frame,
        x, y,
        curLum: luma(cur, 0),
        taaLum: luma(taa, 0),
        ghost: Math.abs(luma(taa, 0) - luma(cur, 0)),
        weight: dbg[0],
        disoccluded: dbg[1],
        speedN: dbg[2],
        clampAmt: dbg[3],
        velX: vel[0],
        velY: vel[1],
      };
    };

    for (const p of [...this.ghost, ...this.jitter]) {
      const rec = sampleOne(p.u, p.v);
      rec.kind = this.ghost.includes(p) ? 'ghost' : 'jitter';
      const arr = this.history.get(p.id);
      arr.push(rec);
      if (arr.length > 900) arr.shift();
    }

    // 点追踪:沿速度场反推历史落点,保留最近 24 帧轨迹
    for (const t of this.tracks) {
      const { x, y } = this._px(t.u, t.v);
      const trail = [{ frame, x, y }];
      let cx = x; let cy = y;
      for (let k = 0; k < 24; k++) {
        const vx = r.readTexture('velocity',
          Math.round(cx), Math.round(cy));
        cx -= vx[0]; cy -= vx[1];
        if (cx < 0 || cy < 0 || cx >= r.w || cy >= r.h) break;
        trail.push({ frame: frame - k - 1, x: cx, y: cy });
      }
      this.history.set(t.id, trail);
    }
  }

  get(id) { return this.history.get(id) || []; }
}

// 默认探针布局:拖影点压在两条栅栏与漂浮方块的往返路径上,
// 抖动点压在静止细线墙的不同密度区域。
export function defaultProbes(bank) {
  bank.addGhost(0.34, 0.55, '栅栏 A 路径');
  bank.addGhost(0.68, 0.5, '栅栏 B 路径');
  bank.addGhost(0.3, 0.26, '漂浮方块路径');
  bank.addJitter(0.5, 0.34, '墙-中线');
  bank.addJitter(0.85, 0.45, '墙-右侧细线');
  bank.addJitter(0.2, 0.72, '墙-角落横线');
}
