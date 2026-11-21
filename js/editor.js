/* editor.js — UI、画布渲染、交互、撤销重做、保存/导出 */
'use strict';

(() => {

  // ---------- 状态 ----------
  let doc = Model.createDoc();
  let hist = Model.createHistory();
  let sel = { objId: null, colId: null, vertIdx: null }; // vertIdx: 多边形顶点 / 矩形角点 / 圆半径柄(-1)
  let mode = 'edit'; // 'edit' | 'play'
  let world = null;  // Physics.World（预览时）
  let drag = null;   // 拖拽状态
  let keys = new Set();
  let highlightContact = null;
  let mouseWorld = { x: 0, y: 0 };

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const AUTOSAVE_KEY = 'cc2d.autosave';

  const CAT_COLORS = ['#7f8c8d', '#2ecc71', '#e74c3c', '#95a5a6', '#f1c40f', '#9b59b6'];

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of children) e.append(c);
    return e;
  }
  const findObj = (id) => doc.objects.find(o => o.id === id);
  const findCol = (o, id) => o && o.colliders.find(c => c.id === id);
  const selObj = () => findObj(sel.objId);
  const selCol = () => findCol(selObj(), sel.colId);

  function mutate(fn) {
    Model.pushHistory(hist, doc);
    fn();
    afterChange();
  }
  function afterChange() {
    autosave();
    renderAll();
    if (mode === 'play' && world) world.rebuild(doc);
  }
  function autosave() {
    try { localStorage.setItem(AUTOSAVE_KEY, Model.serialize(doc)); } catch (e) { /* 隐私模式等 */ }
    $('saveState').textContent = '已自动保存 ' + new Date().toLocaleTimeString();
  }

  // ---------- 画布变换 ----------
  function viewScale() {
    return Math.min(cv.width / doc.world.w, cv.height / doc.world.h);
  }
  function toWorld(ev) {
    const r = cv.getBoundingClientRect();
    const s = viewScale();
    const ox = (cv.width - doc.world.w * s) / 2, oy = (cv.height - doc.world.h * s) / 2;
    return { x: ((ev.clientX - r.left) * (cv.width / r.width) - ox) / s,
             y: ((ev.clientY - r.top) * (cv.height / r.height) - oy) / s };
  }

  // ---------- 渲染 ----------
  function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    const s = viewScale();
    const ox = (cv.width - doc.world.w * s) / 2, oy = (cv.height - doc.world.h * s) / 2;
    ctx.save();
    ctx.translate(ox, oy); ctx.scale(s, s);

    // 网格与边界
    ctx.fillStyle = '#1b1f24'; ctx.fillRect(0, 0, doc.world.w, doc.world.h);
    ctx.strokeStyle = '#2a2f36'; ctx.lineWidth = 1 / s;
    for (let x = 0; x <= doc.world.w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, doc.world.h); ctx.stroke(); }
    for (let y = 0; y <= doc.world.h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(doc.world.w, y); ctx.stroke(); }
    ctx.strokeStyle = '#e67e22'; ctx.lineWidth = 2 / s;
    ctx.strokeRect(0, 0, doc.world.w, doc.world.h);

    // 预览时取运行时位置
    const posOf = (obj) => {
      if (mode === 'play' && world) {
        const b = world.bodies.find(b => b.objId === obj.id);
        if (b) return { x: b.x, y: b.y };
      }
      return { x: obj.x, y: obj.y };
    };

    for (const obj of doc.objects) {
      const p = posOf(obj);
      const rt = { ...obj, x: p.x, y: p.y };
      for (const col of obj.colliders) {
        const shape = Model.colliderToWorld(rt, col);
        const isSel = sel.colId === col.id;
        const inContact = mode === 'play' && world && world.contacts.some(c =>
          (c.ca.colId === col.id) || (c.cb.colId === col.id));
        const color = CAT_COLORS[col.category % CAT_COLORS.length];
        ctx.fillStyle = color + (obj.dynamic ? '44' : '2a');
        ctx.strokeStyle = isSel ? '#ffffff' : (inContact ? '#ff5555' : color);
        ctx.lineWidth = (isSel ? 2.5 : 1.5) / s;
        ctx.beginPath();
        if (shape.type === 'circle') ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
        else { ctx.moveTo(shape.pts[0].x, shape.pts[0].y); for (let i = 1; i < shape.pts.length; i++) ctx.lineTo(shape.pts[i].x, shape.pts[i].y); ctx.closePath(); }
        ctx.fill(); ctx.stroke();

        // 选中碰撞体的编辑手柄（编辑模式）
        if (isSel && mode === 'edit') drawHandles(obj, col, s);
      }
      // 对象原点
      ctx.strokeStyle = '#888'; ctx.lineWidth = 1 / s;
      ctx.beginPath();
      ctx.moveTo(p.x - 6 / s, p.y); ctx.lineTo(p.x + 6 / s, p.y);
      ctx.moveTo(p.x, p.y - 6 / s); ctx.lineTo(p.x, p.y + 6 / s);
      ctx.stroke();
      ctx.fillStyle = '#aaa'; ctx.font = `${12 / s}px sans-serif`;
      ctx.fillText(obj.name, p.x + 8 / s, p.y - 8 / s);
    }

    // 预览：接触点、法线、速度
    if (mode === 'play' && world) {
      for (const b of world.bodies) {
        if (b.static) continue;
        ctx.strokeStyle = '#3498db'; ctx.lineWidth = 1.5 / s;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.vx * 0.15, b.y + b.vy * 0.15); ctx.stroke();
      }
      world.contacts.forEach((c, idx) => {
        const hl = highlightContact === idx;
        for (const pt of c.points) {
          ctx.fillStyle = hl ? '#ffff00' : '#ff3333';
          ctx.beginPath(); ctx.arc(pt.x, pt.y, (hl ? 5 : 3.5) / s, 0, Math.PI * 2); ctx.fill();
          // 法线（A→B）
          ctx.strokeStyle = hl ? '#ffff00' : '#2ecc71'; ctx.lineWidth = 2 / s;
          ctx.beginPath(); ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(pt.x + c.normal.x * 30, pt.y + c.normal.y * 30); ctx.stroke();
        }
      });
    }
    ctx.restore();
  }

  function drawHandles(obj, col, s) {
    const hs = handlePositions(obj, col);
    ctx.fillStyle = '#ffffff';
    for (const h of hs) {
      ctx.beginPath(); ctx.arc(h.x, h.y, 5 / s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1 / s; ctx.stroke();
    }
  }

  // 手柄世界坐标：多边形=各顶点；矩形=4角；圆=半径柄
  function handlePositions(obj, col) {
    const rot = (p) => Geo.rotate(p, obj.rotation);
    if (col.type === 'circle') {
      const p = rot({ x: col.ox + col.r, y: col.oy });
      return [{ x: obj.x + p.x, y: obj.y + p.y, idx: -1 }];
    }
    if (col.type === 'rect') {
      const hw = col.w / 2, hh = col.h / 2;
      return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }]
        .map((p, i) => {
          const q = rot({ x: p.x + col.ox, y: p.y + col.oy });
          return { x: obj.x + q.x, y: obj.y + q.y, idx: i };
        });
    }
    return col.pts.map((p, i) => {
      const q = rot({ x: p.x + col.ox, y: p.y + col.oy });
      return { x: obj.x + q.x, y: obj.y + q.y, idx: i };
    });
  }

  // ---------- 命中测试 ----------
  function hitHandles(p) {
    const o = selObj(), c = selCol();
    if (!o || !c || mode !== 'edit') return null;
    const tol = 8 / viewScale();
    for (const h of handlePositions(o, c)) {
      if (Geo.dist(p, h) < tol) return h.idx;
    }
    return null;
  }
  function hitShape(p) {
    // 从最上层往下找
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const obj = doc.objects[i];
      for (let j = obj.colliders.length - 1; j >= 0; j--) {
        const col = obj.colliders[j];
        const sh = Model.colliderToWorld(obj, col);
        if (sh.type === 'circle') {
          if (Geo.dist(p, sh) <= sh.r) return { obj, col };
        } else if (Geo.pointInPoly(p, sh.pts)) return { obj, col };
      }
    }
    return null;
  }
  // 多边形边上插入点检测（仅当前选中的多边形）
  function hitPolyEdge(p) {
    const o = selObj(), c = selCol();
    if (!o || !c || c.type !== 'poly') return null;
    const sh = Model.colliderToWorld(o, c);
    const tol = 6 / viewScale();
    for (let i = 0; i < sh.pts.length; i++) {
      const a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length];
      const cp = Geo.closestPointOnSegment(p, a, b);
      if (Geo.dist(p, cp) < tol) {
        // 世界 -> 碰撞体局部
        const rel = Geo.rotate({ x: p.x - o.x, y: p.y - o.y }, -o.rotation);
        return { edgeIdx: i, local: { x: rel.x - c.ox, y: rel.y - c.oy } };
      }
    }
    return null;
  }

  // ---------- 鼠标交互 ----------
  cv.addEventListener('mousedown', (ev) => {
    const p = toWorld(ev);
    if (mode === 'play') {
      // 拖拽动态物体
      const hit = hitShape(p);
      if (hit) {
        const b = world.bodies.find(b => b.objId === hit.obj.id);
        if (b && !b.static) {
          sel = { objId: hit.obj.id, colId: hit.col.id, vertIdx: null };
          drag = { kind: 'playMove', body: b, last: p, lastT: performance.now() };
        }
      }
      renderAll();
      return;
    }
    // 编辑模式
    const hi = hitHandles(p);
    if (hi !== null) {
      sel.vertIdx = hi;
      drag = { kind: 'vertex', moved: false };
      return;
    }
    const hit = hitShape(p);
    if (hit) {
      const already = sel.colId === hit.col.id;
      sel = { objId: hit.obj.id, colId: hit.col.id, vertIdx: null };
      // 已选中的碰撞体：拖动改偏移；否则拖动整个对象
      drag = { kind: already ? 'colOffset' : 'objMove', start: p, moved: false,
               orig: already ? { ox: hit.col.ox, oy: hit.col.oy } : { x: hit.obj.x, y: hit.obj.y } };
    } else {
      const edge = hitPolyEdge(p);
      if (edge) {
        const c = selCol();
        mutate(() => c.pts.splice(edge.edgeIdx + 1, 0, edge.local));
        sel.vertIdx = edge.edgeIdx + 1;
        return;
      }
      sel = { objId: null, colId: null, vertIdx: null };
    }
    renderAll();
  });

  cv.addEventListener('mousemove', (ev) => {
    const p = toWorld(ev);
    mouseWorld = p;
    if (!drag) return;
    if (drag.kind === 'playMove') {
      const now = performance.now();
      const dt = Math.max((now - drag.lastT) / 1000, 1e-3);
      drag.body.vx = (p.x - drag.last.x) / dt;
      drag.body.vy = (p.y - drag.last.y) / dt;
      drag.body.x = p.x; drag.body.y = p.y;
      drag.last = p; drag.lastT = now;
      return;
    }
    const o = selObj(), c = selCol();
    if (!o) return;
    if (!drag.moved) { Model.pushHistory(hist, doc); drag.moved = true; }
    if (drag.kind === 'objMove') {
      o.x = drag.orig.x + (p.x - drag.start.x);
      o.y = drag.orig.y + (p.y - drag.start.y);
    } else if (drag.kind === 'colOffset') {
      const d = Geo.rotate({ x: p.x - drag.start.x, y: p.y - drag.start.y }, -o.rotation);
      c.ox = drag.orig.ox + d.x;
      c.oy = drag.orig.oy + d.y;
    } else if (drag.kind === 'vertex') {
      // 世界 -> 碰撞体局部
      const rel = Geo.rotate({ x: p.x - o.x, y: p.y - o.y }, -o.rotation);
      const lx = rel.x - c.ox, ly = rel.y - c.oy;
      if (c.type === 'circle') {
        c.r = Math.max(1, Math.hypot(lx, ly));
      } else if (c.type === 'rect') {
        c.w = Math.max(1, Math.abs(lx) * 2);
        c.h = Math.max(1, Math.abs(ly) * 2);
      } else {
        c.pts[sel.vertIdx] = { x: lx, y: ly };
      }
    }
    autosave();
    if (mode === 'play' && world) world.rebuild(doc);
    renderPanels();
  });

  window.addEventListener('mouseup', () => {
    if (drag && drag.moved) afterChange();
    else if (drag) renderAll();
    drag = null;
  });

  // ---------- 键盘 ----------
  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); doUndo(); return; }
    if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { ev.preventDefault(); doRedo(); return; }
    if (ev.key === ' ') { ev.preventDefault(); toggleMode(); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && mode === 'edit') { ev.preventDefault(); deleteSelection(); return; }
    keys.add(ev.key);
  });
  window.addEventListener('keyup', (ev) => keys.delete(ev.key));

  function deleteSelection() {
    const o = selObj(), c = selCol();
    if (o && c && c.type === 'poly' && sel.vertIdx !== null && sel.vertIdx >= 0 && c.pts.length > 3) {
      mutate(() => { c.pts.splice(sel.vertIdx, 1); });
      sel.vertIdx = null;
    } else if (o && c) {
      mutate(() => { o.colliders = o.colliders.filter(x => x.id !== c.id); });
      sel.colId = null; sel.vertIdx = null;
    } else if (o) {
      mutate(() => { doc.objects = doc.objects.filter(x => x.id !== o.id); });
      sel.objId = null;
    }
  }

  function doUndo() {
    const d = Model.undo(hist, doc);
    if (d) { doc = d; if (mode === 'play' && world) world.rebuild(doc); autosave(); renderAll(); }
  }
  function doRedo() {
    const d = Model.redo(hist, doc);
    if (d) { doc = d; if (mode === 'play' && world) world.rebuild(doc); autosave(); renderAll(); }
  }

  // ---------- 模式切换 ----------
  function toggleMode() {
    if (mode === 'edit') {
      mode = 'play';
      world = new Physics.World(doc);
      $('btnMode').textContent = '⏸ 停止预览';
      $('modeHint').textContent = '预览中：拖拽移动物体，方向键/WASD 控制选中的动态物体，空格停止';
    } else {
      mode = 'edit';
      if (world) { world.writeBack(doc); world = null; }
      highlightContact = null;
      $('btnMode').textContent = '▶ 预览';
      $('modeHint').textContent = '编辑中：拖动顶点/形状，点击边插入顶点，Delete 删除，空格预览';
      afterChange();
    }
    renderAll();
  }

  // 预览中的键盘控制
  function applyKeyboardControl() {
    if (mode !== 'play' || !world) return;
    const o = selObj();
    if (!o || !o.dynamic) return;
    const b = world.bodies.find(b => b.objId === o.id);
    if (!b) return;
    const SPEED = 220;
    if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) b.vx = -SPEED;
    else if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) b.vx = SPEED;
    if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) {
      const grounded = world.contacts.some(c =>
        (c.a === b && c.normal.y < -0.5) || (c.b === b && c.normal.y > 0.5));
      if (grounded) b.vy = -480;
    }
  }

  // ---------- 侧面板 ----------
  function renderAll() { renderTree(); renderProps(); renderIssues(); renderRules(); renderSettings(); renderContacts(); }
  function renderPanels() { renderIssues(); renderProps(); }

  function renderTree() {
    const t = $('tree'); t.innerHTML = '';
    for (const obj of doc.objects) {
      const oDiv = el('div', { class: 'tree-obj' + (sel.objId === obj.id && !sel.colId ? ' sel' : '') },
        el('span', { onclick: () => { sel = { objId: obj.id, colId: null, vertIdx: null }; renderAll(); } },
          (obj.dynamic ? '● ' : '■ ') + obj.name));
      for (const col of obj.colliders) {
        oDiv.append(el('div', {
          class: 'tree-col' + (sel.colId === col.id ? ' sel' : ''),
          onclick: () => { sel = { objId: obj.id, colId: col.id, vertIdx: null }; renderAll(); }
        }, `${col.name} [${col.type}] · ${doc.categories[col.category]}`));
      }
      t.append(oDiv);
    }
  }

  function numField(label, value, onChange, step) {
    const inp = el('input', { type: 'number', step: step || '1', value: String(Math.round(value * 100) / 100) });
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isNaN(v)) mutate(() => onChange(v)); });
    return el('label', {}, el('span', {}, label), inp);
  }
  function textField(label, value, onChange) {
    const inp = el('input', { type: 'text', value });
    inp.addEventListener('change', () => mutate(() => onChange(inp.value)));
    return el('label', {}, el('span', {}, label), inp);
  }
  function checkField(label, value, onChange) {
    const inp = el('input', { type: 'checkbox' });
    inp.checked = value;
    inp.addEventListener('change', () => mutate(() => onChange(inp.checked)));
    return el('label', {}, el('span', {}, label), inp);
  }

  function renderProps() {
    const p = $('props'); p.innerHTML = '';
    const o = selObj(), c = selCol();
    if (!o) { p.append(el('div', { class: 'dim' }, '未选中对象。点击画布中的形状进行选择。')); return; }

    p.append(el('h4', {}, '对象'));
    p.append(textField('名称', o.name, v => o.name = v));
    p.append(numField('X', o.x, v => o.x = v));
    p.append(numField('Y', o.y, v => o.y = v));
    p.append(numField('旋转°', o.rotation * 180 / Math.PI, v => o.rotation = v * Math.PI / 180, '5'));
    p.append(checkField('动态（受重力）', o.dynamic, v => o.dynamic = v));
    p.append(numField('初速Vx', o.vx, v => o.vx = v, '10'));
    p.append(numField('初速Vy', o.vy, v => o.vy = v, '10'));
    p.append(numField('弹性', o.restitution, v => o.restitution = Math.max(0, Math.min(1, v)), '0.1'));
    p.append(numField('摩擦', o.friction, v => o.friction = Math.max(0, Math.min(1, v)), '0.1'));
    p.append(el('button', { onclick: () => { if (confirm('删除对象 ' + o.name + '？')) { mutate(() => doc.objects = doc.objects.filter(x => x.id !== o.id)); sel.objId = null; } } }, '删除对象'));

    if (c) {
      p.append(el('h4', {}, '碰撞体'));
      p.append(textField('名称', c.name, v => c.name = v));
      const catSel = el('select', {});
      doc.categories.forEach((name, i) => catSel.append(el('option', { value: String(i) }, name)));
      catSel.value = String(c.category);
      catSel.addEventListener('change', () => mutate(() => c.category = parseInt(catSel.value)));
      p.append(el('label', {}, el('span', {}, '类别'), catSel));
      p.append(numField('偏移X', c.ox, v => c.ox = v));
      p.append(numField('偏移Y', c.oy, v => c.oy = v));
      if (c.type === 'circle') p.append(numField('半径', c.r, v => c.r = Math.max(0.1, v)));
      if (c.type === 'rect') {
        p.append(numField('宽', c.w, v => c.w = Math.max(0.1, v)));
        p.append(numField('高', c.h, v => c.h = Math.max(0.1, v)));
      }
      if (c.type === 'poly') {
        p.append(el('div', { class: 'dim' }, `顶点数 ${c.pts.length}：拖动手柄移动；点击边插入顶点；选中顶点后 Delete 删除。`));
      }
      p.append(el('button', { onclick: () => { mutate(() => o.colliders = o.colliders.filter(x => x.id !== c.id)); sel.colId = null; } }, '删除碰撞体'));
    }
  }

  function renderIssues() {
    const box = $('issues'); box.innerHTML = '';
    const issues = Model.validate(doc);
    if (!issues.length) { box.append(el('div', { class: 'ok' }, '✓ 无问题')); return; }
    for (const it of issues) {
      box.append(el('div', {
        class: 'issue ' + it.level,
        onclick: () => { sel = { objId: it.objId, colId: it.colId, vertIdx: null }; renderAll(); }
      }, (it.level === 'error' ? '✗ ' : '⚠ ') + it.msg));
    }
  }

  function renderRules() {
    const box = $('rules'); box.innerHTML = '';
    const cats = doc.categories;
    const tbl = el('table', { class: 'rules' });
    const head = el('tr', {}, el('th', {}, ''));
    cats.forEach(n => head.append(el('th', {}, n.slice(0, 2))));
    tbl.append(head);
    for (let i = 0; i < cats.length; i++) {
      const tr = el('tr', {}, el('th', {}, cats[i]));
      for (let j = 0; j < cats.length; j++) {
        if (j < i) { tr.append(el('td', { class: 'dim' }, '')); continue; }
        const key = i + ',' + j;
        const cb = el('input', { type: 'checkbox' });
        cb.checked = doc.rules[key] !== false;
        cb.addEventListener('change', () => mutate(() => doc.rules[key] = cb.checked));
        tr.append(el('td', {}, cb));
      }
      tbl.append(tr);
    }
    box.append(tbl);
  }

  function renderSettings() {
    const box = $('settings'); box.innerHTML = '';
    box.append(numField('重力 px/s²', doc.world.gravity, v => doc.world.gravity = v, '50'));
    box.append(numField('场景宽', doc.world.w, v => doc.world.w = Math.max(100, v), '10'));
    box.append(numField('场景高', doc.world.h, v => doc.world.h = Math.max(100, v), '10'));
  }

  function renderContacts() {
    const box = $('contacts'); box.innerHTML = '';
    if (mode !== 'play' || !world) { box.append(el('div', { class: 'dim' }, '预览时显示接触对')); return; }
    if (!world.contacts.length) { box.append(el('div', { class: 'dim' }, '无接触')); return; }
    world.contacts.forEach((c, idx) => {
      const oa = findObj(c.a.objId), ob = findObj(c.b.objId);
      const deep = c.depth > 4;
      box.append(el('div', {
        class: 'contact' + (deep ? ' deep' : '') + (highlightContact === idx ? ' hl' : ''),
        onclick: () => { highlightContact = highlightContact === idx ? null : idx; renderContacts(); }
      }, `${oa ? oa.name : '?'}.${c.ca.name} ↔ ${ob ? ob.name : '?'}.${c.cb.name}` +
         `  深度${c.depth.toFixed(1)}${deep ? ' ⚠穿透' : ''}`));
    });
  }

  // ---------- 工具栏 ----------
  function addObjectOf(type) {
    mutate(() => {
      const o = Model.createObject('对象' + (doc.objects.length + 1), doc.world.w / 2, doc.world.h / 2);
      o.colliders.push(Model.createCollider(type));
      doc.objects.push(o);
      sel = { objId: o.id, colId: o.colliders[0].id, vertIdx: null };
    });
  }
  function addColliderToSel(type) {
    const o = selObj();
    if (!o) { alert('请先选中一个对象'); return; }
    mutate(() => {
      const c = Model.createCollider(type);
      o.colliders.push(c);
      sel.colId = c.id; sel.vertIdx = null;
    });
  }

  function download(name, text) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportScene() {
    download(doc.name.replace(/\s+/g, '_') + '.scene.json', Model.serialize(doc));
  }
  function exportCharacter() {
    const o = selObj();
    if (!o) { alert('请先在左侧选中要导出的角色对象'); return; }
    const usedCats = [...new Set(o.colliders.map(c => c.category))];
    const cfg = {
      type: 'character-collision',
      name: o.name,
      dynamic: o.dynamic,
      restitution: o.restitution,
      friction: o.friction,
      colliders: o.colliders.map(c => {
        const base = {
          name: c.name, type: c.type,
          category: c.category, categoryName: doc.categories[c.category],
          offset: { x: c.ox, y: c.oy }
        };
        if (c.type === 'circle') base.r = c.r;
        else if (c.type === 'rect') { base.w = c.w; base.h = c.h; }
        else base.pts = c.pts.map(p => ({ x: p.x, y: p.y }));
        return base;
      }),
      // 只导出与所用类别相关的规则，参数与预览完全一致
      rules: Object.fromEntries(Object.entries(doc.rules).filter(([k]) => {
        const [i, j] = k.split(',').map(Number);
        return usedCats.includes(i) && usedCats.includes(j);
      })),
      categories: doc.categories
    };
    download(o.name + '.collision.json', JSON.stringify(cfg, null, 2));
  }

  function loadFromFile() {
    const inp = el('input', { type: 'file', accept: '.json' });
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = Model.deserialize(rd.result);
          Model.pushHistory(hist, doc);
          doc = d;
          if (mode === 'play') toggleMode();
          sel = { objId: null, colId: null, vertIdx: null };
          afterChange();
        } catch (e) { alert('加载失败：' + e.message); }
      };
      rd.readAsText(f);
    });
    inp.click();
  }

  // ---------- 主循环 ----------
  let lastT = performance.now();
  function loop(now) {
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;
    if (mode === 'play' && world) {
      applyKeyboardControl();
      world.step(doc, dt);
      renderContacts();
    }
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- 初始化 ----------
  function init() {
    // 工具栏
    $('btnMode').addEventListener('click', toggleMode);
    $('btnUndo').addEventListener('click', doUndo);
    $('btnRedo').addEventListener('click', doRedo);
    $('btnAddObj').addEventListener('click', () => addObjectOf('rect'));
    $('btnAddCircle').addEventListener('click', () => addColliderToSel('circle'));
    $('btnAddRect').addEventListener('click', () => addColliderToSel('rect'));
    $('btnAddPoly').addEventListener('click', () => addColliderToSel('poly'));
    $('btnSave').addEventListener('click', () => { autosave(); $('saveState').textContent = '已保存 ' + new Date().toLocaleTimeString(); });
    $('btnLoad').addEventListener('click', loadFromFile);
    $('btnExportObj').addEventListener('click', exportCharacter);
    $('btnExportScene').addEventListener('click', exportScene);
    const sel2 = $('sceneSelect');
    Object.keys(Scenes.ALL).forEach(n => sel2.append(el('option', {}, n)));
    sel2.addEventListener('change', () => {
      if (!sel2.value) return;
      if (!confirm('加载内置场景「' + sel2.value + '」？当前修改可通过撤销恢复。')) { sel2.value = ''; return; }
      Model.pushHistory(hist, doc);
      doc = Scenes.create(sel2.value);
      if (mode === 'play') toggleMode();
      sel = { objId: null, colId: null, vertIdx: null };
      sel2.value = '';
      afterChange();
    });

    // 恢复自动保存
    let restored = false;
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) { doc = Model.deserialize(saved); restored = true; }
    } catch (e) { /* 损坏则忽略 */ }
    if (!restored) doc = Scenes.create('角色碰撞示例');

    renderAll();
    requestAnimationFrame(loop);
  }

  init();
})();
