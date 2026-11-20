import type { Evaluation, Project } from '../core/types.js';
import { EditorApp } from './state.js';
import { Renderer } from '../webgl/renderer.js';
import { distanceToRay, intersectPlaneY, clampOrbit, type DragState } from './picking.js';
import { renderGuides } from './guides.js';
import { showToast } from './toast.js';
import { normalizeProject, ProjectValidationError } from '../core/project.js';
import { buildExportPayload } from '../core/evaluate.js';
import { defaultProject, SAMPLES } from '../samples/index.js';
import type { Vec3 } from '../math/vec3.js';
import { button, downloadText, el, formatNumber, formatTime, safeFileStem } from './dom.js';
import { buildLeftPanel } from './panel-left.js';
import { buildRightPanel } from './panel-right.js';
import { buildTransport } from './transport.js';
import { buildTimelinePanel } from './timeline-panel.js';
import type { UiRefs } from './ui-types.js';

export class CameraPathEditorUi {
  readonly app: EditorApp;
  readonly renderer: Renderer;
  readonly refs: Partial<UiRefs> = {};
  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private hud: HTMLElement;
  private drag: DragState | null = null;
  private orbitDrag: { x: number; y: number; button: number } | null = null;
  private lastFrameTime = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private needsRender = true;
  private screenshotMode: 'preview' | 'clean' | null = null;
  private lastTimeText = '';
  private editSnapshot: { label: string; before: string } | null = null;

  constructor(project?: Project) {
    this.app = new EditorApp(project ?? defaultProject());
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.overlay = document.getElementById('viewport-overlay') as HTMLElement;
    this.hud = document.getElementById('viewport-hud') as HTMLElement;
    this.renderer = new Renderer(this.canvas);
    this.bindCanvasEvents();
    this.bindKeyboard();
    this.app.history.push('初始状态', this.app.project);
    this.buildChrome();
    this.resizeObserver = new ResizeObserver(() => {
      this.renderer.resize();
      this.needsRender = true;
    });
    const viewport = document.getElementById('viewport');
    if (viewport) this.resizeObserver.observe(viewport);
    this.renderer.resize();
    requestAnimationFrame(this.loop);
    this.refreshAll();
  }

  private get uiRefs(): UiRefs {
    return this.refs as UiRefs;
  }

  get disposedFlag(): boolean {
    return this.disposed;
  }

  /**
   * Starts a live edit (drag on canvas or timeline). The snapshot taken here is
   * what undo restores, so continuous drags collapse into a single history step.
   */
  beginEdit(label: string): void {
    if (this.editSnapshot) return;
    this.editSnapshot = { label, before: JSON.stringify(this.app.project) };
  }

  /** Ends a live edit and records it in history if anything actually changed. */
  commitEdit(opts: { refresh?: boolean } = {}): void {
    const pending = this.editSnapshot;
    this.editSnapshot = null;
    if (!pending) return;
    const after = JSON.stringify(this.app.project);
    if (pending.before !== after) {
      this.app.history.push(pending.label, JSON.parse(pending.before) as Project);
      this.app.markDirty();
    }
    if (opts.refresh !== false) this.refreshAll();
  }

  cancelEdit(): void {
    this.editSnapshot = null;
  }

  get isEditing(): boolean {
    return this.editSnapshot !== null;
  }

  /** Schedules a redraw (used by panels after direct state tweaks). */
  needsRenderNow(): void {
    this.needsRender = true;
  }

  /** Re-renders composition guides only. */
  guidesDirty(): void {
    this.layoutOverlay();
    this.needsRender = true;
  }

  // ------------------------------------------------------------------ chrome

  private buildChrome(): void {
    this.buildTopbar();
    buildLeftPanel(this, this.uiRefs);
    buildRightPanel(this, this.uiRefs);
    buildTransport(this, this.uiRefs);
    buildTimelinePanel(this, this.uiRefs);
    this.buildViewportToolbar();
  }

  private buildTopbar(): void {
    const host = document.getElementById('topbar-actions');
    if (!host) return;
    host.replaceChildren(
      this.buildSampleDropdown(),
      button('打开项目', () => this.openProjectFile(), { class: 'btn', title: '打开项目 (Cmd/Ctrl+O)' }),
      button('保存项目', () => this.saveProject(), { class: 'btn', title: '保存项目 (Cmd/Ctrl+S)' }),
      el('span', { class: 'topbar-divider' }),
      this.buildExportDropdown(),
      el('span', { class: 'topbar-divider' }),
    );

    const undoBtn = button('↶ 撤销', () => this.undo(), { class: 'btn is-ghost', title: '撤销 (Cmd/Ctrl+Z)' });
    const redoBtn = button('↷ 重做', () => this.redo(), { class: 'btn is-ghost', title: '重做 (Shift+Cmd/Ctrl+Z)' });
    this.refs.undoButton = undoBtn;
    this.refs.redoButton = redoBtn;
    host.append(undoBtn, redoBtn, button('帮助', () => this.showHelp(), { class: 'btn is-ghost' }));
  }

  private buildSampleDropdown(): HTMLElement {
    const wrap = el('div', { class: 'dropdown' });
    const trigger = button('示例路线 ▾', () => {
      wrap.classList.toggle('is-open');
    }, { class: 'btn', title: '载入内置示例路线' });
    const menu = el('div', { class: 'dropdown-menu' });
    for (const sample of SAMPLES) {
      const item = el('button', { class: 'dropdown-item', type: 'button' }, [
        el('strong', { text: sample.name }),
        el('span', { text: sample.description }),
      ]);
      item.addEventListener('click', () => {
        wrap.classList.remove('is-open');
        this.loadSample(sample.id);
      });
      menu.append(item);
    }
    wrap.append(trigger, menu);
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target as Node)) wrap.classList.remove('is-open');
    });
    return wrap;
  }

  private buildExportDropdown(): HTMLElement {
    const wrap = el('div', { class: 'dropdown' });
    const trigger = button('导出 ▾', () => {
      wrap.classList.toggle('is-open');
    }, { class: 'btn is-primary' });
    const menu = el('div', { class: 'dropdown-menu' });
    const entries: Array<{ label: string; desc: string; action: () => void }> = [
      { label: '相机采样 JSON', desc: '逐帧位置 + 四元数 + 焦距，游戏可直接读取', action: () => this.exportSamplesJson() },
      { label: '相机采样 CSV', desc: '逐帧表格，方便导入 DCC / 表格工具', action: () => this.exportSamplesCsv() },
      { label: '当前构图截图 PNG', desc: '仅场景画面，不含安全框与辅助线', action: () => this.exportScreenshot() },
      { label: '项目文件 JSON', desc: '完整工程（路径 / 时间线 / 物体 / 构图）', action: () => this.saveProject() },
    ];
    for (const entry of entries) {
      const item = el('button', { class: 'dropdown-item', type: 'button' }, [
        el('strong', { text: entry.label }),
        el('span', { text: entry.desc }),
      ]);
      item.addEventListener('click', () => {
        wrap.classList.remove('is-open');
        entry.action();
      });
      menu.append(item);
    }
    wrap.append(trigger, menu);
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target as Node)) wrap.classList.remove('is-open');
    });
    return wrap;
  }

  private buildViewportToolbar(): void {
    const host = document.getElementById('viewport-toolbar');
    if (!host) return;
    const viewToggle = button('⬒', () => this.toggleViewMode(), {
      class: 'tool-btn',
      title: '切换视角 (V)：轨道视图 / 相机视图',
    });
    const gridToggle = button('▦', () => this.toggleGrid(), { class: 'tool-btn', title: '显示/隐藏地面网格 (G)' });
    const frustumToggle = button('⌂', () => this.toggleFrustum(), { class: 'tool-btn', title: '显示/隐藏相机取景框 (F)' });
    const frameBtn = button('⤢', () => this.frameAll(), { class: 'tool-btn', title: '框选全部路径 (A)' });
    host.replaceChildren(viewToggle, gridToggle, frustumToggle, frameBtn);
    this.refs.viewToggle = viewToggle;
    this.refs.gridToggle = gridToggle;
    this.refs.frustumToggle = frustumToggle;
    this.syncToolbar();
  }

  private syncToolbar(): void {
    this.refs.viewToggle?.classList.toggle('is-active', this.app.viewMode === 'camera');
    this.refs.gridToggle?.classList.toggle('is-active', this.app.showGrid);
    this.refs.frustumToggle?.classList.toggle('is-active', this.app.showFrustum);
    if (this.refs.undoButton) this.refs.undoButton.disabled = !this.app.history.canUndo || this.app.history.depth <= 1;
    if (this.refs.redoButton) this.refs.redoButton.disabled = !this.app.history.canRedo;
  }

  // ---------------------------------------------------------------- rendering

  private loop = (now: number): void => {
    if (this.disposed) return;
    const dt = this.lastFrameTime === 0 ? 0 : Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    const wasPlaying = this.app.playing;
    const beforeTime = this.app.time;
    const beforeMix = this.app.aimBlender.mix;
    this.app.update(dt);
    const timeChanged = this.app.time !== beforeTime;
    if (timeChanged) {
      this.syncTimeUi();
      this.needsRender = true;
    }
    if (
      this.app.dirty ||
      this.needsRender ||
      this.app.aimBlender.isAnimating ||
      beforeMix !== this.app.aimBlender.mix
    ) {
      this.render();
      this.app.dirty = false;
      this.needsRender = false;
    }
    if (wasPlaying !== this.app.playing) this.uiRefs.transport?.refresh();
    requestAnimationFrame(this.loop);
  };

  private render(): void {
    const app = this.app;
    this.renderer.resize();
    const frame = app.sceneFrame();
    const ev = app.evaluate();
    const pose = {
      position: ev.position,
      rotation: ev.rotation,
      fovY: ev.fovY,
      near: app.project.camera.near,
      far: app.project.camera.far,
    };
    if (this.screenshotMode === 'clean') {
      this.renderer.drawClean(frame, pose, app.project.composition.aspect);
    } else if (this.screenshotMode === 'preview' || app.viewMode === 'camera') {
      this.renderer.drawPreview(frame, pose, app.project.composition.aspect);
    } else {
      this.renderer.drawScene(frame);
    }
    this.layoutOverlay();
    this.updateHud(ev);
  }

  private layoutOverlay(): void {
    const guidesVisible = this.app.viewMode === 'camera' && this.screenshotMode === null;
    if (!guidesVisible) {
      if (this.overlay.childElementCount > 0) this.overlay.replaceChildren();
      return;
    }
    const rect = this.renderer.letterboxCss(this.app.project.composition.aspect);
    renderGuides(this.overlay, this.app.project.composition, rect, { showGuides: true });
  }

  private updateHud(ev: Evaluation): void {
    const app = this.app;
    const key = `${app.frame}/${app.totalFrames}/${formatNumber(app.project.camera.focalLengthMm)}/${(ev.s * 100).toFixed(1)}/${app.playing}`;
    if (key === this.lastTimeText) return;
    this.lastTimeText = key;
    this.hud.replaceChildren(
      el('div', { class: 'hud-chip' }, [
        el('span', { class: `dot${app.playing ? '' : ' is-paused'}` }),
        el('span', { text: app.playing ? '播放中' : '暂停' }),
      ]),
      el('div', { class: 'hud-chip' }, [
        el('span', { text: '帧 ' }),
        el('strong', { text: `${app.frame} / ${app.totalFrames}` }),
        el('span', { text: ` · ${formatTime(app.time, app.fps)} · ${app.fps}fps` }),
      ]),
      el('div', { class: 'hud-chip' }, [
        el('span', { text: '镜头 ' }),
        el('strong', { text: `${formatNumber(app.project.camera.focalLengthMm)}mm` }),
        el('span', {
          text: ` · ${((ev.fovY * 180) / Math.PI).toFixed(1)}°V / ${((ev.fovX * 180) / Math.PI).toFixed(1)}°H · s=${(ev.s * 100).toFixed(1)}%`,
        }),
      ]),
    );
  }

  private syncTimeUi(): void {
    this.uiRefs.transport?.sync();
    this.uiRefs.timeline?.sync();
    if (this.app.viewMode === 'camera') this.needsRender = true;
  }

  refreshAll(): void {
    this.needsRender = true;
    this.uiRefs.left?.refresh();
    this.uiRefs.right?.refresh();
    this.uiRefs.transport?.refresh();
    this.uiRefs.timeline?.refresh();
    this.syncToolbar();
  }

  /** Broadcasts a small, targeted change (no full panel rebuild). */
  refreshLight(): void {
    this.needsRender = true;
    this.uiRefs.left?.refreshLight();
    this.uiRefs.transport?.sync();
    this.uiRefs.timeline?.sync();
    this.syncToolbar();
  }

  // --------------------------------------------------------------- mutations

  /**
   * Runs a mutation inside a history transaction. Panels call this once per
   * user action; nested calls inside the callback are plain state edits.
   */
  mutate(label: string, fn: () => void, opts: { refresh?: 'full' | 'light' | 'none' } = {}): void {
    const before = JSON.stringify(this.app.project);
    fn();
    const after = JSON.stringify(this.app.project);
    if (before !== after) {
      this.app.history.push(label, JSON.parse(before) as Project);
      this.app.markDirty();
    }
    const refresh = opts.refresh ?? 'full';
    if (refresh === 'full') this.refreshAll();
    else if (refresh === 'light') this.refreshLight();
    else this.syncToolbar();
    this.needsRender = true;
  }

  undo(): void {
    if (this.app.history.depth <= 1) {
      showToast('没有可撤销的操作');
      return;
    }
    const entry = this.app.history.undo(this.app.project);
    if (!entry) return;
    this.app.loadProject(entry.snapshot, { preserveView: true, preserveHistory: true });
    this.refreshAll();
    showToast(`已撤销：${entry.label}`);
  }

  redo(): void {
    const entry = this.app.history.redo(this.app.project);
    if (!entry) {
      showToast('没有可重做的操作');
      return;
    }
    this.app.loadProject(entry.snapshot, { preserveView: true, preserveHistory: true });
    this.refreshAll();
    showToast(`已重做：${entry.label}`);
  }

  // ---------------------------------------------------------------- pointer

  private bindCanvasEvents(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    c.addEventListener('pointerleave', () => {
      if (this.app.hoveredPointId) {
        this.app.hoveredPointId = null;
        this.needsRender = true;
      }
    });
  }

  private localPointer(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pickPoint(px: number, py: number): string | null {
    if (this.app.viewMode === 'camera') return null;
    const ray = this.renderer.screenRay(this.app.orbit, px, py);
    const vp = this.renderer.viewProjection(this.app.orbit);
    let best: { id: string; score: number } | null = null;
    for (const point of this.app.project.path.points) {
      const screen = this.renderer.projectToScreen(vp, point.position);
      if (!screen.visible) continue;
      const pixelDist = Math.hypot(screen.x - px, screen.y - py);
      if (pixelDist > 22) continue;
      const worldDist = distanceToRay(ray.origin, ray.dir, point.position);
      const score = pixelDist * 0.1 + worldDist;
      if (!best || score < best.score) best = { id: point.id, score };
    }
    return best?.id ?? null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button > 2) return;
    const { x, y } = this.localPointer(e);
    this.canvas.setPointerCapture?.(e.pointerId);

    if (e.button === 0) {
      const hit = this.pickPoint(x, y);
      if (hit) {
        this.app.selectPoint(hit);
        const point = this.app.pathPointById(hit);
        if (point) {
          const ray = this.renderer.screenRay(this.app.orbit, x, y);
          const planeHit = intersectPlaneY(ray.origin, ray.dir, point.position[1]);
          const grabOffset: Vec3 = planeHit
            ? [point.position[0] - planeHit[0], 0, point.position[2] - planeHit[2]]
            : [0, 0, 0];
          this.beginEdit('移动控制点');
          this.drag = {
            mode: 'point',
            index: Math.max(0, this.app.selectedPointIndex),
            planeY: point.position[1],
            grabOffset,
            startX: x,
            startY: y,
            moved: false,
          };
          this.refreshLight();
          return;
        }
      }
      if (this.app.selectedPointId) {
        this.app.selectPoint(null);
        this.refreshLight();
      }
    }
    this.orbitDrag = { x, y, button: e.button };
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localPointer(e);

    if (this.drag) {
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < 3) return;
      this.drag.moved = true;
      const ray = this.renderer.screenRay(this.app.orbit, x, y);
      const hit = intersectPlaneY(ray.origin, ray.dir, this.drag.planeY);
      if (hit) {
        const id = this.app.project.path.points[this.drag.index]?.id;
        if (id) {
          this.app.movePoint(id, [
            hit[0] + this.drag.grabOffset[0],
            Math.max(0.3, this.drag.planeY),
            hit[2] + this.drag.grabOffset[2],
          ]);
          this.uiRefs.left?.refreshLight();
          this.uiRefs.timeline?.sync();
          this.needsRender = true;
        }
      }
      return;
    }

    if (this.orbitDrag) {
      const dx = x - this.orbitDrag.x;
      const dy = y - this.orbitDrag.y;
      if (this.orbitDrag.button === 0 && !e.shiftKey) {
        this.app.orbit = clampOrbit({
          ...this.app.orbit,
          yaw: this.app.orbit.yaw - dx * 0.007,
          pitch: this.app.orbit.pitch + dy * 0.006,
        });
      } else {
        this.panOrbit(dx, dy);
      }
      this.orbitDrag = { x, y, button: this.orbitDrag.button };
      this.canvas.classList.add('is-dragging');
      this.needsRender = true;
      return;
    }

    const hit = this.pickPoint(x, y);
    if (hit !== this.app.hoveredPointId) {
      this.app.hoveredPointId = hit;
      this.canvas.classList.toggle('is-pointing', !!hit);
      this.needsRender = true;
    }
  }

  private panOrbit(dx: number, dy: number): void {
    const orbit = this.app.orbit;
    const scale = orbit.distance * 0.0016;
    const sin = Math.sin(orbit.yaw);
    const cos = Math.cos(orbit.yaw);
    // Pan in the camera's horizontal plane.
    const rightX = cos;
    const rightZ = -sin;
    const forwardX = -sin;
    const forwardZ = -cos;
    this.app.orbit = {
      ...orbit,
      target: [
        orbit.target[0] - rightX * dx * scale - forwardX * dy * scale,
        orbit.target[1],
        orbit.target[2] - rightZ * dx * scale - forwardZ * dy * scale,
      ],
    };
    this.needsRender = true;
  }

  private onPointerUp(e: PointerEvent): void {
    this.canvas.releasePointerCapture?.(e.pointerId);
    if (this.drag) {
      this.drag = null;
      this.commitEdit();
    }
    if (this.orbitDrag) {
      this.orbitDrag = null;
      this.canvas.classList.remove('is-dragging');
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0012);
    this.app.orbit = clampOrbit({ ...this.app.orbit, distance: this.app.orbit.distance * factor });
    this.needsRender = true;
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.app.viewMode === 'camera') return;
    const { x, y } = this.localPointer(e);
    // Double-clicking an existing control point should not spawn a new one.
    if (this.pickPoint(x, y)) return;
    this.addPointFromClick(x, y);
  }

  /** Inserts a control point at the nearest path location to a screen click. */
  private addPointFromClick(px: number, py: number): void {
    const vp = this.renderer.viewProjection(this.app.orbit);

    // 1) Prefer the path location whose projection is closest on screen. This
    //    is what animators expect: double-click near the drawn curve.
    let bestS = 0;
    let bestPixel = Infinity;
    const samples = Math.max(120, this.app.spline.segmentCount * 32);
    for (let i = 0; i <= samples; i++) {
      const s = i / samples;
      const pos = this.app.spline.positionAt(this.app.spline.closed && i === samples ? 0 : s);
      const screen = this.renderer.projectToScreen(vp, pos);
      if (!screen.visible) continue;
      const d = Math.hypot(screen.x - px, screen.y - py);
      if (d < bestPixel) {
        bestPixel = d;
        bestS = s;
      }
    }
    if (bestPixel <= 28) {
      this.mutate('插入控制点', () => this.app.insertPointAtS(bestS % 1));
      showToast('已插入控制点');
      return;
    }

    // 2) Otherwise unproject onto horizontal planes and use nearest path point.
    const ray = this.renderer.screenRay(this.app.orbit, px, py);
    const heights = new Set<number>([0]);
    for (const p of this.app.project.path.points) heights.add(Number(p.position[1].toFixed(2)));
    let fallbackS = 0;
    let fallbackDistance = Infinity;
    for (const h of heights) {
      const hit = intersectPlaneY(ray.origin, ray.dir, h);
      if (!hit) continue;
      const near = this.app.spline.nearest(hit);
      if (near.distance < fallbackDistance) {
        fallbackDistance = near.distance;
        fallbackS = near.s;
      }
    }
    if (fallbackDistance > 40) {
      showToast('双击位置离路径太远，未添加控制点', 'error');
      return;
    }
    this.mutate('插入控制点', () => this.app.insertPointAtS(fallbackS));
    showToast('已插入控制点');
  }

  // -------------------------------------------------------------- keyboard

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveProject();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.openProjectFile();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.app.togglePlay();
          this.uiRefs.transport?.refresh();
          this.needsRender = true;
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.app.stepFrame(e.shiftKey ? -10 : -1);
          this.syncTimeUi();
          this.needsRender = true;
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.app.stepFrame(e.shiftKey ? 10 : 1);
          this.syncTimeUi();
          this.needsRender = true;
          break;
        case 'Home':
          this.setTime(0);
          break;
        case 'End':
          this.setTime(this.app.duration);
          break;
        case 'Delete':
        case 'Backspace':
          if (this.app.selectedPointId) this.deleteSelectedPoint();
          break;
        case 'v':
        case 'V':
          this.toggleViewMode();
          break;
        case 'g':
        case 'G':
          this.toggleGrid();
          break;
        case 'f':
        case 'F':
          this.toggleFrustum();
          break;
        case 'a':
        case 'A':
          this.frameAll();
          break;
        case 'k':
        case 'K':
          this.mutate('在时间指针处加关键点', () => this.app.addKeyAtPlayhead());
          break;
        case 'Escape':
          if (this.app.selectedPointId) {
            this.app.selectPoint(null);
            this.refreshLight();
          }
          break;
        default:
          break;
      }
    });
  }

  // ----------------------------------------------------------------- actions

  toggleViewMode(): void {
    this.app.viewMode = this.app.viewMode === 'orbit' ? 'camera' : 'orbit';
    this.syncToolbar();
    this.layoutOverlay();
    this.needsRender = true;
    showToast(this.app.viewMode === 'camera' ? '相机视图：构图辅助线可见' : '轨道视图：编辑路径');
  }

  toggleGrid(): void {
    this.app.showGrid = !this.app.showGrid;
    this.syncToolbar();
    this.needsRender = true;
  }

  toggleFrustum(): void {
    this.app.showFrustum = !this.app.showFrustum;
    this.syncToolbar();
    this.needsRender = true;
  }

  frameAll(): void {
    this.app.frameOrbitToPath();
    this.needsRender = true;
  }

  setTime(t: number): void {
    this.app.setTime(t);
    this.syncTimeUi();
    this.needsRender = true;
  }

  deleteSelectedPoint(): void {
    if (this.app.project.path.points.length <= 2) {
      showToast('路径至少保留两个控制点', 'error');
      return;
    }
    this.mutate('删除控制点', () => this.app.deleteSelectedPoint());
  }

  toggleClosed(): void {
    if (!this.app.project.path.closed && this.app.project.path.points.length < 3) {
      showToast('闭合路径至少需要 3 个控制点', 'error');
      return;
    }
    this.mutate(this.app.project.path.closed ? '打开路径' : '闭合路径', () => this.app.toggleClosed());
  }

  loadSample(id: string): void {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) return;
    this.app.loadProject(sample.build());
    this.app.history.clear();
    this.app.history.push('载入示例', this.app.project);
    this.refreshAll();
    showToast(`已载入示例：${sample.name}`);
  }

  // ---------------------------------------------------------------- file I/O

  saveProject(): void {
    const json = this.app.serializeProject();
    const stem = safeFileStem(this.app.project.name);
    downloadText(json, `${stem}.camera.json`);
    showToast('项目已保存（JSON）');
  }

  openProjectFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as unknown;
        const record = parsed as Record<string, unknown>;
        const projectData =
          record && record.format === 'camera-path-editor-project' ? record.project : parsed;
        this.app.loadProject(normalizeProject(projectData));
        this.app.history.clear();
        this.app.history.push(`打开：${file.name}`, this.app.project);
        this.refreshAll();
        showToast(`已打开 ${file.name}`);
      } catch (err) {
        const message =
          err instanceof ProjectValidationError
            ? `项目格式错误：${err.message}`
            : `无法读取项目：${err instanceof Error ? err.message : String(err)}`;
        showToast(message, 'error', 3200);
      }
    });
    input.click();
  }

  exportSamplesJson(): void {
    const payload = buildExportPayload(this.app.context);
    const stem = safeFileStem(this.app.project.name);
    downloadText(JSON.stringify(payload, null, 2), `${stem}.samples.json`);
    showToast(`已导出 ${payload.samples.length} 帧相机采样`);
  }

  exportSamplesCsv(): void {
    const stem = safeFileStem(this.app.project.name);
    downloadText(this.app.exportCameraCsv(), `${stem}.samples.csv`, 'text/csv');
    showToast('已导出 CSV 相机采样');
  }

  /** Renders the current camera view without any editor overlay, then saves a PNG. */
  exportScreenshot(): void {
    this.screenshotMode = 'clean';
    this.render();
    const dataUrl = this.canvas.toDataURL('image/png');
    this.screenshotMode = null;
    this.needsRender = true;
    this.render();

    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${safeFileStem(this.app.project.name)}-frame-${String(this.app.frame).padStart(4, '0')}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    showToast('已导出当前帧截图（不含构图辅助线）');
  }

  showHelp(): void {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });
    const body = el('div', { class: 'modal-body' });
    body.innerHTML = `
      <h3>基本操作</h3>
      <div class="shortcut-table">
        <span>旋转视图</span><span>左键拖拽（空白处）</span>
        <span>平移视图</span><span>右键 / 中键拖拽</span>
        <span>缩放视图</span><span>滚轮</span>
        <span>移动控制点</span><span>直接拖拽控制点，沿水平面移动</span>
        <span>插入控制点</span><span>双击路径附近</span>
        <span>删除控制点</span><span>选中后按 <span class="kbd">Del</span></span>
        <span>播放 / 暂停</span><span><span class="kbd">Space</span></span>
        <span>逐帧</span><span><span class="kbd">←</span> <span class="kbd">→</span>（Shift 一次 10 帧）</span>
        <span>相机视图</span><span><span class="kbd">V</span></span>
        <span>地面网格</span><span><span class="kbd">G</span></span>
        <span>取景框</span><span><span class="kbd">F</span></span>
        <span>加关键点</span><span><span class="kbd">K</span></span>
        <span>撤销 / 重做</span><span><span class="kbd">⌘Z</span> / <span class="kbd">⇧⌘Z</span></span>
      </div>
      <h3>关于构图辅助线</h3>
      <p>三分线、中心线、动作安全框和字幕安全框绘制在独立的 DOM 覆盖层上，
      只在相机视图显示。<code>导出 → 当前构图截图 PNG</code> 使用纯 WebGL 画面，
      这些辅助线与编辑控件都不会进入最终图片。</p>
      <h3>相机采样数据</h3>
      <p>导出 JSON 中的 <code>samples</code> 按帧给出位置、四元数 (x,y,z,w)、
      FOV 与焦距，坐标系为右手系、+Y 向上、镜头朝向 +Z。CSV 为同一份数据的表格版本。</p>
      <h3>本地启动</h3>
      <p>在项目根目录执行 <code>npm start</code>，然后打开
      <code>http://127.0.0.1:4173/</code>。仅依赖 Node.js，无需安装第三方包。</p>
    `;
    modal.append(
      el('div', { class: 'modal-head' }, [el('span', { text: '帮助 · 快捷键' })]),
      body,
      el('div', { class: 'modal-foot' }, [
        button('知道了', () => backdrop.remove(), { class: 'btn is-primary' }),
      ]),
    );
    backdrop.append(modal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.append(backdrop);
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }
}

export function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('缺少 #app 挂载点');
  try {
    const ui = new CameraPathEditorUi();
    (window as unknown as { __editor?: CameraPathEditorUi }).__editor = ui;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = el('div', { class: 'modal-backdrop' });
    fallback.append(
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [el('span', { text: '无法启动编辑器' })]),
        el('div', { class: 'modal-body' }, [
          el('p', { text: message }),
          el('p', { text: '请使用支持 WebGL2 的现代浏览器（Chrome / Edge / Firefox / Safari 15+）。' }),
        ]),
      ]),
    );
    document.body.append(fallback);
  }
}
