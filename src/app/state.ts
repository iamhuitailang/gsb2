import type {
  CameraSample,
  CompositionData,
  Evaluation,
  Project,
  SceneObjectData,
  TimelineKey,
  Vec3,
} from '../core/types.js';
import { PathSpline } from '../core/curve.js';
import { Timeline } from '../core/timeline.js';
import { AimBlender, fovFromFocal } from '../core/camera.js';
import {
  buildExportPayload,
  evaluateCamera,
  type EvaluationContext,
  type ExportPayload,
} from '../core/evaluate.js';
import { captureObjectState, findTarget } from '../core/motion.js';
import { normalizeProject } from '../core/project.js';
import type { OrbitCamera, RenderObject, SceneFrame } from '../webgl/renderer.js';
import { History } from './history.js';
import { findTargetObject } from './panels-helpers.js';

export type ViewMode = 'orbit' | 'camera';

export class EditorApp {
  project: Project;
  spline: PathSpline;
  timeline: Timeline;
  context: EvaluationContext;

  time = 0;
  playing = false;
  viewMode: ViewMode = 'orbit';
  showGrid = true;
  showFrustum = true;
  orbit: OrbitCamera = { target: [0, 6, 0], distance: 80, yaw: 0.9, pitch: 0.42 };

  selectedPointId: string | null = null;
  selectedKeyId: string | null = null;
  selectedObjectId: string | null = null;
  hoveredPointId: string | null = null;

  readonly history = new History<Project>(100);
  readonly aimBlender = new AimBlender();
  dirty = true;
  pathPolyline: Vec3[] = [];

  private listeners = new Set<() => void>();
  /** Temporary preview override (does not modify the saved project). */
  private previewAim: 'tangent' | 'target' | null = null;
  private previewUntil = 0;

  constructor(project: Project) {
    this.project = project;
    this.spline = new PathSpline(project.path.points.map((p) => p.position), project.path.closed);
    this.timeline = new Timeline(project.timeline, this.spline.totalLength, project.path.closed);
    this.context = { project: this.project, spline: this.spline, timeline: this.timeline };
    this.selectedPointId = project.path.points[0]?.id ?? null;
    this.selectedKeyId = project.timeline.keys[0]?.id ?? null;
    this.aimBlender.snapToMode(project.camera.aim.mode);
    this.pathPolyline = this.spline.polyline(20);
    this.frameOrbitToPath();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Rebuilds derived data after a project mutation. */
  rebuild(): void {
    this.spline = new PathSpline(
      this.project.path.points.map((p) => p.position),
      this.project.path.closed,
    );
    this.timeline = new Timeline(this.project.timeline, this.spline.totalLength, this.project.path.closed);
    this.context = { project: this.project, spline: this.spline, timeline: this.timeline };
    this.pathPolyline = this.spline.polyline(20);
    this.time = Math.max(0, Math.min(this.time, this.timeline.duration));
    if (this.selectedPointId && !this.project.path.points.some((p) => p.id === this.selectedPointId)) {
      this.selectedPointId = this.project.path.points[0]?.id ?? null;
    }
    if (this.selectedKeyId && !this.project.timeline.keys.some((k) => k.id === this.selectedKeyId)) {
      this.selectedKeyId = this.project.timeline.keys[0]?.id ?? null;
    }
    this.dirty = true;
  }

  get duration(): number {
    return this.timeline.duration;
  }

  get fps(): number {
    return this.project.timeline.fps;
  }

  get frame(): number {
    return Math.round(this.time * this.fps);
  }

  get totalFrames(): number {
    return Math.round(this.duration * this.fps);
  }

  frameOrbitToPath(): void {
    const bounds = this.spline.bounds();
    const center: Vec3 = [
      (bounds.min[0] + bounds.max[0]) / 2,
      Math.max(2, (bounds.min[1] + bounds.max[1]) / 2),
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
      12,
    );
    this.orbit = { target: center, distance: span * 1.55, yaw: 0.9, pitch: 0.42 };
  }

  setTime(time: number): void {
    this.time = Math.max(0, Math.min(time, this.duration));
    this.aimBlender.snapToMode(this.desiredAimMode());
  }

  stepFrame(delta: number): void {
    this.setTime(this.time + delta / this.fps);
  }

  togglePlay(): void {
    if (this.duration <= 0) return;
    if (!this.playing && this.time >= this.duration - 1e-6) this.time = 0;
    this.playing = !this.playing;
    this.aimBlender.snapToMode(this.desiredAimMode());
  }

  update(dt: number): void {
    const now = performance.now() / 1000;
    this.aimBlender.update(now);
    if (this.previewAim && performance.now() > this.previewUntil) {
      this.previewAim = null;
      this.aimBlender.setMode(this.project.camera.aim.mode, now, true);
    }
    if (!this.playing) return;
    const next = this.time + dt;
    if (next >= this.duration) {
      if (this.project.timeline.loop && this.duration > 0) {
        this.time = next % this.duration;
      } else {
        this.time = this.duration;
        this.playing = false;
      }
    } else {
      this.time = next;
    }
  }

  desiredAimMode(): 'tangent' | 'target' {
    return this.previewAim ?? this.project.camera.aim.mode;
  }

  effectiveAimMix(): number {
    if (this.aimBlender.isAnimating) return this.aimBlender.mix;
    return this.desiredAimMode() === 'target' ? 1 : 0;
  }

  /** Plays a temporary tangent/target transition without editing the project. */
  previewAimMode(mode: 'tangent' | 'target', durationMs = 1200): void {
    this.previewAim = mode;
    this.previewUntil = performance.now() + durationMs;
    this.aimBlender.setMode(mode, performance.now() / 1000, true);
    this.markDirty();
  }

  evaluate(time = this.time): Evaluation {
    return evaluateCamera(this.context, time, { aimMix: this.effectiveAimMix() });
  }

  sceneFrame(): SceneFrame {
    const ev = this.evaluate();
    const objects: RenderObject[] = this.project.objects.map((obj) => {
      const live = captureObjectState(obj, this.time);
      return {
        shape: obj.shape,
        position: live.position,
        rotation: live.rotation,
        scale: obj.scale,
        color: obj.color,
        roughness: obj.roughness,
        emissive: obj.emissive,
        selected: obj.id === this.selectedObjectId,
      };
    });
    const target = findTarget(this.project, this.time);
    return {
      objects,
      orbit: this.orbit,
      path: this.pathPolyline,
      pathClosed: this.project.path.closed,
      markers: this.project.path.points.map((p, index) => ({
        position: p.position,
        selected: p.id === this.selectedPointId,
        hovered: p.id === this.hoveredPointId,
        index,
      })),
      camera: {
        position: ev.position,
        rotation: ev.rotation,
        fovY: ev.fovY,
        aspect: this.project.composition.aspect,
        near: this.project.camera.near,
        far: this.project.camera.far,
        selected: this.viewMode === 'camera',
      },
      target,
      showGrid: this.showGrid,
      showFrustum: this.showFrustum,
      pathProgress: this.duration > 0 ? this.time / this.duration : 0,
    };
  }

  // ---- path editing -------------------------------------------------------

  pathPointById(id: string | null) {
    if (!id) return undefined;
    return this.project.path.points.find((p) => p.id === id);
  }

  get selectedPointIndex(): number {
    return this.project.path.points.findIndex((p) => p.id === this.selectedPointId);
  }

  selectPoint(id: string | null): void {
    this.selectedPointId = id;
    this.markDirty();
  }

  get selectedPoint(): { id: string; position: Vec3 } | undefined {
    return this.project.path.points.find((p) => p.id === this.selectedPointId);
  }

  /** Inserts a point between the selected point and its successor. */
  addPointAfterSelected(): void {
    const points = this.project.path.points;
    const index = this.selectedPointIndex >= 0 ? this.selectedPointIndex : points.length - 1;
    const a = points[index];
    if (!a) return;
    const hasNext = index + 1 < points.length || this.project.path.closed;
    let position: Vec3;
    if (hasNext) {
      const b = points[(index + 1) % points.length];
      const sA = this.spline.nearest(a.position).s;
      const sB = this.spline.nearest(b.position).s;
      let midS = (sA + sB) / 2;
      if (sB < sA - 1e-6) midS = ((sA + sB + 1) / 2) % 1;
      position = this.spline.positionAt(midS);
    } else {
      const prev = points[Math.max(0, index - 1)];
      position = [
        a.position[0] * 2 - prev.position[0],
        Math.max(0.5, a.position[1] * 2 - prev.position[1]),
        a.position[2] * 2 - prev.position[2],
      ];
    }
    const id = `pt-${Date.now().toString(36)}-${points.length + 1}`;
    points.splice(index + 1, 0, { id, position: [position[0], position[1], position[2]] });
    this.selectedPointId = id;
    this.rebuild();
  }

  addPointAtPlayhead(): void {
    const s = this.timeline.evaluate(this.time).s;
    const pos = this.spline.positionAt(s);
    const insertAt = this.spline.insertionIndexForS(s);
    const id = `pt-${Date.now().toString(36)}-${this.project.path.points.length + 1}`;
    this.project.path.points.splice(insertAt, 0, { id, position: [pos[0], pos[1], pos[2]] });
    this.selectedPointId = id;
    this.rebuild();
  }

  /** Inserts a new point at a normalized path position (double-click). */
  insertPointAtS(s: number): string | null {
    const near = this.spline.nearest(this.spline.positionAt(s));
    if (!Number.isFinite(near.s)) return null;
    const pos = this.spline.positionAt(s);
    const insertAt = this.spline.insertionIndexForS(s);
    const id = `pt-${Date.now().toString(36)}-${this.project.path.points.length + 1}`;
    this.project.path.points.splice(insertAt, 0, { id, position: [pos[0], pos[1], pos[2]] });
    this.selectedPointId = id;
    this.rebuild();
    return id;
  }

  deleteSelectedPoint(): boolean {
    const index = this.selectedPointIndex;
    if (index < 0) return false;
    if (this.project.path.points.length <= 2) return false;
    this.project.path.points.splice(index, 1);
    this.selectedPointId =
      this.project.path.points[Math.min(index, this.project.path.points.length - 1)]?.id ?? null;
    this.rebuild();
    return true;
  }

  movePoint(id: string, position: Vec3): void {
    const point = this.pathPointById(id);
    if (!point) return;
    point.position = [position[0], Math.max(0.1, position[1]), position[2]];
    this.rebuild();
  }

  toggleClosed(): void {
    if (!this.project.path.closed && this.project.path.points.length < 3) return;
    this.project.path.closed = !this.project.path.closed;
    this.project.timeline.loop = this.project.path.closed;
    this.rebuild();
  }

  // ---- timeline editing ---------------------------------------------------

  get selectedKey(): TimelineKey | undefined {
    return this.project.timeline.keys.find((k) => k.id === this.selectedKeyId);
  }

  sortedKeys(): TimelineKey[] {
    return [...this.project.timeline.keys].sort((a, b) => a.s - b.s || a.id.localeCompare(b.id));
  }

  addKeyAtPlayhead(): TimelineKey {
    const s = this.timeline.evaluate(this.time).s;
    const key: TimelineKey = {
      id: `key-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      s,
      hold: 0,
      speed: 1,
      ease: 'easeInOut',
    };
    this.project.timeline.keys.push(key);
    this.project.timeline.keys = sortTimelineKeys(this.project.timeline.keys);
    this.selectedKeyId = key.id;
    this.rebuild();
    return key;
  }

  deleteSelectedKey(): boolean {
    const keys = this.project.timeline.keys;
    if (keys.length <= 1) return false;
    const idx = keys.findIndex((k) => k.id === this.selectedKeyId);
    if (idx < 0) return false;
    keys.splice(idx, 1);
    this.selectedKeyId = keys[Math.min(idx, keys.length - 1)]?.id ?? null;
    this.rebuild();
    return true;
  }

  moveKey(id: string, s: number): void {
    const key = this.project.timeline.keys.find((k) => k.id === id);
    if (!key) return;
    key.s = Math.max(0, Math.min(1, s));
    this.project.timeline.keys = sortTimelineKeys(this.project.timeline.keys);
    this.rebuild();
  }

  updateKey(id: string, patch: Partial<TimelineKey>): void {
    const key = this.project.timeline.keys.find((k) => k.id === id);
    if (!key) return;
    Object.assign(key, patch);
    this.project.timeline.keys = sortTimelineKeys(this.project.timeline.keys);
    this.rebuild();
  }

  /** Time at which the given key's dwell begins. */
  keyTime(id: string): number {
    const entry = this.timeline.entries.find((e) => e.key.id === id);
    return entry ? entry.holdStart : 0;
  }

  // ---- camera -------------------------------------------------------------

  setAimMode(mode: 'tangent' | 'target'): void {
    if (this.project.camera.aim.mode === mode) return;
    this.project.camera.aim.mode = mode;
    if (mode === 'target' && !this.project.camera.aim.targetObjectId) {
      const target = findTargetObject(this.project);
      if (target) this.project.camera.aim.targetObjectId = target.id;
    }
    this.aimBlender.setMode(mode, performance.now() / 1000, true);
    this.markDirty();
  }

  setTargetObject(id: string | null): void {
    this.project.camera.aim.targetObjectId = id;
    this.markDirty();
  }

  setFocalLength(mm: number): void {
    this.project.camera.focalLengthMm = Math.max(8, Math.min(400, mm));
    this.markDirty();
  }

  get fov(): { fovY: number; fovX: number } {
    return fovFromFocal(
      this.project.camera.focalLengthMm,
      this.project.camera.sensorHeightMm,
      this.project.composition.aspect,
    );
  }

  setComposition(patch: Partial<CompositionData>): void {
    Object.assign(this.project.composition, patch);
    this.markDirty();
  }

  // ---- objects ------------------------------------------------------------

  selectObject(id: string | null): void {
    this.selectedObjectId = id;
    this.markDirty();
  }

  get selectedObject(): SceneObjectData | undefined {
    return this.project.objects.find((o) => o.id === this.selectedObjectId);
  }

  updateObject(id: string, patch: Partial<SceneObjectData>): void {
    const obj = this.project.objects.find((o) => o.id === id);
    if (!obj) return;
    Object.assign(obj, patch);
    this.markDirty();
  }

  deleteObject(id: string): void {
    if (this.project.camera.aim.targetObjectId === id) {
      this.project.camera.aim.targetObjectId = null;
    }
    this.project.objects = this.project.objects.filter((o) => o.id !== id);
    if (this.selectedObjectId === id) this.selectedObjectId = null;
    this.markDirty();
  }

  // ---- persistence --------------------------------------------------------

  serializeProject(): string {
    const payload = {
      format: 'camera-path-editor-project',
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      project: this.project,
    };
    return JSON.stringify(payload, null, 2);
  }

  exportCameraSamples(): ExportPayload {
    return buildExportPayload(this.context);
  }

  exportCameraCsv(): string {
    const payload = this.exportCameraSamples();
    const header = [
      'frame', 'time', 's',
      'x', 'y', 'z',
      'qx', 'qy', 'qz', 'qw',
      'fovY', 'fovX', 'focalLengthMm',
      'targetX', 'targetY', 'targetZ',
    ].join(',');
    const lines = payload.samples.map((sample: CameraSample) =>
      [
        sample.frame,
        sample.t,
        sample.s,
        sample.position[0], sample.position[1], sample.position[2],
        sample.rotation[0], sample.rotation[1], sample.rotation[2], sample.rotation[3],
        sample.fovY, sample.fovX, sample.focalLengthMm,
        sample.target ? sample.target[0] : '',
        sample.target ? sample.target[1] : '',
        sample.target ? sample.target[2] : '',
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }

  loadProject(raw: unknown, opts: { preserveView?: boolean; preserveHistory?: boolean } = {}): void {
    const project = normalizeProject(raw);
    const view = opts.preserveView
      ? { target: this.orbit.target, distance: this.orbit.distance, yaw: this.orbit.yaw, pitch: this.orbit.pitch }
      : null;
    const previousTime = opts.preserveView ? this.time : 0;
    this.project = project;
    this.time = previousTime;
    this.playing = false;
    this.selectedPointId = project.path.points[0]?.id ?? null;
    this.selectedKeyId = project.timeline.keys[0]?.id ?? null;
    this.selectedObjectId = null;
    this.hoveredPointId = null;
    this.previewAim = null;
    this.aimBlender.snapToMode(project.camera.aim.mode);
    if (!opts.preserveHistory) this.history.clear();
    this.rebuild();
    if (view) this.orbit = view;
    else this.frameOrbitToPath();
  }
}

export function sortTimelineKeys<T extends { s: number; id: string }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => a.s - b.s || a.id.localeCompare(b.id));
}
