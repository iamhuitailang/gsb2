/* 左侧层级树、右侧属性/IK/动作面板 */
(function (global) {
  'use strict';

  let app = null;
  let els = {};

  function init(context) {
    app = context;
    els = {
      tree: document.getElementById('boneTree'),
      partList: document.getElementById('partList'),
      ikList: document.getElementById('ikList'),
      animList: document.getElementById('animList'),
      props: document.getElementById('props'),
    };
    bindToolbar();
  }

  function bindToolbar() {
    document.getElementById('btnAddBone').addEventListener('click', () => app.addBone());
    document.getElementById('btnDeleteSel').addEventListener('click', () => app.deleteSelection());
    document.getElementById('btnAddPart').addEventListener('click', () => app.addPart());
    document.getElementById('btnUploadImage').addEventListener('click', () => app.uploadImage());
    document.getElementById('btnAddIK').addEventListener('click', () => app.addIKConstraint());
    document.getElementById('btnUp').addEventListener('click', () => app.moveSibling(-1));
    document.getElementById('btnDown').addEventListener('click', () => app.moveSibling(1));
    document.getElementById('btnAddAnim').addEventListener('click', () => app.addAnimation());
    document.getElementById('btnDuplicateAnim').addEventListener('click', () => app.duplicateAnimation());
    document.getElementById('btnDelAnim').addEventListener('click', () => app.deleteAnimation());
  }

  /* ---------------- 骨骼层级树 ---------------- */

  function renderTree() {
    const project = app.project;
    const sel = app.state.selection;
    function node(bone, depth) {
      const selected = sel && sel.kind === 'bone' && sel.id === bone.id;
      const kids = global.Model.childrenOf(project, bone.id);
      return `
        <div class="tree-node ${selected ? 'sel' : ''}" data-id="${bone.id}"
          style="padding-left:${8 + depth * 14}px" draggable="true">
          <span class="tree-icon">🦴</span>${escapeHtml(bone.name)}
        </div>
        ${kids.map((k) => node(k, depth + 1)).join('')}`;
    }
    const roots = global.Model.rootBones(project);
    els.tree.innerHTML = roots.map((b) => node(b, 0)).join('') || '<div class="muted">无骨骼</div>';

    els.tree.querySelectorAll('.tree-node').forEach((n) => {
      n.addEventListener('click', () => app.select({ kind: 'bone', id: n.dataset.id }));
      n.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/bone', n.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      n.addEventListener('dragover', (e) => { e.preventDefault(); n.classList.add('drop'); });
      n.addEventListener('dragleave', () => n.classList.remove('drop'));
      n.addEventListener('drop', (e) => {
        e.preventDefault();
        n.classList.remove('drop');
        const dragged = e.dataTransfer.getData('text/bone');
        if (dragged) app.reparent(dragged, n.dataset.id);
      });
    });
  }

  function renderPartList() {
    const project = app.project;
    const sel = app.state.selection;
    els.partList.innerHTML = project.parts.map((p) => {
      const bone = global.Model.getBone(project, p.boneId);
      const selected = sel && sel.kind === 'part' && sel.id === p.id;
      return `<div class="list-row ${selected ? 'sel' : ''}" data-id="${p.id}">
        <span>${shapeIcon(p.shape.type)}</span>
        <span class="grow">${escapeHtml(p.name)}</span>
        <span class="muted small">${bone ? bone.name : '未绑定'}</span>
      </div>`;
    }).join('') || '<div class="muted">无部件</div>';
    els.partList.querySelectorAll('.list-row').forEach((n) => {
      n.addEventListener('click', () => app.select({ kind: 'part', id: n.dataset.id }));
    });
  }

  function renderIKList() {
    const project = app.project;
    const sel = app.state.selection;
    els.ikList.innerHTML = project.ik.map((c) => {
      const selected = sel && sel.kind === 'ik' && sel.id === c.id;
      const limited = app.state.ikStates && app.state.ikStates[c.id] === 'limited';
      return `<div class="list-row ${selected ? 'sel' : ''}" data-id="${c.id}">
        <span>🎯</span>
        <span class="grow">${escapeHtml(c.name)}</span>
        <span class="badge ${c.enabled ? 'on' : 'off'}">${c.enabled ? '启用' : '停用'}</span>
        ${limited ? '<span class="badge warn">受限</span>' : ''}
      </div>`;
    }).join('') || '<div class="muted">无 IK 约束</div>';
    els.ikList.querySelectorAll('.list-row').forEach((n) => {
      n.addEventListener('click', () => app.select({ kind: 'ik', id: n.dataset.id }));
    });
  }

  function renderAnimList() {
    const project = app.project;
    els.animList.innerHTML = project.animations.map((a) => {
      const active = a.id === project.activeAnimId;
      return `<div class="list-row ${active ? 'sel' : ''}" data-id="${a.id}">
        <span class="grow">${escapeHtml(a.name)}</span>
        <span class="muted small">${a.frameRate}fps · ${a.frameCount}帧${a.loop ? ' · 循环' : ''}</span>
      </div>`;
    }).join('') || '<div class="muted">无动作</div>';
    els.animList.querySelectorAll('.list-row').forEach((n) => {
      n.addEventListener('click', () => app.switchAnimation(n.dataset.id));
    });
  }

  /* ---------------- 属性面板 ---------------- */

  function renderProps() {
    const project = app.project;
    const sel = app.state.selection;
    if (!sel) {
      els.props.innerHTML = '<div class="muted">未选择任何对象</div>';
      return;
    }
    if (sel.kind === 'bone') {
      const b = global.Model.getBone(project, sel.id);
      if (!b) return;
      const isAnim = app.state.mode === 'animate';
      const local = app.state.pose.locals[b.id] || b.rest;
      const t = isAnim ? local : b.rest;
      const keyed = isAnim && app.activeAnim() &&
        (app.activeAnim().keys[b.id] || []).some((k) => k.frame === app.state.frame);
      els.props.innerHTML = `
        <h4>骨骼 · ${escapeHtml(b.name)} ${isAnim ? '<span class="badge on">动作帧</span>' : '<span class="badge">Setup</span>'}</h4>
        ${field('名称', 'name', b.name, 'text')}
        <div class="grid2">
          ${numField('X', 'x', t.x, 2)}${numField('Y', 'y', t.y, 2)}
          ${numField('旋转°', 'rotation', global.Math2D.deg(t.rotation), 2)}
          ${numField('缩放X', 'scaleX', t.scaleX, 3)}${numField('缩放Y', 'scaleY', t.scaleY, 3)}
        </div>
        ${isAnim ? `<button id="propKeyBtn" class="btn small ${keyed ? 'warn' : ''}">${keyed ? '更新当前帧关键帧' : '在当前帧打关键帧'}</button>
        <p class="hint">动作模式下修改数值会自动写入第 ${app.state.frame + 1} 帧</p>`
          : '<p class="hint">Setup 模式修改的是静止姿势，作为未关键帧化通道的回退值</p>'}
        <label class="row">父骨骼
          <select id="propParent">
            <option value="">（根）</option>
            ${project.bones.filter((x) => x.id !== b.id && !global.Model.isDescendant(project, b.id, x.id))
              .map((x) => `<option value="${x.id}" ${x.id === b.parentId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}
          </select>
        </label>`;
      bindPropEvents(b, isAnim);
    } else if (sel.kind === 'part') {
      const p = global.Model.getPart(project, sel.id);
      if (!p) return;
      els.props.innerHTML = `
        <h4>部件 · ${escapeHtml(p.name)}</h4>
        ${field('名称', 'name', p.name, 'text')}
        <label class="row">绑定骨骼
          <select id="propBone">
            <option value="">（不绑定）</option>
            ${project.bones.map((b) => `<option value="${b.id}" ${b.id === p.boneId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
          </select>
        </label>
        <label class="row">形状
          <select id="propShape">
            ${['rect', 'circle', 'polygon', 'image'].map((t) => `<option value="${t}" ${t === p.shape.type ? 'selected' : ''}>${shapeName(t)}</option>`).join('')}
          </select>
        </label>
        <div class="grid2">
          ${numField('宽', 'sw', p.shape.width, 1)}${numField('高', 'sh', p.shape.height, 1)}
          ${numField('半径', 'sr', p.shape.radius, 1)}
        </div>
        <div class="grid2">
          ${numField('偏移X', 'ox', p.offset.x, 2)}${numField('偏移Y', 'oy', p.offset.y, 2)}
          ${numField('旋转°', 'orot', global.Math2D.deg(p.offset.rotation), 2)}
          ${numField('缩放X', 'osx', p.offset.scaleX, 3)}${numField('缩放Y', 'osy', p.offset.scaleY, 3)}
        </div>
        <div class="grid2">
          <label class="row">填充<input type="color" id="propFill" value="${p.fill}"></label>
          <label class="row">描边<input type="color" id="propStroke" value="${p.stroke}"></label>
          ${numField('不透明度', 'opacity', p.opacity, 2)}
        </div>
        <label class="row"><input type="checkbox" id="propVisible" ${p.visible ? 'checked' : ''}> 可见</label>`;
      bindPartEvents(p);
    } else if (sel.kind === 'ik') {
      const c = project.ik.find((x) => x.id === sel.id);
      if (!c) return;
      const root = global.Model.getBone(project, c.rootBoneId);
      const mid = global.Model.getBone(project, c.midBoneId);
      const eff = global.Model.getBone(project, c.effBoneId);
      const limited = app.state.ikStates && app.state.ikStates[c.id] === 'limited';
      els.props.innerHTML = `
        <h4>IK 约束 · ${escapeHtml(c.name)}</h4>
        ${field('名称', 'name', c.name, 'text')}
        <p class="hint">链：${root ? root.name : '?'} → ${mid ? mid.name : '?'} → ${eff ? eff.name : '?'}</p>
        <label class="row"><input type="checkbox" id="ikEnabled" ${c.enabled ? 'checked' : ''}> 启用约束</label>
        <label class="row">弯曲方向
          <select id="ikBend">
            <option value="1" ${c.bend === 1 ? 'selected' : ''}>+1</option>
            <option value="-1" ${c.bend === -1 ? 'selected' : ''}>-1</option>
          </select>
        </label>
        <div class="grid2">
          ${numField('目标 X', 'tx', c.target.x, 1)}${numField('目标 Y', 'ty', c.target.y, 1)}
        </div>
        ${limited ? '<p class="warn-text">⚠ 当前帧目标超出可达范围，末端已钳制并显示「受限」</p>' : '<p class="hint">在 IK 模式下直接拖动画布上的菱形目标点</p>'}
        <button id="ikKeyBtn" class="btn small">在当前帧写入 IK 目标关键帧</button>`;
      bindIKEvents(c);
    }
  }

  function field(label, id, value, type) {
    return `<label class="row">${label}<input type="${type}" id="prop_${id}" value="${escapeAttr(value)}"></label>`;
  }
  function numField(label, id, value, step) {
    return `<label class="row">${label}<input type="number" step="${step}" id="prop_${id}" value="${Number(value).toFixed(step === 3 ? 3 : 2)}"></label>`;
  }

  function bindPropEvents(bone, isAnim) {
    const nameEl = document.getElementById('prop_name');
    nameEl.addEventListener('change', () => app.renameSelection(nameEl.value));
    const parentEl = document.getElementById('propParent');
    if (parentEl) parentEl.addEventListener('change', () => app.reparent(bone.id, parentEl.value || null));
    const map = [
      ['x', 'x', false], ['y', 'y', false],
      ['rotation', 'rotation', true],
      ['scaleX', 'scaleX', false], ['scaleY', 'scaleY', false],
    ];
    for (const [id, channel, isAngle] of map) {
      const el = document.getElementById('prop_' + id);
      el.addEventListener('change', () => {
        let v = parseFloat(el.value);
        if (Number.isNaN(v)) return;
        if (isAngle) v = global.Math2D.rad(v);
        app.editBoneTransform(bone.id, channel, v, isAnim);
      });
    }
    const keyBtn = document.getElementById('propKeyBtn');
    if (keyBtn) keyBtn.addEventListener('click', () => app.addKeyAtCurrent());
  }

  function bindPartEvents(part) {
    document.getElementById('prop_name').addEventListener('change', (e) => app.renameSelection(e.target.value));
    document.getElementById('propBone').addEventListener('change', (e) => app.bindPart(part.id, e.target.value || null));
    document.getElementById('propShape').addEventListener('change', (e) => app.setPartShapeType(part.id, e.target.value));
    const sw = document.getElementById('prop_sw');
    sw.addEventListener('change', () => app.setPartShapeNum(part.id, 'width', parseFloat(sw.value)));
    const sh = document.getElementById('prop_sh');
    sh.addEventListener('change', () => app.setPartShapeNum(part.id, 'height', parseFloat(sh.value)));
    const sr = document.getElementById('prop_sr');
    sr.addEventListener('change', () => app.setPartShapeNum(part.id, 'radius', parseFloat(sr.value)));
    const offMap = [
      ['ox', 'x', false], ['oy', 'y', false], ['orot', 'rotation', true],
      ['osx', 'scaleX', false], ['osy', 'scaleY', false],
    ];
    for (const [id, channel, isAngle] of offMap) {
      const el = document.getElementById('prop_' + id);
      el.addEventListener('change', () => {
        let v = parseFloat(el.value);
        if (Number.isNaN(v)) return;
        if (isAngle) v = global.Math2D.rad(v);
        app.editPartOffset(part.id, channel, v);
      });
    }
    document.getElementById('propFill').addEventListener('input', (e) => app.setPartStyle(part.id, 'fill', e.target.value));
    document.getElementById('propStroke').addEventListener('input', (e) => app.setPartStyle(part.id, 'stroke', e.target.value));
    document.getElementById('prop_opacity').addEventListener('change', (e) => app.setPartStyle(part.id, 'opacity', parseFloat(e.target.value)));
    document.getElementById('propVisible').addEventListener('change', (e) => app.setPartStyle(part.id, 'visible', e.target.checked));
  }

  function bindIKEvents(c) {
    document.getElementById('prop_name').addEventListener('change', (e) => app.renameSelection(e.target.value));
    document.getElementById('ikEnabled').addEventListener('change', (e) => app.setIKEnabled(c.id, e.target.checked));
    document.getElementById('ikBend').addEventListener('change', (e) => app.setIKBend(c.id, parseInt(e.target.value, 10)));
    const tx = document.getElementById('prop_tx');
    tx.addEventListener('change', () => app.setIKTarget(c.id, { x: parseFloat(tx.value), y: c.target.y }));
    const ty = document.getElementById('prop_ty');
    ty.addEventListener('change', () => app.setIKTarget(c.id, { x: c.target.x, y: parseFloat(ty.value) }));
    document.getElementById('ikKeyBtn').addEventListener('click', () => app.addIKKeyAtCurrent(c.id));
  }

  function shapeIcon(type) {
    return { rect: '▭', circle: '●', polygon: '⬡', image: '🖼' }[type] || '▭';
  }
  function shapeName(t) {
    return { rect: '矩形', circle: '圆形', polygon: '多边形', image: '图片' }[t] || t;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function renderAll() {
    renderTree();
    renderPartList();
    renderIKList();
    renderAnimList();
    renderProps();
  }

  global.Panels = { init, renderAll, renderTree, renderPartList, renderIKList, renderAnimList, renderProps };
})(window);
