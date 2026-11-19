/* 应用主控：状态管理、画布交互、撤销/重做、播放、保存与导出 */
(function (global) {
  'use strict';

  const { M, V, clamp, rad, deg, normalizeAngle } = global.Math2D;

  const state = {
    mode: 'setup',          // setup | animate | ik
    tool: 'move',           // move | rotate | scale
    selection: null,        // {kind:'bone'|'part'|'ik', id}
    frame: 0,
    playing: false,
    playClock: 0,
    onionBefore: 1,
    onionAfter: 1,
    showBones: true,
    showLabels: true,
    pose: null,
    ikStates: {},
    drag: null,
    spacePan: false,
  };

  let project = null;
  let canvas, ctx;
  const globalHistory = new global.History.History('全局');
  const animHistories = new Map();
  let historyDirty = false;

  const app = { project: null, state, View: global.Renderer.View };

  /* ---------------- 初始化 ---------------- */

  function init() {
    canvas = document.getElementById('stage');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    project = global.Sample.buildSampleProject();
    app.project = project;
    global.Renderer.View.reset(canvas);

    global.Timeline.init(app);
    global.Panels.init(app);

    bindCanvas();
    bindTopBar();
    bindKeyboard();

    globalHistory.onChange = updateHistoryButtons;
    seek(0);
    refresh();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }

  /* ---------------- 动作与历史 ---------------- */

  function activeAnim() {
    return project.animations.find((a) => a.id === project.activeAnimId) || null;
  }
  app.activeAnim = activeAnim;

  function animHistory(anim) {
    if (!anim) return globalHistory;
    if (!animHistories.has(anim.id)) {
      const h = new global.History.History(anim.name);
      h.onChange = updateHistoryButtons;
      animHistories.set(anim.id, h);
    }
    return animHistories.get(anim.id);
  }

  /** 当前上下文应使用的历史栈：结构/静止姿势走全局，动作编辑只进当前动作栈 */
  function activeHistory() {
    return state.mode === 'setup' ? globalHistory : animHistory(activeAnim());
  }

  function pushGlobal(label, mutate) {
    const before = global.History.snapshot(project);
    mutate();
    const after = global.History.snapshot(project);
    globalHistory.push(label, () => { restore(before); }, () => { restore(after); });
    refresh();
  }

  /** 只快照动作相关字段，保证撤销重做不会触碰其他动作 */
  function pushAnim(label, mutate) {
    const anim = activeAnim();
    if (!anim) { mutate(); refresh(); return; }
    const before = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
    mutate();
    const after = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
    animHistory(anim).push(label,
      () => { applyAnimSnapshot(anim, before); },
      () => { applyAnimSnapshot(anim, after); });
    refresh();
  }

  /** 拖拽类操作：按下时记 before，抬起时一次性提交一条历史 */
  function beginDragHistory() {
    historyDirty = false;
    // 部件偏移属于结构数据，任何模式下都进全局栈；骨骼/IK 才按模式区分
    const dragKind = state.drag.kind;
    const useGlobal = state.mode === 'setup' || dragKind === 'part';
    if (useGlobal) {
      state.drag.snapshot = global.History.snapshot(project);
      state.drag.historyKind = 'global';
    } else {
      const anim = activeAnim();
      if (anim) {
        state.drag.snapshot = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
        state.drag.historyKind = 'anim';
      }
    }
  }

  function commitDragHistory(label) {
    if (!historyDirty) return;
    const snap = state.drag.snapshot;
    if (state.drag.historyKind === 'global') {
      const after = global.History.snapshot(project);
      globalHistory.push(label, () => restore(snap), () => restore(after));
    } else {
      const anim = activeAnim();
      const after = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
      animHistory(anim).push(label,
        () => applyAnimSnapshot(anim, snap),
        () => applyAnimSnapshot(anim, after));
    }
  }

  function applyAnimSnapshot(anim, snap) {
    anim.keys = global.History.snapshot(snap.keys);
    anim.ikKeys = global.History.snapshot(snap.ikKeys);
    refresh();
  }

  function restore(snap) {
    const keep = { activeAnimId: project.activeAnimId };
    project = Object.assign(global.History.snapshot(snap), keep);
    app.project = project;
    refresh();
  }

  function undo() {
    const h = activeHistory();
    const label = h.undo();
    if (label) toast('撤销：' + label);
  }
  function redo() {
    const h = activeHistory();
    const label = h.redo();
    if (label) toast('重做：' + label);
  }

  function updateHistoryButtons() {
    const h = activeHistory();
    const btnU = document.getElementById('btnUndo');
    const btnR = document.getElementById('btnRedo');
    btnU.disabled = !h.canUndo;
    btnR.disabled = !h.canRedo;
    btnU.title = h.canUndo ? '撤销：' + h.nextUndoLabel : '无可撤销';
    btnR.title = h.canRedo ? '重做：' + h.nextRedoLabel : '无可重做';
    document.getElementById('histScope').textContent =
      state.mode === 'setup' ? '历史范围：结构/静止姿势（全局）'
        : '历史范围：动作「' + (activeAnim() ? activeAnim().name : '') + '」（独立栈）';
  }

  /* ---------------- 模式与选择 ---------------- */

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.getElementById('toolGroup').style.display = mode === 'setup' ? '' : 'none';
    refresh();
    updateHistoryButtons();
  }

  function select(sel) {
    state.selection = sel;
    refresh();
  }

  /* ---------------- 姿势计算 ---------------- */

  function computePose() {
    if (state.mode === 'setup' || !activeAnim()) {
      const pose = global.Pose.evaluateRest(project);
      pose.ikTarget = {};
      pose.ikStates = {};
      for (const c of project.ik) pose.ikTarget[c.id] = { ...c.target };
      state.pose = pose;
      state.ikStates = {};
      return pose;
    }
    const anim = activeAnim();
    const wrapped = global.Pose.wrapFrame(state.frame, anim.frameCount, anim.loop);
    const pose = global.Pose.evaluatePose(project, anim, wrapped);
    // 记录求解后的 IK 目标（用于渲染/命中）
    pose.ikTarget = {};
    for (const c of project.ik) {
      pose.ikTarget[c.id] = global.Pose.sampleIKTarget(anim, c, wrapped, wrapped);
    }
    state.ikStates = pose.ikStates || {};
    state.pose = pose;
    return pose;
  }

  function refresh() {
    computePose();
    global.Renderer.render(canvas, project, state.pose, {
      selection: state.selection,
      showBones: state.showBones,
      showLabels: state.showLabels,
      onionBefore: state.mode === 'animate' && !state.playing ? state.onionBefore : 0,
      onionAfter: state.mode === 'animate' && !state.playing ? state.onionAfter : 0,
      anim: activeAnim(),
      frame: global.Pose.wrapFrame(state.frame, activeAnim() ? activeAnim().frameCount : 1, true),
    });
    global.Panels.renderAll();
    global.Timeline.render();
    updateHistoryButtons();
  }

  /* ---------------- 播放 ---------------- */

  function togglePlay() {
    const anim = activeAnim();
    if (!anim) return;
    state.playing = !state.playing;
    if (state.playing) {
      state.playClock = performance.now();
      requestAnimationFrame(playTick);
    }
    refresh();
  }

  function playTick(now) {
    if (!state.playing) return;
    const anim = activeAnim();
    if (!anim) { state.playing = false; return; }
    const elapsed = (now - state.playClock) / 1000;
    const f = elapsed * anim.frameRate;
    state.frame = global.Pose.wrapFrame(f, anim.frameCount, anim.loop);
    computePose();
    global.Renderer.render(canvas, project, state.pose, {
      selection: state.selection, showBones: state.showBones, showLabels: state.showLabels,
      onionBefore: 0, onionAfter: 0, anim, frame: state.frame,
    });
    global.Timeline.render();
    requestAnimationFrame(playTick);
  }

  function seek(frame) {
    const anim = activeAnim();
    if (!anim) { state.frame = 0; refresh(); return; }
    const max = anim.frameCount - 1;
    state.frame = global.Pose.wrapFrame(frame, anim.frameCount, anim.loop);
    if (!anim.loop && frame > max) state.frame = max;
    refresh();
  }

  /* ---------------- 骨骼操作（Setup 结构编辑，全局历史） ---------------- */

  function addBone() {
    pushGlobal('添加骨骼', () => {
      const parentId = state.selection && state.selection.kind === 'bone' ? state.selection.id : null;
      const bone = global.Model.createBone('骨骼 ' + (project.bones.length + 1), parentId);
      if (parentId) {
        bone.rest.x = 0; bone.rest.y = -40;
      } else {
        bone.rest.x = 0; bone.rest.y = 0;
      }
      project.bones.push(bone);
      state.selection = { kind: 'bone', id: bone.id };
    });
  }

  function addPart() {
    pushGlobal('添加部件', () => {
      const part = global.Model.createPart('部件 ' + (project.parts.length + 1),
        state.selection && state.selection.kind === 'bone' ? state.selection.id : null);
      project.parts.push(part);
      state.selection = { kind: 'part', id: part.id };
    });
  }

  function deleteSelection() {
    if (!state.selection) return;
    const sel = state.selection;
    pushGlobal('删除' + (sel.kind === 'bone' ? '骨骼' : sel.kind === 'part' ? '部件' : 'IK 约束'), () => {
      if (sel.kind === 'bone') global.Model.removeBone(project, sel.id);
      if (sel.kind === 'part') global.Model.removePart(project, sel.id);
      if (sel.kind === 'ik') project.ik = project.ik.filter((c) => c.id !== sel.id);
      state.selection = null;
    });
  }

  function reparent(boneId, newParentId) {
    if (boneId === newParentId) return;
    if (newParentId && global.Model.isDescendant(project, boneId, newParentId)) {
      toast('不能把骨骼挂到它自己的子孙下');
      return;
    }
    pushGlobal('调整骨骼层级', () => {
      const rest = global.Pose.evaluateRest(project);
      global.Model.reparentBone(project, boneId, newParentId, rest);
    });
  }

  function moveSibling(dir) {
    if (!state.selection || state.selection.kind !== 'bone') return;
    pushGlobal('调整显示顺序', () => global.Model.reorderBone(project, state.selection.id, dir));
  }

  function renameSelection(name) {
    pushGlobal('重命名', () => {
      const sel = state.selection;
      const target = sel.kind === 'bone' ? global.Model.getBone(project, sel.id)
        : sel.kind === 'part' ? global.Model.getPart(project, sel.id)
        : project.ik.find((c) => c.id === sel.id);
      if (target) target.name = name;
    });
  }

  function editBoneTransform(boneId, channel, value, isAnim) {
    if (isAnim) {
      // 动作模式：写入当前帧关键帧（独立动作历史）
      const anim = activeAnim();
      pushAnim('编辑关键帧通道', () => {
        const local = state.pose.locals[boneId];
        global.Model.putKey(anim, boneId, Math.round(state.frame), {
          x: local.x, y: local.y, rotation: local.rotation,
          scaleX: local.scaleX, scaleY: local.scaleY,
          [channel]: value,
        });
      });
    } else {
      pushGlobal('编辑静止姿势', () => { global.Model.getBone(project, boneId).rest[channel] = value; });
    }
  }

  /* ---------------- 部件操作（全局历史） ---------------- */

  function bindPart(partId, boneId) {
    pushGlobal('绑定部件到骨骼', () => {
      const part = global.Model.getPart(project, partId);
      // 重新绑定前把世界变换折算到新骨骼的局部空间
      const oldWorld = state.pose.partWorld[partId];
      part.boneId = boneId;
      const newParent = boneId && state.pose.world[boneId] ? state.pose.world[boneId] : M.identity();
      const local = M.multiply(M.invert(newParent), oldWorld);
      part.offset = {
        x: local[4], y: local[5], rotation: M.getRotation(local),
        scaleX: M.getScale(local).sx, scaleY: M.getScale(local).sy,
      };
    });
  }

  function setPartShapeType(partId, type) {
    pushGlobal('修改部件形状', () => { global.Model.getPart(project, partId).shape.type = type; });
  }
  function setPartShapeNum(partId, key, value) {
    if (Number.isNaN(value)) return;
    pushGlobal('修改部件尺寸', () => { global.Model.getPart(project, partId).shape[key] = value; });
  }
  function editPartOffset(partId, channel, value) {
    pushGlobal('编辑部件偏移', () => { global.Model.getPart(project, partId).offset[channel] = value; });
  }
  function setPartStyle(partId, key, value) {
    pushGlobal('修改部件样式', () => { global.Model.getPart(project, partId)[key] = value; });
  }

  /* ---------------- 图片资源 ---------------- */

  function uploadImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const imgEl = new Image();
        imgEl.onload = () => {
          pushGlobal('导入图片', () => {
            const img = global.Model.createImage(file.name, reader.result, imgEl.naturalWidth, imgEl.naturalHeight);
            project.images.push(img);
            const part = global.Model.createPart('图片 ' + file.name,
              state.selection && state.selection.kind === 'bone' ? state.selection.id : null);
            part.shape = { type: 'image', imageId: img.id, width: imgEl.naturalWidth, height: imgEl.naturalHeight, radius: 0, points: [] };
            project.parts.push(part);
            state.selection = { kind: 'part', id: part.id };
          });
        };
        imgEl.src = reader.result;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  /* ---------------- IK 操作 ---------------- */

  function addIKConstraint() {
    const bones = project.bones;
    if (bones.length < 3) { toast('至少需要 3 根骨骼才能创建两段 IK'); return; }
    // 用当前选中骨骼作为末端，向上取两级
    let eff = state.selection && state.selection.kind === 'bone'
      ? global.Model.getBone(project, state.selection.id) : bones[bones.length - 1];
    const mid = eff.parentId ? global.Model.getBone(project, eff.parentId) : null;
    const root = mid && mid.parentId ? global.Model.getBone(project, mid.parentId) : null;
    if (!root || !mid) { toast('选中骨骼需要两级祖先才能创建 IK'); return; }
    pushGlobal('添加 IK 约束', () => {
      const c = global.Model.createIK('IK ' + (project.ik.length + 1), root.id, mid.id, eff.id);
      const rest = global.Pose.evaluateRest(project);
      c.target = { ...rest.worldPos[eff.id] };
      project.ik.push(c);
      state.selection = { kind: 'ik', id: c.id };
    });
  }

  function setIKEnabled(id, enabled) {
    pushGlobal('切换 IK 启用', () => { project.ik.find((c) => c.id === id).enabled = enabled; });
  }
  function setIKBend(id, bend) {
    pushGlobal('调整 IK 弯曲方向', () => { project.ik.find((c) => c.id === id).bend = bend; });
  }
  function setIKTarget(id, target) {
    // Setup 下改的是静止目标；IK 模式拖动时改为在当前帧写关键帧
    if (state.mode === 'ik') {
      const anim = activeAnim();
      if (anim) {
        pushAnim('拖动 IK 目标', () => global.Model.putIKKey(anim, id, Math.round(state.frame), target));
        return;
      }
    }
    pushGlobal('编辑 IK 目标点', () => {
      const c = project.ik.find((x) => x.id === id);
      c.target = target;
    });
  }
  function addIKKeyAtCurrent(id) {
    const anim = activeAnim();
    if (!anim) return;
    const c = project.ik.find((x) => x.id === id);
    pushAnim('写入 IK 关键帧', () => global.Model.putIKKey(anim, id, Math.round(state.frame), state.pose.ikTarget[id] || c.target));
  }

  /* ---------------- 关键帧操作 ---------------- */

  function addKeyAtCurrent() {
    const anim = activeAnim();
    const sel = state.selection;
    if (!anim) return;
    const f = Math.round(state.frame);
    if (sel && sel.kind === 'bone') {
      pushAnim('添加骨骼关键帧', () => {
        const t = state.pose.locals[sel.id];
        global.Model.putKey(anim, sel.id, f, { ...t });
      });
    } else if (sel && sel.kind === 'ik') {
      addIKKeyAtCurrent(sel.id);
    } else {
      toast('请先选择一根骨骼或 IK 约束');
    }
  }

  function deleteKeyAtCurrent() {
    const anim = activeAnim();
    const sel = state.selection;
    if (!anim || !sel) return;
    const f = Math.round(state.frame);
    if (sel.kind === 'bone') {
      pushAnim('删除骨骼关键帧', () => global.Model.removeKeyAt(anim, sel.id, f));
    } else if (sel.kind === 'ik') {
      pushAnim('删除 IK 关键帧', () => global.Model.removeIKKeyAt(anim, sel.id, f));
    }
  }

  function beginKeyMove() {
    historyDirty = false;
    const anim = activeAnim();
    if (anim) {
      state._keyMoveSnap = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
    }
  }

  function commitKeyMove() {
    if (!historyDirty || !state._keyMoveSnap) return;
    const anim = activeAnim();
    const after = global.History.snapshot({ keys: anim.keys, ikKeys: anim.ikKeys });
    animHistory(anim).push('移动关键帧',
      () => applyAnimSnapshot(anim, state._keyMoveSnap),
      () => applyAnimSnapshot(anim, after));
    state._keyMoveSnap = null;
    historyDirty = false;
  }

  function moveKey(boneId, constraintId, fromFrame, toFrame) {
    const anim = activeAnim();
    if (!anim) return;
    // 拖动过程不进历史，松手时由 pointerup 提交；这里直接移动数据
    historyDirty = true;
    if (boneId) {
      const keys = global.Model.getKeys(anim, boneId);
      const k = keys.find((kk) => kk.frame === fromFrame);
      if (k) { k.frame = toFrame; keys.sort((a, b) => a.frame - b.frame); }
    } else if (constraintId) {
      const keys = global.Model.getIKKeys(anim, constraintId);
      const k = keys.find((kk) => kk.frame === fromFrame);
      if (k) { k.frame = toFrame; keys.sort((a, b) => a.frame - b.frame); }
    }
    seek(toFrame);
  }

  function setCurrentKeyEasing(easing) {
    const anim = activeAnim();
    const sel = state.selection;
    if (!anim || !sel || sel.kind !== 'bone') return;
    pushAnim('修改缓动', () => {
      const k = (anim.keys[sel.id] || []).find((kk) => kk.frame === Math.round(state.frame));
      if (k) k.easing = easing;
    });
  }

  function updateAnimSettings(patch) {
    pushGlobal('修改动作设置', () => Object.assign(activeAnim(), patch));
  }

  /* ---------------- 动作管理 ---------------- */

  function addAnimation() {
    pushGlobal('添加动作', () => {
      const a = global.Model.createAnimation('动作 ' + (project.animations.length + 1));
      project.animations.push(a);
      project.activeAnimId = a.id;
      state.frame = 0;
    });
  }

  function duplicateAnimation() {
    const src = activeAnim();
    if (!src) return;
    pushGlobal('复制动作', () => {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = global.Model.uid('anim');
      copy.name = src.name + ' 副本';
      project.animations.push(copy);
      project.activeAnimId = copy.id;
    });
  }

  function deleteAnimation() {
    if (project.animations.length <= 1) { toast('至少保留一个动作'); return; }
    const target = activeAnim();
    pushGlobal('删除动作', () => {
      project.animations = project.animations.filter((a) => a.id !== target.id);
      animHistories.delete(target.id);
      project.activeAnimId = project.animations[0].id;
      state.frame = 0;
    });
  }

  function switchAnimation(id) {
    project.activeAnimId = id;
    state.frame = 0;
    state.playing = false;
    refresh();
  }

  /* ---------------- 画布交互 ---------------- */

  function eventPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function bindCanvas() {
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    const sp = eventPos(e);
    // 中键 / 空格 / Alt：平移视图
    if (e.button === 1 || e.button === 2 || state.spacePan || e.altKey) {
      state.drag = { kind: 'pan', start: sp, panX: global.Renderer.View.panX, panY: global.Renderer.View.panY };
      return;
    }
    const hit = global.Renderer.hitTest(project, state.pose, sp);
    if (!hit) {
      if (!e.shiftKey) state.selection = null;
      state.drag = { kind: 'pan', start: sp, panX: global.Renderer.View.panX, panY: global.Renderer.View.panY };
      refresh();
      return;
    }
    state.selection = hit;
    const world = global.Renderer.View.toWorld(sp);

    if (hit.kind === 'ik') {
      state.drag = { kind: 'ik', id: hit.id, start: world };
      beginDragHistory();
    } else if (hit.kind === 'bone') {
      state.drag = {
        kind: 'bone', id: hit.id, start: world,
        tool: state.tool, mode: state.mode,
        startLocal: { ...state.pose.locals[hit.id] },
        pivot: state.pose.worldPos[hit.id],
      };
      beginDragHistory();
    } else if (hit.kind === 'part') {
      const part = global.Model.getPart(project, hit.id);
      state.drag = {
        kind: 'part', id: hit.id, start: world,
        startOffset: JSON.parse(JSON.stringify(part.offset)),
        parentWorld: part.boneId ? state.pose.world[part.boneId] : M.identity(),
        mode: state.mode, tool: state.tool,
        pivot: M.apply(state.pose.partWorld[hit.id], { x: 0, y: 0 }),
      };
      beginDragHistory();
    }
    refresh();
  }

  function onPointerMove(e) {
    if (!state.drag) return;
    const sp = eventPos(e);
    const world = global.Renderer.View.toWorld(sp);

    if (state.drag.kind === 'pan') {
      global.Renderer.View.panX = state.drag.panX + (sp.x - state.drag.start.x);
      global.Renderer.View.panY = state.drag.panY + (sp.y - state.drag.start.y);
      refresh();
      return;
    }

    if (state.drag.kind === 'ik') {
      const c = project.ik.find((x) => x.id === state.drag.id);
      setIKTargetLive(c.id, world);
      return;
    }

    if (state.drag.kind === 'bone') {
      dragBone(world, sp);
      return;
    }
    if (state.drag.kind === 'part') {
      dragPart(world, sp);
    }
  }

  function onPointerUp() {
    if (!state.drag) return;
    const d = state.drag;
    if (d.kind === 'bone' || d.kind === 'part' || d.kind === 'ik') {
      const label = d.kind === 'ik' ? '拖动 IK 目标'
        : d.kind === 'bone' ? '拖动骨骼关节' : '拖动部件';
      commitDragHistory(label);
    }
    state.drag = null;
    refresh();
  }

  function onWheel(e) {
    e.preventDefault();
    const view = global.Renderer.View;
    const sp = eventPos(e);
    const before = view.toWorld(sp);
    view.scale = clamp(view.scale * (e.deltaY < 0 ? 1.1 : 0.9), 0.2, 5);
    const after = view.toWorld(sp);
    view.panX += (after.x - before.x) * view.scale;
    view.panY += (after.y - before.y) * view.scale;
    refresh();
  }

  /** IK 目标实时拖动：Setup 改静止目标；IK/Animate 模式写当前帧关键帧 */
  function setIKTargetLive(id, world) {
    historyDirty = true;
    const c = project.ik.find((x) => x.id === id);
    if (state.mode === 'setup' || !activeAnim()) {
      c.target = { ...world };
    } else {
      const anim = activeAnim();
      global.Model.putIKKey(anim, id, Math.round(state.frame), world);
    }
    refresh();
  }

  function dragBone(world, sp) {
    const d = state.drag;
    const bone = global.Model.getBone(project, d.id);
    historyDirty = true;

    if (d.mode === 'setup') {
      // Setup 移动关节：两级节点 rig 下 joint = 父 rotNode · T(rest.x,rest.y)，
      // 世界坐标经父 rotNode 逆变换即新的笛卡尔局部平移，旋转/缩放保持不变。
      const parentWorld = bone.parentId ? state.pose.world[bone.parentId] : M.identity();
      const local = M.apply(M.invert(parentWorld), world);
      bone.rest.x = local.x;
      bone.rest.y = local.y;
      refresh();
      return;
    }
    // 动作模式：按工具写入当前帧关键帧
    const anim = activeAnim();
    const f = Math.round(state.frame);
    const base = d.startLocal;
    if (d.tool === 'move') {
      const parentWorld = bone.parentId ? state.pose.world[bone.parentId] : M.identity();
      const local = M.apply(M.invert(parentWorld), world);
      global.Model.putKey(anim, bone.id, f, {
        x: local.x, y: local.y, rotation: base.rotation, scaleX: base.scaleX, scaleY: base.scaleY,
      });
    } else if (d.tool === 'rotate') {
      const pivotScreen = global.Renderer.View.toScreen(d.pivot);
      const a = Math.atan2(sp.y - pivotScreen.y, sp.x - pivotScreen.x);
      const parentRot = bone.parentId ? M.getRotation(state.pose.world[bone.parentId]) : 0;
      // 两级 rig：骨段世界方向 = 父 rotNode 角 + 局部旋转 + 静止平移方向
      const restSegDir = Math.atan2(base.y, base.x);
      global.Model.putKey(anim, bone.id, f, {
        x: base.x, y: base.y, rotation: normalizeAngle(a - parentRot - restSegDir),
        scaleX: base.scaleX, scaleY: base.scaleY,
      });
    } else if (d.tool === 'scale') {
      const dist0 = Math.max(global.Math2D.V.dist(global.Renderer.View.toScreen(d.pivot), { x: 0, y: 0 }), 1);
      const factor = clamp(global.Math2D.V.len(global.Math2D.V.sub(sp, global.Renderer.View.toScreen(d.pivot))) / 80, 0.1, 5);
      global.Model.putKey(anim, bone.id, f, {
        x: base.x, y: base.y, rotation: base.rotation,
        scaleX: d.startLocal.scaleX * factor, scaleY: d.startLocal.scaleY * factor,
      });
    }
    refresh();
  }

  function dragPart(world, sp) {
    const d = state.drag;
    const part = global.Model.getPart(project, d.id);
    historyDirty = true;
    if (d.tool === 'rotate') {
      const pivotScreen = global.Renderer.View.toScreen(d.pivot);
      const a = Math.atan2(sp.y - pivotScreen.y, sp.x - pivotScreen.x);
      const parentRot = M.getRotation(d.parentWorld);
      part.offset.rotation = normalizeAngle(a - parentRot);
    } else if (d.tool === 'scale') {
      const factor = clamp(global.Math2D.V.len(global.Math2D.V.sub(sp, global.Renderer.View.toScreen(d.pivot))) / 80, 0.1, 5);
      part.offset.scaleX = d.startOffset.scaleX * factor;
      part.offset.scaleY = d.startOffset.scaleY * factor;
    } else {
      const local = M.apply(M.invert(d.parentWorld), world);
      part.offset.x = d.startOffset.x + (local.x - M.apply(M.invert(d.parentWorld), d.start).x);
      part.offset.y = d.startOffset.y + (local.y - M.apply(M.invert(d.parentWorld), d.start).y);
    }
    refresh();
  }

  /* ---------------- 顶栏 / 快捷键 ---------------- */

  function bindTopBar() {
    document.getElementById('btnNew').addEventListener('click', newProject);
    document.getElementById('btnOpen').addEventListener('click', openProject);
    document.getElementById('btnSave').addEventListener('click', saveProject);
    document.getElementById('btnExport').addEventListener('click', exportRuntime);
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);
    document.getElementById('btnResetView').addEventListener('click', () => {
      global.Renderer.View.reset(canvas);
      refresh();
    });
    document.getElementById('toggleBones').addEventListener('change', (e) => {
      state.showBones = e.target.checked; refresh();
    });
    document.getElementById('toggleLabels').addEventListener('change', (e) => {
      state.showLabels = e.target.checked; refresh();
    });
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    document.querySelectorAll('.tool-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.tool = b.dataset.tool;
        document.querySelectorAll('.tool-btn').forEach((x) => x.classList.toggle('active', x === b));
      });
    });
  }

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        // 按住空格平移画布；播放请用按钮或 P 键（避免单击空格在两种语义间抖动）
        e.preventDefault();
        state.spacePan = true;
        return;
      }
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); redo(); return;
      }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.frame - 1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.frame + 1); return; }
      if (e.key === 'k' || e.key === 'K') { addKeyAtCurrent(); return; }
      if (e.key === 'p' || e.key === 'P') { togglePlay(); return; }
      if (e.key === '1') setMode('setup');
      if (e.key === '2') setMode('animate');
      if (e.key === '3') setMode('ik');
      if (e.key === 'v' || e.key === 'V') state.tool = 'move';
      if (e.key === 'r' || e.key === 'R') state.tool = 'rotate';
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') state.spacePan = false;
    });
  }

  /* ---------------- 新建 / 保存 / 打开 / 导出 ---------------- */

  function newProject() {
    if (!confirm('新建将清空当前项目，确定？')) return;
    project = global.Model.createProject();
    const anim = global.Model.createAnimation('动作 1');
    project.animations.push(anim);
    project.activeAnimId = anim.id;
    app.project = project;
    globalHistory.clear();
    animHistories.clear();
    state.selection = null;
    state.frame = 0;
    refresh();
  }

  function saveProject() {
    const data = {
      app: 'bone-editor-project',
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      project,
    };
    downloadJson(project.name + '.bone.json', data);
    toast('项目已保存（含图片绑定、骨骼、动作与帧率）');
  }

  function openProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          const loaded = data.project || data;
          validateProject(loaded);
          project = loaded;
          app.project = project;
          globalHistory.clear();
          animHistories.clear();
          if (!project.animations.some((a) => a.id === project.activeAnimId)) {
            project.activeAnimId = project.animations[0] ? project.animations[0].id : null;
          }
          state.selection = null;
          state.frame = 0;
          refresh();
          toast('项目已恢复');
        } catch (err) {
          alert('打开失败：' + err.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function validateProject(p) {
    const need = ['bones', 'parts', 'ik', 'animations'];
    for (const k of need) {
      if (!Array.isArray(p[k])) throw new Error('缺少字段 ' + k);
    }
    if (!p.animations.length) throw new Error('项目没有任何动作');
  }

  function exportRuntime() {
    const runtime = {
      format: 'bone-runtime-anim',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      name: project.name,
      bones: project.bones.map((b) => ({
        id: b.id, name: b.name, parentId: b.parentId, rest: b.rest,
      })),
      parts: project.parts.filter((p) => p.visible).map((p) => ({
        id: p.id, name: p.name, boneId: p.boneId, shape: p.shape,
        offset: p.offset, fill: p.fill, stroke: p.stroke, opacity: p.opacity,
      })),
      images: project.images.map((img) => ({ id: img.id, name: img.name, src: img.src, width: img.width, height: img.height })),
      ik: project.ik.map((c) => ({
        id: c.id, name: c.name, rootBoneId: c.rootBoneId, midBoneId: c.midBoneId,
        effBoneId: c.effBoneId, enabled: c.enabled, bend: c.bend, target: c.target,
      })),
      animations: project.animations.map((a) => ({
        id: a.id, name: a.name, frameRate: a.frameRate,
        frameCount: a.frameCount, loop: a.loop,
        keys: a.keys, ikKeys: a.ikKeys,
      })),
    };
    downloadJson(project.name + '.runtime.json', runtime);
    toast('已导出游戏运行时数据');
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------- 轻提示 ---------------- */

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* ---------------- 导出给其他模块 ---------------- */

  Object.assign(app, {
    init, refresh, select, seek, togglePlay, undo, redo,
    addBone, addPart, deleteSelection, reparent, moveSibling, renameSelection,
    editBoneTransform, bindPart, setPartShapeType, setPartShapeNum, editPartOffset, setPartStyle,
    uploadImage, addIKConstraint, setIKEnabled, setIKBend, setIKTarget, addIKKeyAtCurrent,
    addKeyAtCurrent, deleteKeyAtCurrent, moveKey, beginKeyMove, commitKeyMove,
    setCurrentKeyEasing, updateAnimSettings,
    addAnimation, duplicateAnimation, deleteAnimation, switchAnimation,
    newProject, saveProject, openProject, exportRuntime,
  });

  global.App = app;
  document.addEventListener('DOMContentLoaded', init);
})(window);
