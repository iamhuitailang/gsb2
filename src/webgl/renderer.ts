import { lookAt, multiply, perspective, invert, type Mat4 } from '../math/mat4.js';
import type { Vec3 } from '../math/vec3.js';
import { add, normalize, sub } from '../math/vec3.js';
import type { Quat } from '../math/quat.js';
import { quatRotateVec } from '../math/quat.js';
import { GRID_FS, GRID_VS, LINE_FS, LINE_VS, SOLID_FS, SOLID_VS } from './shaders.js';
import {
  createProgram,
  hexToRgb,
  setFloat,
  setMat3,
  setMat4,
  setVec3,
  type ProgramInfo,
} from './glutil.js';
import { LineBatch, MeshCache, normalMatrix, transformMatrix } from './objects.js';
import type { MeshName } from './meshes.js';

export interface OrbitCamera {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export interface RenderObject {
  shape: MeshName;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: string;
  roughness: number;
  emissive: number;
  selected?: boolean;
}

export interface CameraOverlay {
  position: Vec3;
  rotation: Quat;
  fovY: number;
  aspect: number;
  near: number;
  far: number;
  selected?: boolean;
}

export interface PointMarker {
  position: Vec3;
  selected: boolean;
  hovered: boolean;
  index: number;
}

export interface SceneFrame {
  objects: RenderObject[];
  orbit: OrbitCamera;
  path: Vec3[];
  pathClosed: boolean;
  markers: PointMarker[];
  camera: CameraOverlay;
  target: Vec3 | null;
  showGrid: boolean;
  showFrustum: boolean;
  pathProgress: number;
}

export interface ViewSample {
  position: Vec3;
  rotation: Quat;
  fovY: number;
  near: number;
  far: number;
}

const ACCENT: [number, number, number] = [1.0, 0.72, 0.28];
const PATH_COLOR: [number, number, number] = [0.36, 0.82, 1.0];

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private solid: ProgramInfo;
  private line: ProgramInfo;
  private grid: ProgramInfo;
  private meshes: MeshCache;
  private lines: LineBatch;
  private gridVao: WebGLVertexArrayObject;
  private gridVbo: WebGLBuffer;
  private gridVertexCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2，无法启动编辑器。');
    this.gl = gl;
    this.solid = createProgram(gl, SOLID_VS, SOLID_FS);
    this.line = createProgram(gl, LINE_VS, LINE_FS);
    this.grid = createProgram(gl, GRID_VS, GRID_FS);
    this.meshes = new MeshCache(gl);
    this.lines = new LineBatch(gl);
    const grid = this.createGrid();
    this.gridVao = grid.vao;
    this.gridVbo = grid.vbo;
    this.gridVertexCount = grid.count;
  }

  private createGrid(): { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; count: number } {
    const gl = this.gl;
    const verts: number[] = [];
    const extent = 160;
    for (let i = -160; i <= 160; i += 5) {
      verts.push(-extent, 0, i, extent, 0, i);
      verts.push(i, 0, -extent, i, 0, extent);
    }
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('无法创建地面网格');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, vbo, count: verts.length / 3 };
  }

  /** Resizes the drawing buffer to match CSS size times pixel ratio. */
  resize(pixelRatio = window.devicePixelRatio || 1): void {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * pixelRatio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * pixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  eyeFor(orbit: OrbitCamera): Vec3 {
    const cp = Math.cos(orbit.pitch);
    return [
      orbit.target[0] + Math.sin(orbit.yaw) * cp * orbit.distance,
      orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
      orbit.target[2] + Math.cos(orbit.yaw) * cp * orbit.distance,
    ];
  }

  viewProjection(orbit: OrbitCamera): Mat4 {
    const eye = this.eyeFor(orbit);
    const view = lookAt(eye, orbit.target, [0, 1, 0]);
    const proj = perspective((45 * Math.PI) / 180, this.aspect, 0.1, 4000);
    return multiply(proj, view);
  }

  private clear(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.047, 0.055, 0.075, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  private drawObjects(vp: Mat4, objects: RenderObject[], cameraPos: Vec3): void {
    const gl = this.gl;
    gl.useProgram(this.solid.program);
    setMat4(gl, this.solid, 'uViewProjection', vp);
    setVec3(gl, this.solid, 'uCameraPos', cameraPos);
    setVec3(gl, this.solid, 'uSunDir', normalize([-0.45, 0.82, 0.35]));
    setVec3(gl, this.solid, 'uAccent', ACCENT);

    for (const obj of objects) {
      const model = transformMatrix({ position: obj.position, rotation: obj.rotation, scale: obj.scale });
      const mesh = this.meshes.get(obj.shape);
      setMat4(gl, this.solid, 'uModel', model);
      setMat3(gl, this.solid, 'uNormalMatrix', normalMatrix(model));
      const [r, g, b] = hexToRgb(obj.color);
      setVec3(gl, this.solid, 'uColor', [r, g, b]);
      setFloat(gl, this.solid, 'uRoughness', obj.roughness);
      setFloat(gl, this.solid, 'uEmissive', obj.emissive);
      setFloat(gl, this.solid, 'uSelected', obj.selected ? 1 : 0);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  private drawGrid(vp: Mat4, opacity: number): void {
    const gl = this.gl;
    gl.useProgram(this.grid.program);
    setMat4(gl, this.grid, 'uViewProjection', vp);
    setVec3(gl, this.grid, 'uColor', [0.16, 0.2, 0.27]);
    setVec3(gl, this.grid, 'uAccent', [0.2, 0.28, 0.36]);
    setFloat(gl, this.grid, 'uOpacity', opacity);
    setFloat(gl, this.grid, 'uFadeDistance', 220);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.LINES, 0, this.gridVertexCount);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  private flushLines(vp: Mat4, opacity = 1): void {
    const gl = this.gl;
    gl.useProgram(this.line.program);
    setMat4(gl, this.line, 'uViewProjection', vp);
    setFloat(gl, this.line, 'uOpacity', opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.lines.flush('lines');
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawScene(frame: SceneFrame): void {
    this.clear();
    const vp = this.viewProjection(frame.orbit);
    const eye = this.eyeFor(frame.orbit);

    if (frame.showGrid) this.drawGrid(vp, 0.75);
    this.drawObjects(vp, frame.objects, eye);

    this.lines.begin();
    for (const obj of frame.objects) {
      this.addDisc(
        [obj.position[0], 0.02, obj.position[2]],
        Math.max(0.4, Math.max(obj.scale[0], obj.scale[2]) * 0.85),
        [0.015, 0.02, 0.03],
      );
    }
    if (frame.path.length >= 2) {
      this.lines.polyline(frame.path, [0.18, 0.35, 0.45]);
      const upto = Math.max(2, Math.round(frame.path.length * frame.pathProgress));
      this.lines.polyline(frame.path.slice(0, upto), PATH_COLOR);
      for (const m of frame.markers) {
        this.lines.line(m.position, [m.position[0], 0, m.position[2]], [0.2, 0.28, 0.34]);
      }
    }
    if (frame.target) this.addTargetCross(frame.target);
    if (frame.showFrustum) this.addFrustum(frame.camera);
    for (const m of frame.markers) this.addPointMarker(m);
    this.flushLines(vp, 1);
  }

  /** Animated camera's point of view (editor-facing preview with path hints). */
  drawPreview(frame: SceneFrame, sample: ViewSample, frameAspect: number): void {
    this.clear();
    const rect = this.letterbox(frameAspect);
    this.gl.viewport(rect.x, rect.y, rect.w, rect.h);
    const vp = this.viewProjectionFor(sample, frameAspect);
    if (frame.showGrid) this.drawGrid(vp, 0.55);
    this.drawObjects(vp, frame.objects, sample.position);

    this.lines.begin();
    if (frame.target) this.addTargetCross(frame.target);
    if (frame.path.length >= 2) this.lines.polyline(frame.path, [0.2, 0.32, 0.42]);
    this.flushLines(vp, 0.9);
  }

  /** Scene-only render used for screenshots; no path, markers, frustum or guides. */
  drawClean(frame: SceneFrame, sample: ViewSample, frameAspect: number): void {
    const gl = this.gl;
    this.clear();
    const rect = this.letterbox(frameAspect);
    gl.viewport(rect.x, rect.y, rect.w, rect.h);
    gl.clearColor(0.05, 0.06, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.viewProjectionFor(sample, frameAspect);
    this.drawObjects(vp, frame.objects, sample.position);
  }

  private letterbox(aspect: number): { x: number; y: number; w: number; h: number } {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const canvasAspect = W / Math.max(1, H);
    let w = W;
    let h = H;
    if (canvasAspect > aspect) w = Math.round(H * aspect);
    else h = Math.round(W / aspect);
    return { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w: Math.max(1, w), h: Math.max(1, h) };
  }

  /** Letterbox rectangle in CSS pixels (origin top-left), used by the DOM guides. */
  letterboxCss(aspect: number): { left: number; top: number; width: number; height: number } {
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const canvasAspect = W / Math.max(1, H);
    let w = W;
    let h = H;
    if (canvasAspect > aspect) w = H * aspect;
    else h = W / aspect;
    return { left: (W - w) / 2, top: (H - h) / 2, width: w, height: h };
  }

  viewProjectionFor(sample: ViewSample, aspect = this.aspect): Mat4 {
    const forward = quatRotateVec(sample.rotation, [0, 0, 1]) as Vec3;
    const up = quatRotateVec(sample.rotation, [0, 1, 0]) as Vec3;
    const view = lookAt(sample.position, add(sample.position, forward), up);
    const proj = perspective(sample.fovY, aspect, sample.near, sample.far);
    return multiply(proj, view);
  }

  private addDisc(center: Vec3, radius: number, color: readonly number[]): void {
    const segments = 24;
    let prev: Vec3 | null = null;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const p: Vec3 = [center[0] + Math.cos(a) * radius, center[1], center[2] + Math.sin(a) * radius];
      if (prev) this.lines.line(prev, p, color);
      prev = p;
    }
  }

  private addPointMarker(marker: PointMarker): void {
    const color = marker.selected
      ? [1.0, 0.78, 0.32]
      : marker.hovered
        ? [0.7, 0.9, 1.0]
        : [0.55, 0.72, 0.85];
    const r = marker.selected ? 0.62 : 0.42;
    const ring = (axisA: Vec3, axisB: Vec3) => {
      const segs = 18;
      let prev: Vec3 | null = null;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const p: Vec3 = [
          marker.position[0] + axisA[0] * Math.cos(a) * r + axisB[0] * Math.sin(a) * r,
          marker.position[1] + axisA[1] * Math.cos(a) * r + axisB[1] * Math.sin(a) * r,
          marker.position[2] + axisA[2] * Math.cos(a) * r + axisB[2] * Math.sin(a) * r,
        ];
        if (prev) this.lines.line(prev, p, color);
        prev = p;
      }
    };
    ring([1, 0, 0], [0, 1, 0]);
    ring([0, 1, 0], [0, 0, 1]);
    ring([0, 0, 1], [1, 0, 0]);
    const t = r * 1.7;
    this.lines.line(sub(marker.position, [t, 0, 0]), add(marker.position, [t, 0, 0]), color);
    this.lines.line(sub(marker.position, [0, t, 0]), add(marker.position, [0, t, 0]), color);
  }

  private addTargetCross(target: Vec3): void {
    const color: [number, number, number] = [1.0, 0.42, 0.32];
    for (let ringIndex = 0; ringIndex < 2; ringIndex++) {
      const rr = 0.9 * (1 + ringIndex * 0.5);
      const segs = 26;
      let prev: Vec3 | null = null;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        // Billboarded ring around the target, facing roughly +Z for readability.
        const p: Vec3 = [target[0] + Math.cos(a) * rr, target[1] + Math.sin(a) * rr, target[2]];
        if (prev) this.lines.line(prev, p, color);
        prev = p;
      }
    }
    this.lines.line([target[0] - 1.7, target[1], target[2]], [target[0] + 1.7, target[1], target[2]], color);
    this.lines.line([target[0], target[1] - 1.7, target[2]], [target[0], target[1] + 1.7, target[2]], color);
  }

  private addFrustum(camera: CameraOverlay): void {
    const color: [number, number, number] = camera.selected ? [1.0, 0.85, 0.45] : [0.85, 0.7, 0.4];
    const green: [number, number, number] = [0.55, 1, 0.65];
    const d = 7;
    const th = Math.tan(camera.fovY / 2) * d;
    const tw = th * camera.aspect;
    const q = camera.rotation;
    const origin = camera.position;

    const local = (x: number, y: number, z: number): Vec3 => add(origin, quatRotateVec(q, [x, y, z]) as Vec3);
    const far: Vec3[] = [local(-tw, -th, d), local(tw, -th, d), local(tw, th, d), local(-tw, th, d)];
    const nd = Math.max(camera.near, 0.08);
    const nth = Math.tan(camera.fovY / 2) * nd;
    const ntw = nth * camera.aspect;
    const near: Vec3[] = [local(-ntw, -nth, nd), local(ntw, -nth, nd), local(ntw, nth, nd), local(-ntw, nth, nd)];

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.lines.line(far[i], far[j], color);
      this.lines.line(near[i], near[j], color);
      this.lines.line(origin, far[i], color);
      this.lines.line(near[i], far[i], color);
    }
    this.lines.line(origin, local(0, 0, d * 1.2), green);
    for (const [sxg, syg] of [[1, 0], [0, 1]] as const) {
      this.lines.line(
        local(sxg * ntw, syg * nth, nd),
        local(sxg * tw, syg * th, d),
        [0.3, 0.5, 0.6],
      );
    }

    const b = 0.3;
    const body: Vec3[] = [
      local(-b, -b * 0.7, -b), local(b, -b * 0.7, -b), local(b, b * 0.7, -b), local(-b, b * 0.7, -b),
      local(-b, -b * 0.7, 0), local(b, -b * 0.7, 0), local(b, b * 0.7, 0), local(-b, b * 0.7, 0),
    ];
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [a, bb] of edges) this.lines.line(body[a], body[bb], color);
  }

  /** World -> CSS pixel projection, relative to the canvas client rect. */
  projectToScreen(vp: Mat4, point: Vec3): { x: number; y: number; depth: number; visible: boolean } {
    const [x, y, z] = point;
    const clipX = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const clipY = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const clipZ = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    const clipW = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (Math.abs(clipW) < 1e-6) return { x: 0, y: 0, depth: 1, visible: false };
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const ndcZ = clipZ / clipW;
    return {
      x: ((ndcX + 1) / 2) * this.canvas.clientWidth,
      y: ((1 - ndcY) / 2) * this.canvas.clientHeight,
      depth: ndcZ,
      visible: clipW > 0 && ndcZ >= -1 && ndcZ <= 1,
    };
  }

  /** Unprojects a CSS-pixel point into a ray in world space. */
  screenRay(orbit: OrbitCamera, px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const vp = this.viewProjection(orbit);
    const ndcX = (px / Math.max(1, this.canvas.clientWidth)) * 2 - 1;
    const ndcY = 1 - (py / Math.max(1, this.canvas.clientHeight)) * 2;
    const inv = invert(vp);
    const unproject = (z: number): Vec3 => {
      const x = inv[0] * ndcX + inv[4] * ndcY + inv[8] * z + inv[12];
      const y = inv[1] * ndcX + inv[5] * ndcY + inv[9] * z + inv[13];
      const zz = inv[2] * ndcX + inv[6] * ndcY + inv[10] * z + inv[14];
      const w = inv[3] * ndcX + inv[7] * ndcY + inv[11] * z + inv[15];
      const iw = Math.abs(w) < 1e-9 ? 1 : 1 / w;
      return [x * iw, y * iw, zz * iw] as Vec3;
    };
    const near = unproject(-1);
    const far = unproject(1);
    return { origin: near, dir: normalize(sub(far, near), [0, 0, 1]) };
  }

  dispose(): void {
    this.meshes.dispose();
    this.lines.dispose();
    this.gl.deleteVertexArray(this.gridVao);
    this.gl.deleteBuffer(this.gridVbo);
  }
}

export const ORBIT_DEFAULTS: OrbitCamera = {
  target: [0, 6, 0],
  distance: 78,
  yaw: 0.85,
  pitch: 0.42,
};
