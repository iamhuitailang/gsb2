/* 底部时间线：标尺、5 条可关键帧属性轨道、关键帧拖拽改时、片段入出点拖拽 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const h = G.util.h;
  const LABEL_W = 216;

  let pps = 120; // 每秒像素数
  let dragState = null;

  function setPPS(v) { pps = v; }
  function getPPS() { return pps; }

  function trackWidth(project) {
    return Math.max(600, project.duration * pps + 160);
  }

  /* ---------------- 标尺 ---------------- */
  function pickSteps(fps) {
    const majors = [1 / fps, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = majors[majors.length - 1];
    for (const s of majors) {
      if (s * pps >= 110) { major = s; break; }
    }
    let ratio = 1;
    for (const n of [10, 5, 4, 2]) {
      if ((major / n) * pps >= 26) { ratio = n; break; }
    }
    return { major, minor: major / ratio, ratio };
  }

  function buildRuler(project, width) {
    const ruler = h('div', { class: 'tl-ruler', style: { width: `${width}px` } });
    const { major, minor, ratio } = pickSteps(project.fps);
    const count = Math.floor(project.duration / minor + 0.0001);
    const frag = document.createDocumentFragment();

    for (let i = 0; i <= count; i++) {
      const t = +(i * minor).toFixed(5);
      if (t > project.duration + 1e-4) break;
      const isMajor = i % ratio === 0;
      const tick = h('div', {
        class: `tl-tick ${isMajor ? 'major' : 'minor'}`,
        style: { left: `${t * pps}px` },
      }, [h('div', { class: 'tick-line', style: isMajor ? 'height:10px' : '' })]);
      if (isMajor) {
        tick.appendChild(h('div', { class: 'tick-label' }, G.util.formatTime(t, project.fps).slice(3)));
      }
      frag.appendChild(tick);
    }
    ruler.appendChild(frag);

    const seekFromEvent = (e) => {
      const rect = ruler.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let t = G.util.clamp(x / pps, 0, project.duration);
      t = G.util.snapTime(t, project.fps, G.App.state.snap);
      G.App.setTime(t);
    };
    ruler.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      seekFromEvent(e);
      const move = (ev) => seekFromEvent(ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return ruler;
  }

  /* ---------------- 关键帧菱形 ---------------- */
  function diamondEl(layer, prop, kf) {
    const app = G.App;
    const d = h('div', {
      class: `kf-diamond ${app.state.selectedKey && app.state.selectedKey.kfId === kf.id ? 'selected' : ''}`,
      style: { left: `${kf.t * pps}px` },
      title: `${G.Model.PROP_DEFS.find((x) => x.key === prop).label} · ${kf.t.toFixed(3)}s（拖动调整时间）`,
      dataset: { kfId: kf.id },
    });

    d.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      app.focusKeyframe({ layerId: layer.id, prop, kfId: kf.id }, kf.t);
      app.history.beginGesture(app.state.project);

      const keys = layer.keys[prop];
      const sorted = keys.slice().sort((a, b) => a.t - b.t);
      const idx = sorted.findIndex((k) => k.id === kf.id);
      dragState = { layer, prop, kf, startX: e.clientX, startTime: kf.t, sorted, idx, el: d };

      const move = (ev) => {
        const ds = dragState;
        if (!ds) return;
        let nt = ds.startTime + (ev.clientX - ds.startX) / pps;
        nt = G.util.clamp(nt, 0, app.state.project.duration);
        nt = G.util.snapTime(nt, app.state.project.fps, app.state.snap);
        const prev = ds.sorted[ds.idx - 1];
        const next = ds.sorted[ds.idx + 1];
        if (prev) nt = Math.max(prev.t + 0.001, nt);
        if (next) nt = Math.min(next.t - 0.001, nt);
        kf.t = +nt.toFixed(4);
        ds.el.style.left = `${kf.t * pps}px`;
        app.state.time = kf.t;
        G.UI.Timeline.updatePlayhead();
        G.App.renderStage();
        G.App.updateTimecode();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        app.history.endGesture();
        dragState = null;
        app.afterTimelineGesture();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    d.addEventListener('click', (e) => {
      e.stopPropagation();
      app.focusKeyframe({ layerId: layer.id, prop, kfId: kf.id }, kf.t);
    });

    return d;
  }

  /* ---------------- 属性轨道 ---------------- */
  function propRow(layer, def, width) {
    const app = G.App;
    const keys = layer.keys[def.key] || [];
    const label = h('div', { class: 'tl-label', title: def.kfLabel }, [
      h('span', { class: 'flex1' }, def.label),
      h('button', {
        class: `kf-btn ${G.Model.kfAt(keys, app.state.time, app.state.project.fps) >= 0 ? 'key-at-time' : keys.length ? 'has-key' : ''}`,
        style: { width: '18px', height: '18px', fontSize: '9px' },
        title: '在播放头处添加/删除关键帧',
        onclick: (e) => { e.stopPropagation(); app.toggleKeyframe(layer.id, def.key); },
      }, '◆'),
    ]);

    const track = h('div', { class: 'tl-track', style: { width: `${width}px` } });
    // 双击空白处添加关键帧
    track.addEventListener('dblclick', (e) => {
      const rect = track.getBoundingClientRect();
      let t = G.util.clamp((e.clientX - rect.left) / pps, 0, app.state.project.duration);
      t = G.util.snapTime(t, app.state.project.fps, app.state.snap);
      app.addKeyframeAt(layer.id, def.key, t);
    });
    track.addEventListener('click', (e) => {
      if (e.target !== track && !e.target.classList.contains('kf-add-zone')) return;
      const rect = track.getBoundingClientRect();
      let t = G.util.clamp((e.clientX - rect.left) / pps, 0, app.state.project.duration);
      app.setTime(G.util.snapTime(t, app.state.project.fps, app.state.snap));
    });

    keys.slice().sort((a, b) => a.t - b.t).forEach((kf) => track.appendChild(diamondEl(layer, def.key, kf)));
    track.appendChild(h('div', { class: 'kf-add-zone' }));

    return h('div', { class: 'tl-row prop-row', dataset: { layer: layer.id } }, [label, track]);
  }

  /* ---------------- 片段条 ---------------- */
  function clipEl(layer, width) {
    const app = G.App;
    const clip = h('div', {
      class: `tl-clip ${layer.locked ? 'locked' : ''}`,
      style: {
        left: `${(layer.in || 0) * pps}px`,
        width: `${Math.max(6, ((layer.out || 0) - (layer.in || 0)) * pps)}px`,
      },
    }, [
      h('div', { class: 'tl-clip-handle l' }),
      h('div', { class: 'tl-clip-name' }, layer.name),
      h('div', { class: 'tl-clip-handle r' }),
    ]);

    function startClipDrag(mode, e) {
      if (layer.locked) return;
      e.stopPropagation();
      e.preventDefault();
      app.history.beginGesture(app.state.project);
      const startX = e.clientX;
      const origIn = layer.in;
      const origOut = layer.out;
      const el = clip;

      const move = (ev) => {
        const dt = (ev.clientX - startX) / pps;
        let inn = origIn;
        let out = origOut;
        if (mode === 'move') {
          const len = origOut - origIn;
          inn = G.util.clamp(origIn + dt, 0, app.state.project.duration - len);
          out = inn + len;
        } else if (mode === 'l') {
          inn = G.util.clamp(origIn + dt, 0, origOut - 1 / app.state.project.fps);
        } else {
          out = G.util.clamp(origOut + dt, origIn + 1 / app.state.project.fps, app.state.project.duration);
        }
        inn = G.util.snapTime(inn, app.state.project.fps, app.state.snap);
        out = G.util.snapTime(out, app.state.project.fps, app.state.snap);
        layer.in = +inn.toFixed(4);
        layer.out = +out.toFixed(4);
        el.style.left = `${layer.in * pps}px`;
        el.style.width = `${(layer.out - layer.in) * pps}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        app.history.endGesture();
        app.afterTimelineGesture();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }

    clip.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('tl-clip-handle')) return;
      startClipDrag('move', e);
    });
    clip.querySelector('.tl-clip-handle.l').addEventListener('pointerdown', (e) => startClipDrag('l', e));
    clip.querySelector('.tl-clip-handle.r').addEventListener('pointerdown', (e) => startClipDrag('r', e));
    return clip;
  }

  /* ---------------- 主图层行 ---------------- */
  function mainRow(entry, width) {
    const { layer, depth } = entry;
    const app = G.App;
    const selected = app.state.selection.includes(layer.id);

    const icoChar = { text: '文', rect: '矩', image: '图', group: '组' }[layer.type];
    const ico = h('span', { class: `layer-ico mini-ico type-${layer.type}` }, icoChar);

    const label = h('div', {
      class: 'tl-label',
      style: { paddingLeft: `${8 + depth * 14}px` },
      onclick: () => app.selectLayer(layer.id, {}),
    }, [ico, h('span', { class: 'layer-name' }, layer.name)]);

    const track = h('div', { class: 'tl-track', style: { width: `${width}px` } });
    if (layer.type !== 'group') track.appendChild(clipEl(layer, width));
    track.addEventListener('click', () => app.selectLayer(layer.id, {}));

    return h('div', { class: `tl-row main-row ${selected ? 'selected-row' : ''}` }, [label, track]);
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const inner = document.getElementById('timelineInner');
    if (!inner || !G.App) return;
    const project = G.App.state.project;
    const width = trackWidth(project);
    inner.style.width = `${LABEL_W + width}px`;
    inner.innerHTML = '';

    // 标尺行
    const rulerRow = h('div', { class: 'tl-ruler-row' }, [
      h('div', { class: 'tl-corner' }, `时间线 · ${project.fps}fps`),
      buildRuler(project, width),
    ]);
    inner.appendChild(rulerRow);

    // 行（折叠编组跳过子孙）
    const rows = h('div', { class: 'tl-rows' });
    const flat = G.Model.flatten(project.children);
    const hiddenByCollapse = (entry) => {
      let p = entry.parent;
      while (p) { if (p.collapsed) return true; p = findParent(project.children, p.id); }
      return false;
    };
    function findParent(nodes, id) {
      for (const n of nodes) {
        if (n.children) {
          if (n.children.some((c) => c.id === id)) return n;
          const hit = findParent(n.children, id);
          if (hit) return hit;
        }
      }
      return null;
    }

    flat.forEach((entry) => {
      if (hiddenByCollapse(entry)) return;
      rows.appendChild(mainRow(entry, width));
      if (entry.layer.type !== 'group') {
        G.Model.PROP_DEFS.forEach((def) => rows.appendChild(propRow(entry.layer, def, width)));
      }
    });

    if (!flat.length) {
      rows.appendChild(h('div', { class: 'tl-empty', style: { width: `${LABEL_W + width}px` } },
        '添加图层后，在这里为 位置 / 大小 / 旋转 / 透明度 设置关键帧'));
    }
    inner.appendChild(rows);

    // 播放头
    const ph = h('div', { class: 'tl-playhead', id: 'playhead' }, [h('div', { class: 'ph-line' })]);
    inner.appendChild(ph);
    updatePlayhead();
  }

  function updatePlayhead() {
    const ph = document.getElementById('playhead');
    if (!ph || !G.App) return;
    const t = G.App.state.time;
    ph.style.left = `${LABEL_W + t * pps}px`;
  }

  G.UI = G.UI || {};
  G.UI.Timeline = { render, updatePlayhead, setPPS, getPPS, LABEL_W };
})();
