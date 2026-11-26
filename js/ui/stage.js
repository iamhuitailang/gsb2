/* 中央画布：自适应尺寸、安全区叠加、点选/移动/缩放/旋转的指针交互 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const clamp = G.util.clamp;

  let art, ovs, actx, octx, frame, vp, zoomLabel;
  let viewScale = 1; // CSS 像素 / 输出像素
  let interaction = null;

  function initRefs() {
    art = document.getElementById('artCanvas');
    ovs = document.getElementById('overlayCanvas');
    actx = art.getContext('2d');
    octx = ovs.getContext('2d');
    frame = document.getElementById('canvasFrame');
    vp = document.getElementById('stageViewport');
    zoomLabel = document.getElementById('zoomLabel');
  }

  function fit() {
    if (!art) initRefs();
    const p = G.App.state.project;
    if (art.width !== p.width || art.height !== p.height) {
      art.width = p.width;
      art.height = p.height;
      ovs.width = p.width;
      ovs.height = p.height;
    }
    const cs = getComputedStyle(vp);
    const availW = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    viewScale = Math.min(availW / p.width, availH / p.height);
    const w = Math.max(40, p.width * viewScale);
    const h = Math.max(40, p.height * viewScale);
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
    G.UI.Stage.renderOverlay();
  }

  function toOutput(e) {
    const r = ovs.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * art.width,
      y: ((e.clientY - r.top) / r.height) * art.height,
    };
  }

  /* ---------- 坐标变换 ---------- */
  function localToCanvas(st, lx, ly) {
    const sx = st.scaleX / 100;
    const sy = st.scaleY / 100;
    const x = lx * sx;
    const y = ly * sy;
    const cos = Math.cos((st.rotation * Math.PI) / 180);
    const sin = Math.sin((st.rotation * Math.PI) / 180);
    return { x: st.x + x * cos - y * sin, y: st.y + x * sin + y * cos };
  }

  function canvasToStartLocal(p, st0) {
    const dx = p.x - st0.x;
    const dy = p.y - st0.y;
    const rad = (st0.rotation * Math.PI) / 180;
    const cos = Math.cos(-rad);
    const sin = Math.sin(-rad);
    const rx = dx * cos - dy * sin; // R(-θ)
    const ry = dx * sin + dy * cos;
    return { x: rx / (st0.scaleX / 100), y: ry / (st0.scaleY / 100) };
  }

  function corners(st) {
    return [
      localToCanvas(st, -st.w / 2, -st.h / 2),
      localToCanvas(st, st.w / 2, -st.h / 2),
      localToCanvas(st, st.w / 2, st.h / 2),
      localToCanvas(st, -st.w / 2, st.h / 2),
    ];
  }

  const HANDLES = [
    { id: 'nw', hx: -1, hy: -1 }, { id: 'n', hx: 0, hy: -1 },
    { id: 'ne', hx: 1, hy: -1 }, { id: 'e', hx: 1, hy: 0 },
    { id: 'se', hx: 1, hy: 1 }, { id: 's', hx: 0, hy: 1 },
    { id: 'sw', hx: -1, hy: 1 }, { id: 'w', hx: -1, hy: 0 },
  ];

  function handlePoints(st) {
    const pts = HANDLES.map((hd) => {
      const p = localToCanvas(st, hd.hx * st.w / 2, hd.hy * st.h / 2);
      return Object.assign({}, hd, p);
    });
    const rot = localToCanvas(st, 0, -st.h / 2 - 34 / viewScale);
    pts.push({ id: 'rot', hx: 0, hy: -1, x: rot.x, y: rot.y });
    const top = localToCanvas(st, 0, -st.h / 2);
    return { handles: pts, top };
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function hitHandle(p, st) {
    const { handles } = handlePoints(st);
    const threshold = 13 / viewScale;
    for (const hd of handles) {
      if (dist(p, hd) <= threshold) return hd.id;
    }
    return null;
  }

  function pointInLayer(layer, p, time) {
    const st = G.Interpolate.sampleLayer(layer, time);
    if (!G.Interpolate.isActiveAt(layer, G.App.state.time)) return false;
    const local = canvasToStartLocal(p, st);
    return Math.abs(local.x) <= st.w / 2 && Math.abs(local.y) <= st.h / 2;
  }

  function hitTestLayer(p) {
    const t = G.App.state.time;
    const entries = G.Model.flatten(G.App.state.project.children)
      .filter((e) => e.layer.type !== 'group' && !e.hidden && !e.locked);
    // flatten 为顶→底，直接顺序检测
    for (const e of entries) {
      if (pointInLayer(e.layer, p, t)) return e.layer;
    }
    return null;
  }

  /* ---------- 绘制叠加层 ---------- */
  function drawSelection(layer) {
    const st = G.Interpolate.sampleLayer(layer, G.App.state.time);
    const pts = corners(st);
    const o = octx;
    const inv = 1 / viewScale;

    o.save();
    o.strokeStyle = '#6e8bff';
    o.lineWidth = 1.6 * inv;
    o.beginPath();
    o.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) o.lineTo(pts[i].x, pts[i].y);
    o.closePath();
    o.stroke();

    const { handles, top } = handlePoints(st);
    // 旋转杆
    const rotH = handles.find((x) => x.id === 'rot');
    o.strokeStyle = 'rgba(110,139,255,0.8)';
    o.lineWidth = 1.4 * inv;
    o.beginPath();
    o.moveTo(top.x, top.y);
    o.lineTo(rotH.x, rotH.y);
    o.stroke();

    handles.forEach((hd) => {
      const r = (hd.id === 'rot' ? 8 : 5.5) * inv;
      o.beginPath();
      o.arc(hd.x, hd.y, r, 0, Math.PI * 2);
      o.fillStyle = hd.id === 'rot' ? '#37d4e8' : '#ffffff';
      o.fill();
      o.lineWidth = 1.6 * inv;
      o.strokeStyle = '#5470e6';
      o.stroke();
    });

    // 名称标签
    const fs = 15 * inv;
    o.font = `600 ${fs}px -apple-system, "PingFang SC", sans-serif`;
    const label = layer.name;
    const tw = o.measureText(label).width;
    const lx = pts[0].x;
    const ly = pts[0].y - 26 * inv;
    o.fillStyle = 'rgba(84,112,230,0.95)';
    roundRect(o, lx - 6 * inv, ly - 15 * inv, tw + 14 * inv, 21 * inv, 5 * inv);
    o.fill();
    o.fillStyle = '#fff';
    o.textBaseline = 'middle';
    o.textAlign = 'left';
    o.fillText(label, lx + 1 * inv, ly - 4 * inv);
    o.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function renderArt() {
    if (!actx) initRefs();
    G.Renderer.renderFrame(actx, G.App.state.project, G.App.state.time);
  }

  function renderOverlay() {
    if (!octx) initRefs();
    const p = G.App.state.project;
    octx.clearRect(0, 0, p.width, p.height);
    G.Renderer.drawGuides(octx, p, viewScale);

    // 多选：每个都画框；单选：带控制点
    const sel = G.App.state.selection;
    if (interaction && interaction.mode === 'multi-move') {
      interaction.starts.forEach((s) => {
        const layer = G.Model.findById(p.children, s.id)?.layer;
        if (layer) drawSelection(layer);
      });
      return;
    }
    if (sel.length === 1) {
      const found = G.Model.findById(p.children, sel[0]);
      if (found && found.layer.type !== 'group' && !found.meta_locked) {
        // 祖先锁定时不显示控制（findById 不直接给 meta，用 flatten 判定）
        const meta = G.Model.flatten(p.children).find((e) => e.layer.id === sel[0]);
        if (meta && !meta.locked) drawSelection(found.layer);
      }
    } else if (sel.length > 1) {
      sel.forEach((id) => {
        const f = G.Model.findById(p.children, id);
        if (f && f.layer.type !== 'group') drawSelection(f.layer);
      });
    }
  }

  function render() {
    if (!art) initRefs();
    renderArt();
    renderOverlay();
    updateInfo();
  }

  function updateInfo() {
    const el = document.getElementById('stageInfo');
    if (!el || !G.App) return;
    const p = G.App.state.project;
    const t = G.App.state.time;
    const sel = G.App.state.selection;
    let msg = `${p.width}×${p.height} · ${p.fps}fps · ${G.util.formatTime(t)} / ${G.util.formatTime(p.duration)}`;
    if (sel.length === 1) {
      const f = G.Model.findById(p.children, sel[0]);
      if (f && f.layer.type === 'group') {
        msg += ` ｜ ${f.layer.name}（编组 · ${f.layer.children.length} 个图层）`;
      } else if (f) {
        const st = G.Interpolate.sampleLayer(f.layer, t);
        msg += ` ｜ ${f.layer.name}  X:${Math.round(st.x)} Y:${Math.round(st.y)} ` +
          `W:${Math.round(st.w * st.scaleX / 100)} H:${Math.round(st.h * st.scaleY / 100)} ` +
          `旋转:${Math.round(st.rotation)}° 透明:${Math.round(st.opacity)}%`;
      }
    } else if (sel.length > 1) {
      msg += ` ｜ 已选 ${sel.length} 个图层`;
    }
    el.textContent = msg;
  }

  /* ---------- 指针交互 ---------- */
  function onPointerDown(e) {
    if (e.button !== 0) return;
    const app = G.App;
    const p = app.state.project;
    const pt = toOutput(e);

    // 1) 单选图层的控制点优先
    let primary = null;
    if (app.state.selection.length === 1) {
      const f = G.Model.findById(p.children, app.state.selection[0]);
      if (f) {
        const meta = G.Model.flatten(p.children).find((x) => x.layer.id === f.layer.id);
        if (f.layer.type !== 'group' && meta && !meta.locked) primary = f.layer;
      }
    }
    if (primary) {
      const st = G.Interpolate.sampleLayer(primary, app.state.time);
      const handle = hitHandle(pt, st);
      if (handle) {
        e.preventDefault();
        app.history.beginGesture(p);
        ovs.setPointerCapture?.(e.pointerId);
        interaction = { mode: handle, layerId: primary.id, start: pt, st0: st };
        return;
      }
    }

    // 2) 图层命中
    const hit = hitTestLayer(pt);
    if (hit) {
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        app.selectLayer(hit.id, { additive: true });
        return;
      }
      if (!app.state.selection.includes(hit.id)) {
        app.selectLayer(hit.id, {});
      }
      // 记录所有当前选中且可移动的图层起点
      const starts = app.state.selection.map((id) => {
        const f = G.Model.findById(p.children, id);
        if (!f || f.layer.type === 'group') return null;
        const meta = G.Model.flatten(p.children).find((x) => x.layer.id === id);
        if (meta && meta.locked) return null;
        const s = G.Interpolate.sampleLayer(f.layer, app.state.time);
        return { id, x: s.x, y: s.y };
      }).filter(Boolean);

      e.preventDefault();
      app.history.beginGesture(p);
      ovs.setPointerCapture?.(e.pointerId);
      interaction = { mode: 'multi-move', start: pt, starts };
    } else {
      // 空白：取消选择
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) app.selectLayer(null, {});
    }
  }

  function onPointerMove(e) {
    const app = G.App;
    if (!interaction && e.target !== ovs) return;
    const pt = toOutput(e);

    if (!interaction) {
      // 悬停光标
      updateCursor(pt);
      return;
    }

    const p = app.state.project;
    const dx = pt.x - interaction.start.x;
    const dy = pt.y - interaction.start.y;

    if (interaction.mode === 'multi-move') {
      let ddx = dx, ddy = dy;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0;
      }
      interaction.starts.forEach((s) => {
        app.setPropValue(s.id, 'position', { x: s.x + ddx, y: s.y + ddy });
      });
      app.stageInteractionUpdate();
      return;
    }

    const layer = G.Model.findById(p.children, interaction.layerId)?.layer;
    if (!layer) return;
    const st0 = interaction.st0;

    if (interaction.mode === 'rot') {
      let deg = (Math.atan2(pt.y - st0.y, pt.x - st0.x) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      app.setPropValue(layer.id, 'rotation', { v: Math.round(deg * 10) / 10 });
      app.stageInteractionUpdate();
      return;
    }

    // 八向缩放（改 w/h，对边固定）
    const hd = HANDLES.find((x) => x.id === interaction.mode);
    if (!hd) return;
    const local = canvasToStartLocal(pt, st0);
    const ax = -hd.hx * st0.w / 2;
    const ay = -hd.hy * st0.h / 2;
    let nw = st0.w, nh = st0.h, ncx = 0, ncy = 0;
    if (hd.hx === 1) { nw = local.x - ax; ncx = (local.x + ax) / 2; }
    else if (hd.hx === -1) { nw = ax - local.x; ncx = (local.x + ax) / 2; }
    if (hd.hy === 1) { nh = local.y - ay; ncy = (local.y + ay) / 2; }
    else if (hd.hy === -1) { nh = ay - local.y; ncy = (local.y + ay) / 2; }

    nw = Math.max(2, nw);
    nh = Math.max(2, nh);

    // 角手柄 + Shift：等比缩放
    if (e.shiftKey && hd.hx !== 0 && hd.hy !== 0) {
      const ratio = st0.w / st0.h;
      if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
    }

    const sxF = st0.scaleX / 100;
    const syF = st0.scaleY / 100;
    const ox = ncx * sxF;
    const oy = ncy * syF;
    const rad = (st0.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = st0.x + ox * cos - oy * sin;
    const cy = st0.y + ox * sin + oy * cos;

    app.setPropValue(layer.id, 'size', { w: nw, h: nh });
    app.setPropValue(layer.id, 'position', { x: cx, y: cy });
    app.stageInteractionUpdate();
  }

  function onPointerUp() {
    if (interaction) {
      interaction = null;
      G.App.endStageInteraction();
    }
  }

  function updateCursor(pt) {
    if (!ovs) return;
    const app = G.App;
    if (app.state.selection.length === 1) {
      const f = G.Model.findById(app.state.project.children, app.state.selection[0]);
      if (f && f.layer.type !== 'group') {
        const meta = G.Model.flatten(app.state.project.children).find((x) => x.layer.id === f.layer.id);
        if (meta && !meta.locked) {
          const st = G.Interpolate.sampleLayer(f.layer, app.state.time);
          const h = hitHandle(pt, st);
          if (h === 'rot') { ovs.style.cursor = 'grab'; return; }
          if (h) {
            const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
            ovs.style.cursor = map[h] || 'pointer';
            return;
          }
        }
      }
    }
    ovs.style.cursor = hitTestLayer(pt) ? 'move' : 'default';
  }

  function init() {
    initRefs();
    ovs.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    const ro = new ResizeObserver(() => fit());
    ro.observe(vp);
  }

  G.UI = G.UI || {};
  G.UI.Stage = { init, fit, render, renderArt, renderOverlay, viewScale: () => viewScale };
})();
