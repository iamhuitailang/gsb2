/* physics.js — 简易物理预览：固定步长、顺序冲量、位置修正
 * 边界（详见 README）：只模拟线性运动（无角速度/扭矩），凹多边形按凸包参与，
 * 离散检测无 CCD，高速物体可能穿过薄墙。 */
'use strict';

const Physics = (() => {

  const DT = 1 / 120;          // 固定步长
  const SLOP = 0.01;           // 穿透容差
  const BAUMGARTE = 0.4;       // 位置修正比例
  const VEL_ITERS = 8, POS_ITERS = 4;

  class Body {
    constructor(obj) {
      this.objId = obj.id;
      this.x = obj.x; this.y = obj.y;
      this.rotation = obj.rotation;
      this.vx = obj.vx; this.vy = obj.vy;
      this.static = !obj.dynamic;
      this.restitution = obj.restitution;
      this.friction = obj.friction;
      this.invMass = this.static ? 0 : 1;
      // 运行时碰撞体世界形状缓存
      this.shapes = obj.colliders.map(col => ({
        colId: col.id, name: col.name, category: col.category,
        shape: Model.colliderToWorld(obj, col)
      }));
    }
    syncShapes(obj) {
      // 形状被编辑后重建，保留速度
      const tmp = { ...obj, x: this.x, y: this.y };
      this.shapes = obj.colliders.map(col => ({
        colId: col.id, name: col.name, category: col.category,
        shape: Model.colliderToWorld(tmp, col)
      }));
      this.rotation = obj.rotation;
      this.static = !obj.dynamic;
      this.invMass = this.static ? 0 : 1;
      this.restitution = obj.restitution;
      this.friction = obj.friction;
    }
  }

  class World {
    constructor(doc) {
      this.gravity = doc.world.gravity;
      this.bodies = [];
      this.contacts = [];   // 本帧接触：[{a,b,ca,cb,normal,depth,points}]
      this._acc = 0;
      this.rebuild(doc);
    }

    rebuild(doc) {
      // 保留已有 body 的运行时位置/速度（按 objId 匹配）；
      // 仅当文档中的坐标被外部修改（如属性面板改 X/Y）时才采用文档位置。
      const old = new Map(this.bodies.map(b => [b.objId, b]));
      const lastDoc = this._lastDocPos || new Map();
      this.gravity = doc.world.gravity;
      this.bodies = doc.objects.map(obj => {
        const prev = old.get(obj.id);
        if (prev) {
          const b = new Body(obj);
          const last = lastDoc.get(obj.id);
          const docMoved = !last || last.x !== obj.x || last.y !== obj.y;
          if (!docMoved) { b.x = prev.x; b.y = prev.y; }
          b.vx = prev.vx; b.vy = prev.vy;
          return b;
        }
        return new Body(obj);
      });
      this._lastDocPos = new Map(doc.objects.map(o => [o.id, { x: o.x, y: o.y }]));
    }

    rulesAllow(doc, catA, catB) {
      const i = Math.min(catA, catB), j = Math.max(catA, catB);
      return doc.rules[i + ',' + j] !== false;
    }

    step(doc, dtFrame) {
      this._acc = Math.min(this._acc + dtFrame, 0.25);
      while (this._acc >= DT) {
        this._acc -= DT;
        this._stepOnce(doc, DT);
      }
    }

    _stepOnce(doc, dt) {
      // 积分
      for (const b of this.bodies) {
        if (b.static) continue;
        b.vy += this.gravity * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }
      // 同步形状到当前位置
      const objById = new Map(doc.objects.map(o => [o.id, o]));
      for (const b of this.bodies) {
        const obj = objById.get(b.objId);
        if (obj) b.syncShapes({ ...obj, x: b.x, y: b.y });
      }
      // 碰撞检测（n²，场景规模小）
      this.contacts = [];
      for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const A = this.bodies[i], B = this.bodies[j];
          if (A.invMass === 0 && B.invMass === 0) continue;
          for (const sa of A.shapes) {
            for (const sb of B.shapes) {
              if (!this.rulesAllow(doc, sa.category, sb.category)) continue;
              const hit = Geo.collide(sa.shape, sb.shape);
              if (hit) this.contacts.push({
                a: A, b: B, ca: sa, cb: sb,
                normal: hit.normal, depth: hit.depth, points: hit.points
              });
            }
          }
        }
      }
      // 速度求解（顺序冲量）
      for (let it = 0; it < VEL_ITERS; it++) {
        for (const c of this.contacts) this._solveVelocity(c);
      }
      // 位置修正
      for (let it = 0; it < POS_ITERS; it++) {
        for (const c of this.contacts) this._solvePosition(c);
      }
    }

    _solveVelocity(c) {
      const A = c.a, B = c.b, n = c.normal;
      const rvx = B.vx - A.vx, rvy = B.vy - A.vy;
      const vn = rvx * n.x + rvy * n.y;
      if (vn > 0) return;
      const e = Math.min(A.restitution, B.restitution);
      const invSum = A.invMass + B.invMass;
      if (invSum === 0) return;
      let jimp = -(1 + e) * vn / invSum;
      A.vx -= jimp * n.x * A.invMass; A.vy -= jimp * n.y * A.invMass;
      B.vx += jimp * n.x * B.invMass; B.vy += jimp * n.y * B.invMass;
      // 摩擦
      const tx = -n.y, ty = n.x;
      const vt = (B.vx - A.vx) * tx + (B.vy - A.vy) * ty;
      const mu = Math.sqrt(A.friction * B.friction);
      let jt = -vt / invSum;
      const maxF = mu * jimp;
      jt = Math.max(-maxF, Math.min(maxF, jt));
      A.vx -= jt * tx * A.invMass; A.vy -= jt * ty * A.invMass;
      B.vx += jt * tx * B.invMass; B.vy += jt * ty * B.invMass;
    }

    _solvePosition(c) {
      const A = c.a, B = c.b, n = c.normal;
      const invSum = A.invMass + B.invMass;
      if (invSum === 0) return;
      const corr = Math.max(c.depth - SLOP, 0) * BAUMGARTE / invSum;
      A.x -= corr * n.x * A.invMass; A.y -= corr * n.y * A.invMass;
      B.x += corr * n.x * B.invMass; B.y += corr * n.y * B.invMass;
    }

    // 把运行时位置写回文档（预览停止时调用）
    writeBack(doc) {
      for (const b of this.bodies) {
        const obj = doc.objects.find(o => o.id === b.objId);
        if (obj) { obj.x = b.x; obj.y = b.y; obj.vx = b.vx; obj.vy = b.vy; }
      }
    }
  }

  return { World, DT };
})();
