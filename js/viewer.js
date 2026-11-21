/*
 * 单个预览面板：画面、镜头转盘、直接切方向/短过渡、镜像补齐、
 * 锚点编辑、缺帧/缺方向报告、缩略图选帧。
 */
(function (root) {
  'use strict';

  const TRANSITION_MS = 260;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  class ViewerPanel {
    /**
     * @param opts.dataset   初始数据集
     * @param opts.tag       'A' | 'B'
     * @param opts.bus       同步总线（app.js 提供）
     * @param opts.clock     共享时钟 { getMs, setMs, getPlaying, setPlaying, getActionId, setActionId }
     */
    constructor(root, opts) {
      this.root = root;
      this.tag = opts.tag;
      this.bus = opts.bus;
      this.clock = opts.clock;
      this.dataset = opts.dataset;
      this.state = Object.assign({
        label: this.tag === 'A' ? '版本 A' : '版本 B',
        camera: 0,
        mirror: true,
        alignAnchors: true,
        transitionMode: 'snap', // snap | blend
        transitionMs: TRANSITION_MS,
        selectedFrameIndex: 0,
        showAnchor: true,
        showGroundShadow: true,
      }, opts.persisted || {});
      this.layerOld = null;
      this.transitionStart = -1;
      this.transitionFromAngle = -1;
      this.spriteCache = new Map();
      this.anchorDrag = null;
      this.buildDOM();
      this.bindEvents();
      this.refreshReport();
      this.refreshFilmstrip();
    }

    /* ---------------- DOM 结构 ---------------- */

    buildDOM() {
      this.root.innerHTML = '';
      const head = el('div', 'panel-head');
      head.appendChild(el('span', 'tag ' + (this.tag === 'A' ? 'a' : 'b'), this.tag));
      this.datasetSelect = el('select');
      for (const d of this.bus.listDatasets()) {
        const o = el('option', null, d.name);
        o.value = d.id;
        this.datasetSelect.appendChild(o);
      }
      this.datasetSelect.value = this.dataset.id;
      head.appendChild(this.datasetSelect);

      this.labelInput = el('input', 'label-input');
      this.labelInput.type = 'text';
      this.labelInput.value = this.state.label;
      head.appendChild(this.labelInput);
      head.appendChild(el('span', 'spacer'));

      this.mirrorChk = el('input');
      this.mirrorChk.type = 'checkbox';
      this.mirrorChk.checked = this.state.mirror;
      const ml = el('label', 'ctl');
      ml.append('镜像补齐 ', this.mirrorChk);
      head.appendChild(ml);

      this.exportBtn = el('button', 'exportBtn mini-btn', '导出此面板 JSON');
      head.appendChild(this.exportBtn);

      const body = el('div', 'panel-body');

      // 左列：舞台 + 时间轴 + 缩略图
      const stageCol = el('div', 'stage-col');
      const stageWrap = el('div', 'stage-wrap');
      this.canvas = el('canvas', 'stage');
      this.canvas.width = 520;
      this.canvas.height = 320;
      stageWrap.appendChild(this.canvas);
      const overlay = el('div', 'stage-overlay');
      this.pillLeft = el('div', 'badge-pill');
      this.pillRight = el('div', 'badge-pill');
      overlay.append(this.pillLeft, this.pillRight);
      stageWrap.appendChild(overlay);
      stageWrap.appendChild(el('div', 'stage-hint',
        '拖动改镜头角度 · Shift+拖动拖锚点（或直接拖锚点）'));
      stageCol.appendChild(stageWrap);

      const tl = el('div', 'timeline-row');
      this.progressInput = el('input');
      this.progressInput.type = 'range';
      this.progressInput.min = 0;
      this.progressInput.max = 1000;
      this.progressInput.value = 0;
      this.timeReadout = el('span', 'readout', '0.0ms');
      tl.append(this.progressInput, this.timeReadout);
      stageCol.appendChild(tl);

      this.filmstrip = el('div', 'filmstrip');
      stageCol.appendChild(this.filmstrip);
      body.appendChild(stageCol);

      // 右列：转盘 + 控制 + 报告
      const side = el('div', 'side-col');
      const dialBox = el('div', 'side-box');
      const dialWrap = el('div', 'dial-wrap');
      this.dial = this.buildDial();
      dialWrap.appendChild(this.dial);
      dialBox.appendChild(dialWrap);
      side.appendChild(dialBox);

      const ctlBox = el('div', 'side-box');
      ctlBox.appendChild(el('h3', null, '切换与锚点'));
      const modeRow = el('div', 'row');
      this.modeSnap = el('input'); this.modeSnap.type = 'radio';
      this.modeSnap.name = 'mode-' + this.tag; this.modeSnap.value = 'snap';
      this.modeBlend = el('input'); this.modeBlend.type = 'radio';
      this.modeBlend.name = 'mode-' + this.tag; this.modeBlend.value = 'blend';
      modeRow.append(this.modeSnap, el('span', null, '直接切'),
        this.modeBlend, el('span', null, '短过渡'));
      this.modeSnap.checked = this.state.transitionMode === 'snap';
      this.modeBlend.checked = this.state.transitionMode === 'blend';
      ctlBox.appendChild(modeRow);

      const alignRow = el('div', 'row');
      this.alignChk = el('input'); this.alignChk.type = 'checkbox';
      this.alignChk.checked = this.state.alignAnchors;
      alignRow.append(this.alignChk, el('span', null, '锚点对齐（防止地面跳位置）'));
      ctlBox.appendChild(alignRow);

      const anchorRow = el('div', 'row anchor-fields');
      this.axInput = el('input'); this.axInput.type = 'number';
      this.ayInput = el('input'); this.ayInput.type = 'number';
      this.frameNameOut = el('span', 'readout');
      anchorRow.append(el('span', null, '锚点 X'), this.axInput,
        el('span', null, 'Y'), this.ayInput);
      ctlBox.appendChild(anchorRow);
      const anchorRow2 = el('div', 'row');
      this.durInput = el('input'); this.durInput.type = 'number';
      this.durInput.min = 20; this.durInput.step = 20;
      anchorRow2.append(el('span', null, '停留 ms'), this.durInput, this.frameNameOut);
      ctlBox.appendChild(anchorRow2);
      const anchorRow3 = el('div', 'row');
      this.resetAnchorBtn = el('button', 'mini-btn', '重置该帧锚点');
      this.resetAllAnchorBtn = el('button', 'mini-btn', '重置全部锚点');
      anchorRow3.append(this.resetAnchorBtn, this.resetAllAnchorBtn);
      ctlBox.appendChild(anchorRow3);
      side.appendChild(ctlBox);

      const reportBox = el('div', 'side-box');
      reportBox.appendChild(el('h3', null, '素材缺口报告（按方向）'));
      this.reportEl = el('div', 'report');
      reportBox.appendChild(this.reportEl);
      side.appendChild(reportBox);

      body.appendChild(side);
      this.root.append(head, body);
    }

    buildDial() {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 170 170');
      svg.classList.add('dial');
      const cx = 85, cy = 85, R = 62;

      // 背景圆
      const bg = document.createElementNS(svgNS, 'circle');
      bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', R);
      bg.setAttribute('fill', '#0b1220'); bg.setAttribute('stroke', '#334155');
      svg.appendChild(bg);

      // 切换边界（淡线）
      this.dialBoundaryEls = [];
      for (const b of Angle.boundaries(this.dataset.directions)) {
        const rad = (b * Math.PI) / 180;
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', cx); line.setAttribute('y1', cy);
        line.setAttribute('x2', cx + Math.sin(rad) * R);
        line.setAttribute('y2', cy - Math.cos(rad) * R);
        line.setAttribute('stroke', '#1e3a5f');
        line.setAttribute('stroke-width', '1');
        line.dataset.angle = b;
        svg.appendChild(line);
        this.dialBoundaryEls.push(line);
      }

      // 方向刻度与标签
      this.dialDotEls = {};
      for (const d of this.dataset.directions) {
        const rad = (d.angle * Math.PI) / 180;
        const x = cx + Math.sin(rad) * (R - 13);
        const y = cy - Math.cos(rad) * (R - 13);
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 3);
        dot.setAttribute('fill', '#475569');
        svg.appendChild(dot);
        this.dialDotEls[d.id] = dot;

        const lx = cx + Math.sin(rad) * (R + 11);
        const ly = cy - Math.cos(rad) * (R + 11) + 3.5;
        const label = document.createElementNS(svgNS, 'text');
        label.setAttribute('x', lx); label.setAttribute('y', ly);
        label.setAttribute('fill', '#94a3b8');
        label.setAttribute('font-size', '10');
        label.setAttribute('text-anchor', 'middle');
        label.textContent = d.id;
        svg.appendChild(label);
      }

      // 镜头指针
      this.needle = document.createElementNS(svgNS, 'polygon');
      this.needle.setAttribute('fill', '#38bdf8');
      svg.appendChild(this.needle);
      const hub = document.createElementNS(svgNS, 'circle');
      hub.setAttribute('cx', cx); hub.setAttribute('cy', cy); hub.setAttribute('r', 5);
      hub.setAttribute('fill', '#38bdf8');
      svg.appendChild(hub);

      this.dialCx = cx; this.dialCy = cy; this.dialR = R;
      return svg;
    }

    /* ---------------- 事件 ---------------- */

    bindEvents() {
      this.datasetSelect.addEventListener('change', () => {
        this.setDataset(this.bus.getDatasetById(this.datasetSelect.value));
      });
      this.labelInput.addEventListener('input', () => {
        this.state.label = this.labelInput.value || this.tag;
        this.persist();
      });
      this.mirrorChk.addEventListener('change', () => {
        this.state.mirror = this.mirrorChk.checked;
        this.spriteCache.clear();
        this.refreshReport();
        this.refreshFilmstrip();
        this.persist();
      });
      this.exportBtn.addEventListener('click', () => this.bus.exportPanel(this));
      this.modeSnap.addEventListener('change', () => this.setMode('snap'));
      this.modeBlend.addEventListener('change', () => this.setMode('blend'));
      this.alignChk.addEventListener('change', () => {
        this.state.alignAnchors = this.alignChk.checked;
        this.persist();
      });
      this.resetAnchorBtn.addEventListener('click', () => this.resetSelectedAnchor());
      this.resetAllAnchorBtn.addEventListener('click', () => this.resetAllAnchors());
      this.axInput.addEventListener('change', () => this.setAnchor(+this.axInput.value, null));
      this.ayInput.addEventListener('change', () => this.setAnchor(null, +this.ayInput.value));
      this.durInput.addEventListener('change', () => this.setDuration(+this.durInput.value));
      this.progressInput.addEventListener('input', () => {
        const ms = (+this.progressInput.value / 1000) * this.currentCycleDuration();
        this.clock.setMs(this.tag, ms);
      });

      this.attachAngleDrag(this.canvas, false);
      this.attachAngleDrag(this.dial, true);
      this.canvas.addEventListener('pointerdown', (e) => this.onStagePointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onStagePointerMove(e));
      window.addEventListener('pointerup', () => { this.anchorDrag = null; });
    }

    attachAngleDrag(node, polar) {
      // 镜头角度约定：0°=北、顺时针。屏幕坐标 y 向下，
      // 故 angle = atan2(dx, -dy)，东=90°、南=180°、西=270°。
      const polarAngle = (e) => {
        const r = node.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        return Angle.norm(Math.atan2(dx, -dy) * 180 / Math.PI);
      };
      if (polar) {
        // 转盘模式：指针相对圆心的方位角就是镜头角度
        node.addEventListener('pointerdown', (e) => {
          if (!e.shiftKey) this.setCamera(polarAngle(e), true);
        });
        node.addEventListener('pointermove', (e) => {
          if (e.buttons && !e.shiftKey) this.setCamera(polarAngle(e), true);
        });
        return;
      }
      let dragging = false;
      let startX = 0;
      let startAngle = 0;
      const onDown = (e) => {
        if (e.shiftKey) return; // Shift 留给锚点拖动
        dragging = true;
        startX = e.clientX;
        startAngle = this.state.camera;
      };
      const onMove = (e) => {
        if (!dragging) return;
        const next = Angle.norm(startAngle + (e.clientX - startX) * 1.5);
        this.setCamera(next, true);
      };
      const onUp = () => { dragging = false; };
      node.addEventListener('pointerdown', onDown);
      // 拖出元素后仍要继续跟手，用 window 级监听而不是 setPointerCapture
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    onStagePointerDown(e) {
      if (!e.shiftKey) return;
      const f = this.currentFrameInfo();
      if (!f) return;
      const p = this.stagePoint(e);
      const anchorScreen = this.anchorScreenPos(f);
      if (Math.hypot(p.x - anchorScreen.x, p.y - anchorScreen.y) < 14) {
        this.anchorDrag = { frame: f.frame, pointerId: e.pointerId };
        this.canvas.setPointerCapture(e.pointerId);
      }
    }

    onStagePointerMove(e) {
      if (!this.anchorDrag) return;
      const p = this.stagePoint(e);
      const g = this.stageGeometry();
      const d = this.dataset.defaultAnchor;
      // anchorScreenPos 的逆运算，两种对齐模式下都与标记位置自洽
      const ax = d.x + (g.groundX - p.x) / g.scale;
      const ay = d.y + (g.groundY - p.y) / g.scale;
      this.setAnchor(ax, ay);
    }

    stagePoint(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (this.canvas.width / r.width),
               y: (e.clientY - r.top) * (this.canvas.height / r.height) };
    }

    /* ---------------- 对外状态切换 ---------------- */

    setMode(mode) {
      this.state.transitionMode = mode;
      this.modeSnap.checked = mode === 'snap';
      this.modeBlend.checked = mode === 'blend';
      this.persist();
    }

    setDataset(dataset) {
      this.dataset = dataset;
      this.datasetSelect.value = dataset.id;
      this.layerOld = null;
      this.transitionStart = -1;
      this.spriteCache.clear();
      this.state.selectedFrameIndex = 0;
      this.refreshReport();
      this.refreshFilmstrip();
      this.persist();
    }

    setCamera(angle, fromUser) {
      angle = Angle.norm(angle);
      if (angle === this.state.camera) return;
      if (this.state.transitionMode === 'blend' && this.layerOld === null) {
        // 记录过渡前那一层，短过渡期间保持显示旧角度素材并淡出
        this.layerOld = this.snapshotLayer();
        this.transitionStart = performance.now();
        this.transitionFromAngle = this.state.camera;
      }
      this.state.camera = angle;
      this.refreshFilmstrip();
      this.persist();
      if (fromUser) this.bus.emit(this.tag, 'camera', angle);
    }

    /** 同步总线推来的外部角度 */
    receiveCamera(angle) {
      this.setCamera(Angle.norm(angle), false);
    }

    setAnchor(x, y) {
      const f = this.currentFrameInfo();
      if (!f) return;
      if (x != null) f.frame.anchorX = Math.round(x);
      if (y != null) f.frame.anchorY = Math.round(y);
      this.updateAnchorInputs(this.currentFrameInfo());
      this.spriteCache.clear();
      this.refreshFilmstrip();
      this.persist();
    }

    setDuration(ms) {
      const f = this.currentFrameInfo();
      if (!f || !(ms >= 20)) return;
      f.frame.duration = Math.round(ms);
      this.durInput.value = f.frame.duration;
      this.refreshFilmstrip();
      this.persist();
    }

    resetSelectedAnchor() {
      const f = this.currentFrameInfo();
      if (!f) return;
      f.frame.anchorX = this.dataset.defaultAnchor.x;
      f.frame.anchorY = this.dataset.defaultAnchor.y;
      this.setAnchor(f.frame.anchorX, f.frame.anchorY);
    }

    resetAllAnchors() {
      for (const seq of Object.values(this.dataset.sequences)) {
        for (const frame of seq.frames) {
          frame.anchorX = this.dataset.defaultAnchor.x;
          frame.anchorY = this.dataset.defaultAnchor.y;
        }
      }
      this.spriteCache.clear();
      this.refreshFilmstrip();
      this.updateAnchorInputs(this.currentFrameInfo());
      this.persist();
    }

    persist() {
      this.bus.persistPanel(this.tag, this.dataset.id, this.state, this.dataset);
    }

    /* ---------------- 渲染数据解析 ---------------- */

    currentActionId() {
      return this.clock.getActionId();
    }

    currentCycleDuration() {
      const r = Angle.resolve(this.dataset, this.state.camera, this.currentActionId(),
        this.state.mirror, 0);
      return r.cycleDuration || 1000;
    }

    currentProgress() {
      const cycle = this.currentCycleDuration();
      return (this.clock.getMs() % cycle) / cycle;
    }

    currentFrameInfo() {
      const r = Angle.resolve(this.dataset, this.state.camera, this.currentActionId(),
        this.state.mirror, this.currentProgress());
      return r.unresolved ? null : r;
    }

    stageGeometry() {
      const scale = Math.min(
        (this.canvas.width - 80) / this.dataset.frameWidth,
        (this.canvas.height - 70) / this.dataset.frameHeight
      );
      return {
        scale,
        groundX: this.canvas.width / 2,                 // 脚底锚点统一钉在画面中心
        groundY: this.canvas.height - 34,
      };
    }

    /** 角色脚底锚点在舞台上的实际像素位置（与 drawLayer 的落点保持一致） */
    anchorScreenPos(info) {
      const g = this.stageGeometry();
      const frame = info.frame;
      if (this.state.alignAnchors) {
        // 对齐模式：任何帧的脚底都钉在同一地面点
        return { x: g.groundX, y: g.groundY };
      }
      // 非对齐：角色按默认锚点摆放，帧自身锚点的实际屏幕位置随锚点漂移
      return {
        x: g.groundX + (this.dataset.defaultAnchor.x - frame.anchorX) * g.scale,
        y: g.groundY + (this.dataset.defaultAnchor.y - frame.anchorY) * g.scale,
      };
    }

    /** 判断某个解析结果中的帧是否需要镜像绘制 */
    isMirrored(info) {
      if (info.substitute && info.substitute.mirrored) return true;
      // 缩略图路径：序列方向与当前镜头方向不一致即说明来自替代序列
      const dir = Angle.selectDirection(this.dataset.directions, this.state.camera);
      return !!(dir && info.sequence.directionId !== dir.id);
    }

    /** 取帧图（程序化生成或真实图片），按 帧id+镜像 缓存 */
    getSprite(frame, info) {
      const mirrored = this.isMirrored(info);
      const key = frame.id + '|' + mirrored;
      if (this.spriteCache.has(key)) return this.spriteCache.get(key);
      let canvas;
      if (frame.source && frame.source.startsWith('proc://')) {
        const dir = this.dataset.directions.find((d) => d.id === info.sequence.directionId);
        canvas = Sprites.toCanvas({
          angle: dir.angle,
          actionId: info.sequence.actionId,
          phase: frame.phase != null ? frame.phase : 0,
          palette: this.dataset.palette || {
            body: '#0f766e', bodyBack: '#115e59', hood: '#0d9488', pants: '#334155',
            shoe: '#111827', skin: '#e8b890', glove: '#dc2626', arrow: '#0d9488',
          },
          label: dir.id,
          badgeText: info.sequence.frames.indexOf(frame) >= 0
            ? String(info.sequence.frames.indexOf(frame) + 1) : '',
        });
      } else if (frame.source) {
        canvas = this.bus.loadImageCanvas(frame.source, this.dataset.frameWidth, this.dataset.frameHeight);
      } else {
        canvas = this.placeholderCanvas(frame);
      }
      const sprite = { canvas, mirrored };
      this.spriteCache.set(key, sprite);
      if (this.spriteCache.size > 240) {
        this.spriteCache.delete(this.spriteCache.keys().next().value);
      }
      return sprite;
    }

    placeholderCanvas(frame) {
      const c = document.createElement('canvas');
      c.width = this.dataset.frameWidth; c.height = this.dataset.frameHeight;
      const ctx = c.getContext('2d');
      ctx.strokeStyle = '#f87171';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
      ctx.setLineDash([]);
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('缺图', c.width / 2, c.height / 2 - 6);
      ctx.font = '10px sans-serif';
      ctx.fillText(frame.id || '', c.width / 2, c.height / 2 + 14);
      return c;
    }

    snapshotLayer() {
      const info = this.currentFrameInfo();
      if (!info) return null;
      return { info, sprite: this.getSprite(info.frame, info) };
    }

    /* ---------------- 每帧绘制 ---------------- */

    render(now) {
      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const g = this.stageGeometry();

      // 地面参考线与固定阴影（不随素材锚点变化，直接暴露“跳位置”）
      ctx.strokeStyle = 'rgba(148,163,184,.35)';
      ctx.beginPath();
      ctx.moveTo(0, g.groundY); ctx.lineTo(this.canvas.width, g.groundY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath();
      ctx.ellipse(g.groundX, g.groundY + 5, 26, 7, 0, 0, 7);
      ctx.fill();

      const info = this.currentFrameInfo();
      let transitAlpha = 1;

      // 短过渡：旧角度层淡出，新角度层淡入；两层锚点都钉在同一地面点
      if (this.layerOld && this.state.transitionMode === 'blend') {
        const t = Math.min(1, (now - this.transitionStart) / this.state.transitionMs);
        transitAlpha = t;
        this.drawLayer(this.layerOld.info, this.layerOld.sprite, g, 1 - t);
        if (t >= 1) this.layerOld = null;
      }

      if (!info) {
        this.drawUnresolved(ctx, g);
      } else {
        const sprite = this.getSprite(info.frame, info);
        this.drawLayer(info, sprite, g, transitAlpha);
        if (this.state.showAnchor) this.drawAnchorMarker(info, g);
      }

      this.updatePills(info);
      this.updateNeedle();
      this.updateTimeline();
      this.updateAnchorInputs(info);
      this.highlightThumb();
    }

    drawLayer(info, sprite, g, alpha) {
      const ctx = this.canvas.getContext('2d');
      const frame = info.frame;
      const mirrored = sprite.mirrored;
      ctx.save();
      ctx.globalAlpha = alpha;
      let dx, dy;
      if (this.state.alignAnchors) {
        // 锚点对齐：无论素材自身锚点在哪，脚底都落在同一地面点
        dx = g.groundX - g.scale * frame.anchorX;
        dy = g.groundY - g.scale * frame.anchorY;
      } else {
        dx = g.groundX - g.scale * this.dataset.defaultAnchor.x;
        dy = g.groundY - g.scale * this.dataset.defaultAnchor.y;
      }
      ctx.translate(dx, dy);
      ctx.scale(g.scale, g.scale);
      if (mirrored) {
        // 镜像围绕该帧锚点翻转，锚点位置保持不动
        ctx.translate(frame.anchorX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-frame.anchorX, 0);
      }
      ctx.drawImage(sprite.canvas, 0, 0);
      ctx.restore();
    }

    drawAnchorMarker(info, g) {
      const ctx = this.canvas.getContext('2d');
      const p = this.anchorScreenPos(info);
      ctx.strokeStyle = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y);
      ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill();
    }

    drawUnresolved(ctx, g) {
      const dir = Angle.selectDirection(this.dataset.directions, this.state.camera);
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('该朝向无可用素材', g.groundX, g.groundY - 60);
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        dir ? `方向 ${dir.id}（${dir.name} ${dir.angle}°）· ${this.state.mirror ? '镜像也无来源' : '镜像补齐已关闭'}`
             : '无方向定义',
        g.groundX, g.groundY - 34);
    }

    updatePills(info) {
      const dir = Angle.selectDirection(this.dataset.directions, this.state.camera);
      const left = [];
      if (dir) left.push(`${dir.id} ${dir.angle}°`);
      left.push(`${Math.round(this.state.camera)}°`);
      this.pillLeft.textContent = left.join(' · ');
      this.pillLeft.className = 'badge-pill';

      const parts = [];
      let cls = 'badge-pill';
      if (!info) {
        parts.push('无素材');
        cls += ' unresolved';
      } else {
        parts.push(`帧 ${info.frameIndex + 1}/${info.sequence.frames.length}`);
        if (info.held) { parts.push('沿用前帧'); cls += ' held'; }
        if (info.substitute) {
          parts.push(`镜像替代 ← ${info.substitute.sourceDirectionId}`);
          cls += ' subst';
        }
        if (this.layerOld) { parts.push('过渡中'); cls += ' transit'; }
      }
      this.pillRight.textContent = parts.join(' · ');
      this.pillRight.className = cls;
    }

    updateNeedle() {
      const rad = (this.state.camera * Math.PI) / 180;
      const cx = this.dialCx, cy = this.dialCy, R = this.dialR - 4;
      const tx = cx + Math.sin(rad) * R;
      const ty = cy - Math.cos(rad) * R;
      const base = Math.atan2(ty - cy, tx - cx);
      const w = 7;
      const bx = cx + Math.sin(rad) * 10;
      const by = cy - Math.cos(rad) * 10;
      const p1 = `${tx},${ty}`;
      const p2 = `${bx - w * Math.cos(base - 0.5)},${by - w * Math.sin(base - 0.5)}`;
      const p3 = `${bx - w * Math.cos(base + 0.5)},${by + w * Math.sin(base + 0.5)}`;
      this.needle.setAttribute('points', `${p1} ${p2} ${p3}`);

      const currentId = Angle.selectDirection(this.dataset.directions, this.state.camera)?.id;
      for (const [id, dot] of Object.entries(this.dialDotEls)) {
        dot.setAttribute('fill', id === currentId ? '#38bdf8' : '#475569');
        dot.setAttribute('r', id === currentId ? 4.5 : 3);
      }
      // 镜头落在切换边界 ±2° 内时高亮该边界
      for (const line of this.dialBoundaryEls) {
        const b = +line.dataset.angle;
        const near = Angle.circularDistance(b, this.state.camera) <= 2;
        line.setAttribute('stroke', near ? '#f59e0b' : '#1e3a5f');
        line.setAttribute('stroke-width', near ? 2 : 1);
      }
    }

    updateTimeline() {
      const cycle = this.currentCycleDuration();
      const ms = this.clock.getMs() % cycle;
      if (document.activeElement !== this.progressInput) {
        this.progressInput.value = Math.round((ms / cycle) * 1000);
      }
      this.timeReadout.textContent = `${ms.toFixed(1)} / ${cycle.toFixed(0)} ms`;
    }

    updateAnchorInputs(info) {
      if (!info) {
        this.axInput.value = ''; this.ayInput.value = '';
        this.durInput.value = ''; this.frameNameOut.textContent = '';
        return;
      }
      const f = info.frame;
      if (document.activeElement !== this.axInput) this.axInput.value = f.anchorX;
      if (document.activeElement !== this.ayInput) this.ayInput.value = f.anchorY;
      if (document.activeElement !== this.durInput) this.durInput.value = f.duration;
      this.frameNameOut.textContent = f.id;
    }

    /* ---------------- 缩略图与报告 ---------------- */

    refreshFilmstrip() {
      this.filmstrip.innerHTML = '';
      const dir = Angle.selectDirection(this.dataset.directions, this.state.camera);
      if (!dir) return;
      const seq = this.dataset.sequences[Angle.sequenceKey(this.currentActionId(), dir.id)];
      // 镜像补齐时缩略图直接展示替代序列
      const info = this.currentFrameInfo();
      const frames = info ? info.sequence.frames : (seq ? seq.frames : []);
      frames.forEach((frame, i) => {
        const thumb = el('div', 'thumb' + (frame.missing ? ' missing' : ''));
        if (!frame.missing) {
          const fakeInfo = info || {
            sequence: { actionId: this.currentActionId(), directionId: dir.id, frames },
            substitute: null,
          };
          const sprite = this.getSprite(frame, fakeInfo);
          const c = document.createElement('canvas');
          c.width = this.dataset.frameWidth; c.height = this.dataset.frameHeight;
          c.getContext('2d').drawImage(sprite.canvas, 0, 0);
          c.style.height = '58px';
          c.style.width = 'auto';
          thumb.appendChild(c);
        } else {
          const x = el('div', 'miss-x', '×');
          thumb.appendChild(x);
        }
        const meta = el('div', 'meta',
          `#${i + 1} ${frame.missing ? '缺' : frame.duration + 'ms'}`);
        thumb.appendChild(meta);
        thumb.addEventListener('click', () => {
          this.state.selectedFrameIndex = i;
          // 跳到该帧在周期中的起始时刻
          let t = 0;
          for (let k = 0; k < i; k++) t += frames[k].duration;
          this.clock.setMs(this.tag, t);
          this.highlightThumb();
          this.persist();
        });
        thumb.dataset.index = i;
        this.filmstrip.appendChild(thumb);
      });
    }

    highlightThumb() {
      const info = this.currentFrameInfo();
      const idx = info ? info.frameIndex : -1;
      [...this.filmstrip.children].forEach((c) =>
        c.classList.toggle('active', +c.dataset.index === idx));
    }

    refreshReport() {
      const report = Angle.audit(this.dataset, this.state.mirror);
      this.reportEl.innerHTML = '';
      if (!report.length) {
        const ok = el('div', 'item ok', '✓ 所有方向与帧齐全');
        this.reportEl.appendChild(ok);
        return;
      }
      const dirName = (id) => {
        const d = this.dataset.directions.find((x) => x.id === id);
        return d ? `${d.id}（${d.name}）` : id;
      };
      const actionName = (id) => {
        const a = this.dataset.actions.find((x) => x.id === id);
        return a ? a.name : id;
      };
      for (const r of report) {
        const item = el('div', 'item ' + (r.type === 'frame' ? 'frame' : 'dir'));
        if (r.type === 'frame') {
          item.textContent = `▴ ${actionName(r.actionId)} / ${dirName(r.directionId)}：第 ${r.indexes.map((i) => i + 1).join('、')} 帧缺失（运行时沿用前帧）`;
        } else if (r.mirrorSource) {
          const s = el('span', 'sub',
            `⇋ ${actionName(r.actionId)} / ${dirName(r.directionId)}：缺方向，由 ${dirName(r.mirrorSource)} 镜像补齐`);
          item.appendChild(s);
        } else {
          const note = this.state.mirror ? '无可用镜像来源' : '镜像补齐已关闭';
          item.appendChild(el('span', null,
            `✗ ${actionName(r.actionId)} / ${dirName(r.directionId)}：`));
          item.appendChild(el('span', 'mirror-off', note));
        }
        this.reportEl.appendChild(item);
      }
    }
  }

  root.ViewerPanel = ViewerPanel;
})(typeof self !== 'undefined' ? self : this);
