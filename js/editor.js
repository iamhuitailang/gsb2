/* 关卡编辑交互：网格吸附放置、拖拽移动/缩放、标记目标、薄平台切换。 */
(function () {
  const JR = (window.JR = window.JR || {});
  const G = JR.C.GRID;

  function snap(v) {
    return Math.round(v / G) * G;
  }

  function createEditor(canvas, getState, onChange) {
    let drag = null; // { kind:'create'|'move'|'resize', entity, startX, startY, ox, oy }
    let mouse = { x: 0, y: 0 };

    function toWorld(ev) {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function hitTest(level, p) {
      // 优先命中右下角缩放手柄，再逆序命中实体
      for (let i = level.entities.length - 1; i >= 0; i--) {
        const e = level.entities[i];
        if (p.x >= e.x + e.w - 7 && p.x <= e.x + e.w + 4 && p.y >= e.y + e.h - 7 && p.y <= e.y + e.h + 4) {
          return { entity: e, handle: 'resize' };
        }
      }
      for (let i = level.entities.length - 1; i >= 0; i--) {
        const e = level.entities[i];
        if (JR.geom.pointInRect(p.x, p.y, e)) return { entity: e, handle: null };
      }
      return null;
    }

    canvas.addEventListener('mousedown', (ev) => {
      const st = getState();
      if (st.mode !== 'edit') return;
      const p = toWorld(ev);
      mouse = p;
      const hit = hitTest(st.level, p);

      if (ev.button === 2) {
        if (hit) st.selectEntity(hit.entity.id);
        return;
      }

      if (st.tool === 'select') {
        if (hit) {
          st.selectEntity(hit.entity.id);
          drag = {
            kind: hit.handle === 'resize' ? 'resize' : 'move',
            entity: hit.entity,
            startX: p.x, startY: p.y, ox: hit.entity.x, oy: hit.entity.y,
            ow: hit.entity.w, oh: hit.entity.h,
          };
        } else {
          st.selectEntity(null);
        }
        return;
      }

      // 放置类工具：起跳区域全图唯一
      if (st.tool === 'start') {
        const existing = st.level.entities.find((e) => e.type === 'start');
        if (existing) {
          existing.x = snap(p.x); existing.y = snap(p.y); existing.w = 64; existing.h = 64;
          st.selectEntity(existing.id);
          onChange();
          return;
        }
      }
      const ent = {
        id: JR.demo.nid(),
        type: st.tool === 'overhead' ? 'overhead' : st.tool === 'start' ? 'start' : 'platform',
        x: snap(p.x), y: snap(p.y),
        w: st.tool === 'start' ? 64 : G, h: st.tool === 'start' ? 64 : G,
        oneWay: false,
      };
      st.level.entities.push(ent);
      st.selectEntity(ent.id);
      drag = { kind: 'create', entity: ent, startX: ent.x, startY: ent.y };
      onChange();
    });

    canvas.addEventListener('mousemove', (ev) => {
      const st = getState();
      mouse = toWorld(ev);
      if (!drag || st.mode !== 'edit') return;
      const e = drag.entity;
      if (drag.kind === 'create' || drag.kind === 'resize') {
        const baseX = drag.kind === 'create' ? drag.startX : drag.ox;
        const baseY = drag.kind === 'create' ? drag.startY : drag.oy;
        e.w = Math.max(G, snap(mouse.x) - baseX + G);
        e.h = Math.max(G, snap(mouse.y) - baseY + G);
      } else if (drag.kind === 'move') {
        e.x = snap(drag.ox + (mouse.x - drag.startX));
        e.y = snap(drag.oy + (mouse.y - drag.startY));
      }
      onChange();
    });

    window.addEventListener('mouseup', () => {
      if (drag && drag.kind === 'create') {
        const e = drag.entity;
        if (e.w <= G && e.h <= G && e.type !== 'start') {
          // 单击未拖拽：给平台/障碍一个默认尺寸
          e.w = e.type === 'platform' ? 96 : 64;
          e.h = 16;
          onChange();
        }
      }
      drag = null;
    });

    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

    return {
      mouse: () => mouse,
    };
  }

  JR.editor = { createEditor, snap };
})();
