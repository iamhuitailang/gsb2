/* 关卡数据结构与几何/碰撞规则（纯函数，分析器与试玩共用）。 */
(function () {
  const JR = (window.JR = window.JR || {});

  // 实体：{ id, type:'platform'|'overhead', x,y,w,h, oneWay?:boolean }
  // 起跳区域：{ id, type:'start', x,y,w,h }
  // 坐标为世界像素，y 轴向下。平台顶面 y 即落脚高度。
  function makeLevel() {
    return { entities: [], targetId: null };
  }

  // epsilon 容差仅用于垂直轴：落地/贴边后浮点残留的极浅垂直重叠不应再被视为碰撞，
  // 否则下一帧起跳向上移动会被自己脚下的平台误判为"撞头"。
  // 水平轴不用 EPS，贴边容差完全由 EDGE_TOLERANCE 规则负责。
  const EPS = 0.05;
  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay + EPS < by + bh && ay + ah > by + EPS;
  }

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function solids(level) {
    return level.entities.filter((e) => e.type === 'platform' || e.type === 'overhead');
  }

  /* 沿单轴移动一个 AABB，返回修正后的位置与碰撞事件。
     规则（需求 3 的明确定义）：
     - platform / overhead 均为实心方块：水平方向挡住，垂直方向：
       向下碰到顶面 -> 着陆（land）；向上碰到底面 -> 撞头（bonk）。
     - oneWay 薄平台：仅当角色上一帧脚底在平台顶面及以上、且本帧向下穿过时才着陆；
       从下往上或水平侧向一律穿过，不阻挡。
     - 贴边容差：着陆后判定"站住"要求角色身体与平台水平重叠 >= EDGE_TOLERANCE，
       否则视为没够到、继续下落（由 resolve 后的 grounded 复检处理）。 */
  function moveAxis(level, box, dx, dy) {
    const events = [];
    let x = box.x + dx;
    let y = box.y + dy;
    const prevBottom = box.y + box.h;

    if (dx !== 0) {
      for (const s of solids(level)) {
        if (s.oneWay) continue; // 薄平台不挡水平方向
        if (rectsOverlap(x, y, box.w, box.h, s.x, s.y, s.w, s.h)) {
          if (dx > 0) x = s.x - box.w;
          else x = s.x + s.w;
          events.push({ kind: 'wall', entityId: s.id, dir: dx > 0 ? 1 : -1 });
        }
      }
    }

    if (dy !== 0) {
      for (const s of solids(level)) {
        if (s.oneWay) {
          // 仅向下、且上一步脚底不低于顶面时才接住
          if (dy <= 0) continue;
          if (prevBottom > s.y + 0.001) continue;
          if (!rectsOverlap(x, y, box.w, box.h, s.x, s.y, s.w, s.h)) continue;
          y = s.y - box.h;
          events.push({ kind: 'land', entityId: s.id, oneWay: true });
          continue;
        }
        if (!rectsOverlap(x, y, box.w, box.h, s.x, s.y, s.w, s.h)) continue;
        if (dy > 0) {
          // swept 着陆条件：上一帧脚底不低于平台顶面（EPS 容差），
          // 否则只是站立状态的浮点浅重叠，不得清掉起跳速度
          if (prevBottom > s.y + EPS) continue;
          y = s.y - box.h;
          events.push({ kind: 'land', entityId: s.id });
        } else {
          y = s.y + s.h;
          events.push({ kind: 'bonk', entityId: s.id });
        }
      }
    }
    return { x, y, events };
  }

  /* 着陆后复检：角色 AABB 与平台顶面的水平重叠是否达到贴边容差。
     不达标则不视为可行走地面（角色会滑出边缘下落）。 */
  function hasSupport(level, box, entityId) {
    const s = level.entities.find((e) => e.id === entityId);
    if (!s) return false;
    const overlap = Math.min(box.x + box.w, s.x + s.w) - Math.max(box.x, s.x);
    return overlap >= JR.C.EDGE_TOLERANCE;
  }

  function findGroundAt(level, box) {
    // 角色当前是否与某实心/薄平台顶面贴合（用于每帧 grounded 复检与滑出边缘）
    const footY = box.y + box.h;
    let best = null;
    for (const s of solids(level)) {
      const overlap = Math.min(box.x + box.w, s.x + s.w) - Math.max(box.x, s.x);
      if (overlap < JR.C.EDGE_TOLERANCE) continue;
      if (Math.abs(footY - s.y) <= 0.5) {
        if (!best || s.y < best.y) best = s;
      }
    }
    return best;
  }

  JR.geom = { makeLevel, rectsOverlap, pointInRect, solids, moveAxis, hasSupport, findGroundAt };
})();
