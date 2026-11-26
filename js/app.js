/* ============================================================
   灵动标题工坊 · 应用主控
   状态 / 动作 / 快捷键 / 播放循环 / 自动暂存 / 启动
   ============================================================ */
(function () {
  'use strict';
  const G = window.Gfx;
  const { h, clamp } = G.util;
  const M = G.Model;

  const App = {
    state: {
      project: null,
      time: 0,
      playing: false,
      loop: true,
      autoKey: true,
      snap: true,
      selection: [],
      selectedKey: null, // {layerId, prop, kfId}
    },
    history: G.createHistory(),
    _autosaveTimer: null,
    _lastTs: 0,
    _playStartWall: 0,

    /* ---------------- 启动 ---------------- */
    init() {
      const autosaved = G.Storage.loadAutosave();
      this.state.project = autosaved || G.buildSampleProject();

      G.UI.Stage.init();
      G.UI.Help.init();
      document.getElementById('btnUndo').innerHTML = G.icons.undo;
      document.getElementById('btnRedo').innerHTML = G.icons.redo;
      this.bindChrome();
      this.bindShortcuts();
      G.Renderer.setImagesChangedHandler(() => this.renderStage());

      this.history.onChange = () => this.updateUndoButtons();
      this.syncChrome();
      this.refreshAll();
      this.updateUndoButtons();

      // 播放循环：墙钟驱动，即使软件渲染掉帧，时间轴仍与真实时间一致
      const loop = () => {
        if (this.state.playing && this.state.project) {
          const p = this.state.project;
          const elapsed = (performance.now() - this._playStartWall) / 1000;
          let nt;
          if (this.state.loop) {
            nt = ((elapsed % p.duration) + p.duration) % p.duration;
          } else if (elapsed >= p.duration) {
            nt = p.duration;
            this.pause();
          } else {
            nt = elapsed;
          }
          this.state.time = nt;
          this.renderStage();
          G.UI.Timeline.updatePlayhead();
          this.updateTimecode();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);

      window.__APP_READY__ = true;
      document.dispatchEvent(new CustomEvent('app-ready'));
      // 调试 / 自动化钩子
      window.App = this;
    },

    /* ---------------- 渲染调度 ---------------- */
    refreshAll() {
      if (!this.state.project) return;
      G.UI.Layers.render();
      G.UI.Inspector.render();
      G.UI.Timeline.render();
      G.UI.Stage.fit();
      G.UI.Stage.render();
      this.syncChrome();
      this.updateTimecode();
      this.updateUndoButtons();
    },

    renderStage() {
      G.UI.Stage.render();
    },

    scheduleAutosave() {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = setTimeout(() => {
        if (this.state.project) G.Storage.autosave(this.state.project);
      }, 400);
    },

    /* ---------------- 历史 / 手势 ---------------- */
    commit(label, fn) {
      this.history.push(this.state.project);
      fn();
      this.afterChange();
    },

    afterChange() {
      this.refreshAll();
      this.scheduleAutosave();
    },

    editStart() {
      // 懒记录：仅当本次聚焦后真的发生修改，才把修改前状态压栈
      this.history.arm();
    },
    editLive(fn) {
      this.history.pushLazy(this.state.project);
      fn();
      G.UI.Stage.render();
      this.updateUndoButtons();
      this.scheduleAutosave();
    },
    editEnd() {
      this.history.endGesture();
      this.refreshAll();
      this.scheduleAutosave();
    },
    stageInteractionUpdate() {
      G.UI.Stage.render();
      G.UI.Inspector.render();
      this.scheduleAutosave();
    },
    endStageInteraction() {
      this.history.endGesture();
      this.refreshAll();
      this.scheduleAutosave();
    },
    afterTimelineGesture() {
      this.history.endGesture();
      this.refreshAll();
      this.scheduleAutosave();
    },

    undo() {
      const prev = this.history.undo(this.state.project);
      if (prev) {
        this.state.project = M.normalizeProject(prev);
        this.state.selection = this.state.selection.filter((id) => M.findById(this.state.project.children, id));
        this.state.selectedKey = null;
        this.refreshAll();
        this.scheduleAutosave();
        G.toast('已撤销');
      }
    },
    redo() {
      const next = this.history.redo(this.state.project);
      if (next) {
        this.state.project = M.normalizeProject(next);
        this.state.selectedKey = null;
        this.refreshAll();
        this.scheduleAutosave();
        G.toast('已重做');
      }
    },
    updateUndoButtons() {
      const u = document.getElementById('btnUndo');
      const r = document.getElementById('btnRedo');
      if (u) u.disabled = !this.history.canUndo();
      if (r) r.disabled = !this.history.canRedo();
    },

    /* ---------------- 时间 / 播放 ---------------- */
    setTime(t) {
      this.state.time = clamp(t, 0, this.state.project.duration);
      if (this.state.playing) this._playStartWall = performance.now() - this.state.time * 1000;
      G.UI.Stage.render();
      G.UI.Timeline.updatePlayhead();
      this.updateTimecode();
      G.UI.Inspector.render();
    },
    updateTimecode() {
      const el = document.getElementById('timecode');
      if (el && this.state.project) {
        el.textContent = `${G.util.formatTime(this.state.time)} / ${G.util.formatTime(this.state.project.duration)}`;
      }
    },
    play() {
      if (this.state.time >= this.state.project.duration - 1e-4) this.state.time = 0;
      this._playStartWall = performance.now() - this.state.time * 1000;
      this.state.playing = true;
      const b = document.getElementById('btnPlay');
      if (b) b.textContent = '⏸';
    },
    pause() {
      this.state.playing = false;
      const b = document.getElementById('btnPlay');
      if (b) b.textContent = '▶';
    },
    togglePlay() { this.state.playing ? this.pause() : this.play(); },

    /* ---------------- 选择 ---------------- */
    selectLayer(id, opts) {
      opts = opts || {};
      if (id == null) {
        this.state.selection = [];
      } else if (opts.additive) {
        const i = this.state.selection.indexOf(id);
        if (i >= 0) this.state.selection.splice(i, 1);
        else this.state.selection.push(id);
      } else if (opts.range) {
        const order = M.flatten(this.state.project.children).map((e) => e.layer.id);
        const anchor = this.state.selection[this.state.selection.length - 1] || order[0];
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [s, e2] = a < b ? [a, b] : [b, a];
          this.state.selection = order.slice(s, e2 + 1);
        }
      } else {
        this.state.selection = [id];
      }
      this.state.selectedKey = null;
      this.refreshAll();
    },

    selectKey(sk) {
      this.state.selectedKey = sk;
      G.UI.Inspector.render();
      document.querySelectorAll('.kf-diamond').forEach((d) => {
        d.classList.toggle('selected', !!sk && d.dataset.kfId === sk.kfId);
      });
    },

    /** 点击时间线关键帧：同时选中所属图层，但不重建时间线（避免打断拖拽） */
    focusKeyframe(sk, t) {
      if (t != null) this.state.time = t;
      this.state.selection = [sk.layerId];
      this.state.selectedKey = sk;
      G.UI.Inspector.render();
      G.UI.Layers.render();
      document.querySelectorAll('.kf-diamond').forEach((d) => {
        d.classList.toggle('selected', d.dataset.kfId === sk.kfId);
      });
    },

    selectedLayers() {
      return this.state.selection
        .map((id) => M.findById(this.state.project.children, id)?.layer)
        .filter(Boolean);
    },

    /* ---------------- 属性 / 关键帧写入 ---------------- */
    setPropValue(layerId, prop, value) {
      const project = this.state.project;
      const layer = M.findById(project.children, layerId)?.layer;
      if (!layer) return;
      const t = this.state.time;
      const keys = layer.keys[prop];
      const idx = M.kfAt(keys, t, project.fps);

      if (idx >= 0) {
        Object.assign(keys[idx], value);
        return;
      }

      if (this.state.autoKey || keys.length > 0) {
        // 以当前采样值为底，保证插入关键帧的瞬间数值连续，再覆盖本次修改
        const st = G.Interpolate.sampleLayer(layer, t);
        let base;
        if (prop === 'position') base = { x: st.x, y: st.y };
        else if (prop === 'scale') base = { sx: st.scaleX, sy: st.scaleY };
        else if (prop === 'size') base = { w: st.w, h: st.h };
        else if (prop === 'rotation') base = { v: st.rotation };
        else base = { v: st.opacity };

        const kf = M.makeKf(prop, G.util.snapTime(t, project.fps, this.state.snap),
          Object.assign(base, value), 'easeInOutCubic');
        keys.push(kf);
        keys.sort((a, b) => a.t - b.t);
        this.state.selectedKey = { layerId, prop, kfId: kf.id };
      } else {
        if (prop === 'position') { layer.x = value.x; layer.y = value.y; }
        else if (prop === 'scale') {
          if (value.sx != null) layer.scaleX = value.sx;
          if (value.sy != null) layer.scaleY = value.sy;
          if (layer.uniformScale && value.sx != null) layer.scaleY = value.sx;
        }
        else if (prop === 'size') { if (value.w != null) layer.w = value.w; if (value.h != null) layer.h = value.h; }
        else if (prop === 'rotation') layer.rotation = value.v;
        else if (prop === 'opacity') layer.opacity = value.v;
      }
    },

    toggleKeyframe(layerId, prop) {
      const project = this.state.project;
      const layer = M.findById(project.children, layerId)?.layer;
      if (!layer) return;
      this.commit('toggle-kf', () => {
        const keys = layer.keys[prop];
        const idx = M.kfAt(keys, this.state.time, project.fps);
        if (idx >= 0) {
          const removed = keys[idx];
          keys.splice(idx, 1);
          if (this.state.selectedKey && this.state.selectedKey.kfId === removed.id) {
            this.state.selectedKey = null;
          }
        } else {
          const st = G.Interpolate.sampleLayer(layer, this.state.time);
          let values;
          if (prop === 'position') values = { x: st.x, y: st.y };
          else if (prop === 'scale') values = { sx: st.scaleX, sy: st.scaleY };
          else if (prop === 'size') values = { w: st.w, h: st.h };
          else if (prop === 'rotation') values = { v: st.rotation };
          else values = { v: st.opacity };
          const kf = M.makeKf(prop,
            G.util.snapTime(this.state.time, project.fps, this.state.snap),
            values, 'easeInOutCubic');
          keys.push(kf);
          keys.sort((a, b) => a.t - b.t);
          this.state.selectedKey = { layerId, prop, kfId: kf.id };
        }
      });
    },

    addKeyframeAt(layerId, prop, t) {
      const layer = M.findById(this.state.project.children, layerId)?.layer;
      if (!layer) return;
      this.commit('add-kf', () => {
        const st = G.Interpolate.sampleLayer(layer, t);
        let values;
        if (prop === 'position') values = { x: st.x, y: st.y };
        else if (prop === 'scale') values = { sx: st.scaleX, sy: st.scaleY };
        else if (prop === 'size') values = { w: st.w, h: st.h };
        else if (prop === 'rotation') values = { v: st.rotation };
        else values = { v: st.opacity };
        // 若该时刻已有帧则不重复添加
        if (M.kfAt(layer.keys[prop], t, this.state.project.fps) >= 0) return;
        const kf = M.makeKf(prop, t, values, 'easeInOutCubic');
        layer.keys[prop].push(kf);
        layer.keys[prop].sort((a, b) => a.t - b.t);
        this.state.selectedKey = { layerId, prop, kfId: kf.id };
      });
    },

    moveKeyframe(layerId, prop, kfId, t) {
      const layer = M.findById(this.state.project.children, layerId)?.layer;
      const kf = layer?.keys[prop].find((k) => k.id === kfId);
      if (kf) kf.t = clamp(t, 0, this.state.project.duration);
    },

    deleteSelectedKey() {
      const sk = this.state.selectedKey;
      if (!sk) return;
      const layer = M.findById(this.state.project.children, sk.layerId)?.layer;
      if (layer) {
        const arr = layer.keys[sk.prop];
        const i = arr.findIndex((k) => k.id === sk.kfId);
        if (i >= 0) arr.splice(i, 1);
      }
      this.state.selectedKey = null;
    },

    /* ---------------- 图层操作 ---------------- */
    addLayer(type) {
      const p = this.state.project;
      let layer;
      if (type === 'text') layer = M.createTextLayer(p, {});
      else if (type === 'rect') layer = M.createRectLayer(p, {});
      else if (type === 'image') { this.triggerImageImport(null); return; }
      else return;

      this.history.push(p);
      p.children.unshift(layer);
      this.state.selection = [layer.id];
      this.state.selectedKey = null;
      this.afterChange();
      G.toast(`已添加${layer.name}`);
    },

    triggerImageImport(targetId) {
      this._imageTargetId = targetId || null;
      document.getElementById('imageFileInput').click();
    },
    chooseImageFor(id) { this.triggerImageImport(id); },

    async handleImageFile(file) {
      if (!file) return;
      try {
        const dataURL = await G.util.readFileAsDataURL(file);
        const img = await G.util.loadImage(dataURL);
        const p = this.state.project;

        if (this._imageTargetId) {
          const layer = M.findById(p.children, this._imageTargetId)?.layer;
          if (layer && layer.type === 'image') {
            this.commit('replace-image', () => {
              layer.src = dataURL;
              layer.imgW = img.naturalWidth;
              layer.imgH = img.naturalHeight;
            });
            G.toast('图片已替换并内嵌到工程');
          }
        } else {
          const s = Math.min(1, 560 / Math.max(img.naturalWidth, img.naturalHeight));
          const layer = M.createImageLayer(p, {
            src: dataURL,
            imgW: img.naturalWidth,
            imgH: img.naturalHeight,
            w: Math.max(40, Math.round(img.naturalWidth * s)),
            h: Math.max(40, Math.round(img.naturalHeight * s)),
            name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || '图片',
          });
          this.history.push(p);
          p.children.unshift(layer);
          this.state.selection = [layer.id];
          this.afterChange();
          G.toast('已添加本地图片');
        }
      } catch (err) {
        console.error(err);
        G.toast('图片读取失败：' + err.message, 'error');
      } finally {
        this._imageTargetId = null;
      }
    },

    deleteSelected() {
      if (!this.state.selection.length) return;
      this.commit('delete', () => {
        this.state.selection.forEach((id) => {
          const f = M.findById(this.state.project.children, id);
          if (f) f.siblings.splice(f.index, 1);
        });
        this.state.selection = [];
        this.state.selectedKey = null;
      });
    },

    _reidTree(node) {
      const clone = G.util.deepClone(node);
      const walk = (l) => {
        l.id = G.util.uid('ly');
        if (l.keys) {
          Object.keys(l.keys).forEach((k) => {
            (l.keys[k] || []).forEach((kf) => { kf.id = G.util.uid('kf'); });
          });
        }
        if (l.children) l.children.forEach(walk);
      };
      if (Array.isArray(clone)) clone.forEach(walk); else walk(clone);
      return clone;
    },

    duplicateSelected() {
      if (!this.state.selection.length) return;
      this.history.push(this.state.project);
      const newIds = [];
      // 从后往前插入以保持位置
      this.state.selection.forEach((id) => {
        const f = M.findById(this.state.project.children, id);
        if (!f) return;
        const copy = this._reidTree(f.layer);
        copy.name = f.layer.name + ' 副本';
        f.siblings.splice(f.index, 0, copy);
        newIds.push(copy.id);
      });
      this.state.selection = newIds;
      this.afterChange();
      G.toast('已复制图层');
    },

    groupSelected() {
      let ids = this.state.selection.slice();
      if (!ids.length) { G.toast('请先选择要编组的图层', 'error'); return; }
      this.history.push(this.state.project);
      const p = this.state.project;

      // 排除“祖先也被选中”的节点，避免嵌套混乱
      ids = ids.filter((id) => {
        const f = M.findById(p.children, id);
        if (!f) return false;
        for (const other of ids) {
          if (other === id) continue;
          const of = M.findById(p.children, other);
          if (of && of.layer.type === 'group' && M.isDescendant(of.layer, id)) return false;
        }
        return true;
      });

      const anchor = M.findById(p.children, ids[0]);
      if (!anchor) return;
      const group = M.createGroup('编组 ' + (p.children.filter((l) => l.type === 'group').length + 1));
      const moved = [];
      ids.forEach((id) => {
        const f = M.findById(p.children, id);
        if (f) {
          f.siblings.splice(f.index, 1);
          moved.push(f.layer);
        }
      });
      // 保持面板顺序
      moved.reverse();
      group.children = moved;
      anchor.siblings.splice(anchor.index, 0, group);
      this.state.selection = [group.id];
      this.afterChange();
      G.toast('已编组');
    },

    ungroupSelected() {
      const groups = this.selectedLayers().filter((l) => l.type === 'group');
      if (!groups.length) { G.toast('请先选中一个编组', 'error'); return; }
      this.history.push(this.state.project);
      const newSel = [];
      groups.forEach((g) => {
        const f = M.findById(this.state.project.children, g.id);
        if (!f) return;
        const kids = g.children.slice();
        f.siblings.splice(f.index, 1, ...kids);
        newSel.push(...kids.map((k) => k.id));
      });
      this.state.selection = newSel;
      this.afterChange();
      G.toast('已取消编组');
    },

    moveLayer(dragId, targetId, pos) {
      const p = this.state.project;
      const dragF = M.findById(p.children, dragId);
      if (!dragF) return;
      if (targetId) {
        if (dragId === targetId) return;
        if (dragF.layer.type === 'group' && M.isDescendant(dragF.layer, targetId)) {
          G.toast('不能把编组拖入它自己的子级', 'error');
          return;
        }
      }
      this.history.push(p);
      dragF.siblings.splice(dragF.index, 1);

      if (!targetId || pos === 'end') {
        p.children.push(dragF.layer);
      } else {
        const target = M.findById(p.children, targetId);
        if (!target) { p.children.push(dragF.layer); }
        else if (pos === 'into' && target.layer.type === 'group') {
          target.layer.children.push(dragF.layer);
          target.layer.collapsed = false;
        } else if (pos === 'before') {
          target.siblings.splice(target.index, 0, dragF.layer);
        } else {
          target.siblings.splice(target.index + 1, 0, dragF.layer);
        }
      }
      this.afterChange();
    },

    toggleVisible(id) {
      const l = M.findById(this.state.project.children, id)?.layer;
      if (!l) return;
      this.commit('visible', () => { l.visible = !l.visible; });
    },
    toggleLock(id) {
      const l = M.findById(this.state.project.children, id)?.layer;
      if (!l) return;
      this.commit('lock', () => { l.locked = !l.locked; });
    },
    toggleCollapse(id) {
      const l = M.findById(this.state.project.children, id)?.layer;
      if (!l || l.type !== 'group') return;
      l.collapsed = !l.collapsed;
      this.refreshAll();
    },
    renameLayer(id, name) {
      const l = M.findById(this.state.project.children, id)?.layer;
      if (!l) return;
      this.history.push(this.state.project);
      l.name = name;
      this.scheduleAutosave();
      this.updateUndoButtons();
    },

    /* ---------------- 工程级操作 ---------------- */
    loadProject(project, opts) {
      this.state.project = M.normalizeProject(project);
      this.state.time = 0;
      this.state.playing = false;
      this.state.selection = [];
      this.state.selectedKey = null;
      this.history.reset();
      G.Storage.autosave(this.state.project);
      this.syncChrome();
      this.refreshAll();
      if (opts && opts.toast) G.toast(opts.toast, 'success');
    },

    newProject() {
      this.loadProject(M.createDefaultProject());
      G.toast('已新建空白工程');
    },
    loadSample() {
      this.loadProject(G.buildSampleProject());
      G.toast('已载入示例工程：文字进场 · 形状转场 · 结尾停留', 'success', 3200);
    },

    async openProjectFile(file) {
      try {
        const project = await G.Storage.openFromFile(file);
        this.loadProject(project, { toast: '工程已打开，可继续编辑' });
      } catch (err) {
        console.error(err);
        G.toast('打开工程失败：' + err.message, 'error', 4000);
      }
    },

    applyOutputSize(w, h) {
      const p = this.state.project;
      w = Math.round(clamp(w || p.width, 64, 7680));
      h = Math.round(clamp(h || p.height, 64, 7680));
      if (w === p.width && h === p.height) return;
      this.history.push(p);
      const scale = document.getElementById('scaleWithCanvas')?.checked;
      if (scale) M.rescaleProject(p, w, h);
      else { p.width = w; p.height = h; }
      this.afterChange();
      G.toast(scale ? `输出尺寸已改为 ${w}×${h}，元素按比例换算` : `输出尺寸已改为 ${w}×${h}`);
    },

    /* ---------------- 顶部/工具栏绑定 ---------------- */
    bindChrome() {
      document.getElementById('btnNew').onclick = () => this.newProject();
      document.getElementById('btnSample').onclick = () => this.loadSample();
      document.getElementById('btnSave').onclick = () => {
        G.Storage.saveToFile(this.state.project);
        G.Storage.autosave(this.state.project);
        G.toast('工程已保存为 .mgs.json', 'success');
      };
      document.getElementById('btnOpen').onclick = () => document.getElementById('projectFileInput').click();
      document.getElementById('btnUndo').onclick = () => this.undo();
      document.getElementById('btnRedo').onclick = () => this.redo();

      document.getElementById('btnExportSeq').onclick = () => G.UI.ExportDialog.open('seq');
      document.getElementById('btnExportVideo').onclick = () => G.UI.ExportDialog.open('video');
      document.getElementById('exportClose').onclick = () => G.UI.ExportDialog.close();
      document.getElementById('exportModal').addEventListener('click', (e) => {
        if (e.target.id === 'exportModal') G.UI.ExportDialog.close();
      });

      document.getElementById('projectFileInput').addEventListener('change', (e) => {
        if (e.target.files[0]) this.openProjectFile(e.target.files[0]);
        e.target.value = '';
      });
      document.getElementById('imageFileInput').addEventListener('change', (e) => {
        if (e.target.files[0]) this.handleImageFile(e.target.files[0]);
        e.target.value = '';
      });

      document.querySelectorAll('[data-add]').forEach((b) => {
        b.addEventListener('click', () => this.addLayer(b.dataset.add));
      });
      document.getElementById('btnGroup').onclick = () => this.groupSelected();
      document.getElementById('btnUngroup').onclick = () => this.ungroupSelected();
      document.getElementById('btnDuplicate').onclick = () => this.duplicateSelected();
      document.getElementById('btnDelete').onclick = () => this.deleteSelected();

      document.getElementById('btnPlay').onclick = () => this.togglePlay();
      document.getElementById('btnStop').onclick = () => { this.pause(); this.setTime(0); };
      document.getElementById('btnLoop').onclick = (e) => {
        this.state.loop = !this.state.loop;
        e.currentTarget.classList.toggle('is-on', this.state.loop);
        e.currentTarget.setAttribute('aria-pressed', String(this.state.loop));
      };

      document.getElementById('autoKey').addEventListener('change', (e) => { this.state.autoKey = e.target.checked; });
      document.getElementById('snapFrames').addEventListener('change', (e) => { this.state.snap = e.target.checked; });

      document.getElementById('fpsInput').addEventListener('change', (e) => {
        const v = Math.round(clamp(parseFloat(e.target.value) || 30, 1, 120));
        this.commit('fps', () => { this.state.project.fps = v; });
      });
      document.getElementById('durationInput').addEventListener('change', (e) => {
        const v = clamp(parseFloat(e.target.value) || 6, 0.1, 600);
        this.commit('duration', () => {
          this.state.project.duration = v;
          this.state.project.children && M.flatten(this.state.project.children).forEach(({ layer }) => {
            if (layer.out > v) layer.out = v;
          });
          if (this.state.time > v) this.state.time = v;
        });
      });

      document.getElementById('projectName').addEventListener('input', (e) => {
        this.state.project.name = e.target.value;
        this.scheduleAutosave();
      });

      // 输出尺寸预设
      const preset = document.getElementById('sizePreset');
      M.SIZE_PRESETS.forEach((s) => {
        preset.appendChild(h('option', { value: `${s.w}x${s.h}` }, s.label));
      });
      preset.addEventListener('change', () => {
        const [w, h] = preset.value.split('x').map(Number);
        this.applyOutputSize(w, h);
      });
      const wI = document.getElementById('outWidth');
      const hI = document.getElementById('outHeight');
      const sizeChange = () => this.applyOutputSize(parseInt(wI.value, 10), parseInt(hI.value, 10));
      wI.addEventListener('change', sizeChange);
      hI.addEventListener('change', sizeChange);

      // 画布开关
      const bindToggle = (id, key, after) => {
        const b = document.getElementById(id);
        b.addEventListener('click', () => {
          this.state.project[key] = !this.state.project[key];
          b.classList.toggle('is-on', this.state.project[key]);
          b.setAttribute('aria-pressed', String(this.state.project[key]));
          if (after) after();
          this.scheduleAutosave();
        });
      };
      bindToggle('btnSafe', 'safeArea', () => G.UI.Stage.renderOverlay());
      bindToggle('btnThirds', 'thirds', () => G.UI.Stage.renderOverlay());
      bindToggle('btnChecker', 'checker', () => {
        document.getElementById('canvasFrame').classList.toggle('checker', this.state.project.checker);
      });

      document.getElementById('zoomTimeline').addEventListener('input', (e) => {
        G.UI.Timeline.setPPS(+e.target.value);
        G.UI.Timeline.render();
      });
    },

    syncChrome() {
      const p = this.state.project;
      if (!p) return;
      document.getElementById('projectName').value = p.name;
      document.getElementById('outWidth').value = p.width;
      document.getElementById('outHeight').value = p.height;
      document.getElementById('fpsInput').value = p.fps;
      document.getElementById('durationInput').value = p.duration;
      const preset = document.getElementById('sizePreset');
      const match = M.SIZE_PRESETS.find((s) => s.w === p.width && s.h === p.height);
      preset.value = match ? `${match.w}x${match.h}` : '';
      document.getElementById('btnSafe').classList.toggle('is-on', p.safeArea);
      document.getElementById('btnSafe').setAttribute('aria-pressed', String(p.safeArea));
      document.getElementById('btnThirds').classList.toggle('is-on', p.thirds);
      document.getElementById('btnThirds').setAttribute('aria-pressed', String(p.thirds));
      document.getElementById('btnChecker').classList.toggle('is-on', p.checker);
      document.getElementById('canvasFrame').classList.toggle('checker', p.checker);
      G.UI.Timeline.setPPS(+document.getElementById('zoomTimeline').value || 120);
    },

    /* ---------------- 快捷键 ---------------- */
    bindShortcuts() {
      document.addEventListener('keydown', (e) => {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        const mod = e.metaKey || e.ctrlKey;

        if (mod && e.key.toLowerCase() === 's') {
          e.preventDefault();
          G.Storage.saveToFile(this.state.project);
          G.Storage.autosave(this.state.project);
          G.toast('工程已保存为 .mgs.json', 'success');
          return;
        }
        if (mod && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          document.getElementById('projectFileInput').click();
          return;
        }
        if (mod && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
        if (mod && e.key.toLowerCase() === 'g') {
          e.preventDefault();
          if (e.shiftKey) this.ungroupSelected(); else this.groupSelected();
          return;
        }
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelected(); return; }

        if (typing) {
          if (e.key === 'Escape') t.blur();
          return;
        }

        if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          this.deleteSelected();
        }
      });
    },

    /* ---------------- 自动化/测试辅助 ---------------- */
    getExportOrder() {
      return M.paintList(this.state.project.children).map((e) => e.layer.name);
    },
  };

  G.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }
})();
