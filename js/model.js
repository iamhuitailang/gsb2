/* model.js — 文档模型、校验、撤销/重做、序列化 */
'use strict';

const Model = (() => {

  const CATEGORIES = ['默认', '玩家', '敌人', '地形', '道具', '传感器'];

  let _id = 1;
  const uid = () => 'id' + (_id++) + '_' + Math.random().toString(36).slice(2, 7);

  function defaultRules() {
    // 类别对规则：'i,j' (i<=j) -> bool，默认全开
    const r = {};
    for (let i = 0; i < CATEGORIES.length; i++)
      for (let j = i; j < CATEGORIES.length; j++)
        r[i + ',' + j] = true;
    return r;
  }

  function createDoc() {
    return {
      version: 1,
      name: '未命名场景',
      world: { w: 960, h: 540, gravity: 1200 },
      categories: CATEGORIES.slice(),
      rules: defaultRules(),
      objects: []
    };
  }

  function createObject(name, x, y) {
    return {
      id: uid(), name: name || '对象', x, y, rotation: 0,
      dynamic: true, vx: 0, vy: 0,
      restitution: 0, friction: 0.4,
      colliders: []
    };
  }

  function createCollider(type) {
    const base = { id: uid(), name: type, type, category: 0, ox: 0, oy: 0 };
    if (type === 'circle') return { ...base, r: 30 };
    if (type === 'rect')   return { ...base, w: 60, h: 40 };
    // polygon：默认三角形
    return { ...base, pts: [{ x: -30, y: 20 }, { x: 30, y: 20 }, { x: 0, y: -30 }] };
  }

  // 碰撞体 -> 世界坐标形状（供物理与绘制）
  function colliderToWorld(obj, col) {
    const off = Geo.rotate({ x: col.ox, y: col.oy }, obj.rotation);
    const cx = obj.x + off.x, cy = obj.y + off.y;
    if (col.type === 'circle') return { type: 'circle', x: cx, y: cy, r: col.r };
    if (col.type === 'rect') {
      const hw = col.w / 2, hh = col.h / 2;
      const local = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
      return { type: 'poly', pts: local.map(p => {
        const r = Geo.rotate({ x: p.x + col.ox, y: p.y + col.oy }, obj.rotation);
        return { x: obj.x + r.x, y: obj.y + r.y };
      }) };
    }
    return { type: 'poly', pts: col.pts.map(p => {
      const r = Geo.rotate({ x: p.x + col.ox, y: p.y + col.oy }, obj.rotation);
      return { x: obj.x + r.x, y: obj.y + r.y };
    }) };
  }

  // ---------- 校验 ----------
  // 返回 [{ level:'error'|'warn', objId, colId, msg }]
  function validate(doc) {
    const issues = [];
    const W = doc.world;
    for (const obj of doc.objects) {
      for (const col of obj.colliders) {
        const at = (msg, level) => issues.push({ level: level || 'error', objId: obj.id, colId: col.id, msg: `${obj.name} / ${col.name}: ${msg}` });

        if (col.type === 'circle') {
          if (!(col.r > 0)) at('圆形半径必须大于 0（零面积）');
        } else if (col.type === 'rect') {
          if (!(col.w > 0) || !(col.h > 0)) at('矩形宽/高必须大于 0（零面积）');
        } else {
          if (col.pts.length < 3) at('多边形顶点数少于 3');
          else {
            const area = Math.abs(Geo.polyArea(col.pts));
            if (area < 1e-6) at('多边形面积为零（顶点共线或重合）');
            const si = Geo.selfIntersections(col.pts);
            if (si.length) at(`多边形自交（边 ${si[0][0]} 与边 ${si[0][1]}）`);
            if (!Geo.isConvex(col.pts)) at('多边形为凹形，预览按凸包近似处理', 'warn');
          }
        }
        // 越界：世界 AABB 超出场景边界
        const bb = Geo.shapeAABB(colliderToWorld(obj, col));
        if (bb.minX < 0 || bb.minY < 0 || bb.maxX > W.w || bb.maxY > W.h)
          at('碰撞体超出场景边界');
      }
    }
    return issues;
  }

  // 凹多边形 -> 凸包（预览物理用，README 有说明）
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length <= 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      const pt = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // ---------- 序列化 ----------
  function serialize(doc) { return JSON.stringify(doc, null, 2); }

  function deserialize(json) {
    const doc = JSON.parse(json);
    if (!doc || !Array.isArray(doc.objects)) throw new Error('不是有效的场景文件');
    doc.world = Object.assign({ w: 960, h: 540, gravity: 1200 }, doc.world);
    doc.categories = CATEGORIES.slice();
    doc.rules = Object.assign(defaultRules(), doc.rules || {});
    for (const o of doc.objects) {
      o.rotation = o.rotation || 0;
      o.vx = o.vx || 0; o.vy = o.vy || 0;
      o.restitution = o.restitution ?? 0;
      o.friction = o.friction ?? 0.4;
      o.colliders = o.colliders || [];
    }
    return doc;
  }

  // ---------- 撤销 / 重做（整文档快照，覆盖顶点、层级、规则等一切修改） ----------
  function createHistory() {
    return { undoStack: [], redoStack: [] };
  }
  function pushHistory(hist, doc) {
    hist.undoStack.push(JSON.stringify(doc));
    if (hist.undoStack.length > 200) hist.undoStack.shift();
    hist.redoStack.length = 0;
  }
  function undo(hist, doc) {
    if (!hist.undoStack.length) return null;
    hist.redoStack.push(JSON.stringify(doc));
    return deserialize(hist.undoStack.pop());
  }
  function redo(hist, doc) {
    if (!hist.redoStack.length) return null;
    hist.undoStack.push(JSON.stringify(doc));
    return deserialize(hist.redoStack.pop());
  }

  return {
    CATEGORIES, createDoc, createObject, createCollider,
    colliderToWorld, validate, convexHull,
    serialize, deserialize,
    createHistory, pushHistory, undo, redo
  };
})();
