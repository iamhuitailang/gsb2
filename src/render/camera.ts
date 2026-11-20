import {
  add3,
  cross3,
  identity4,
  invert4,
  lookAt4,
  multiply4,
  norm3,
  perspective4,
  scale3,
  sub3,
  transformPoint4,
  type Mat4,
  type Vec3,
} from "../core/math";

/**
 * 轨道相机：围绕 target 做球面旋转，滚轮缩放，右键/中键平移。
 * 同时负责屏幕坐标 <-> 世界射线的换算，笔刷落点精度完全依赖这里的
 * 逆 VP 矩阵，因此缩放后落点仍与模型表面严格对齐。
 */
export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 120;
  azimuth = Math.PI * 0.25;
  elevation = Math.PI * 0.28;
  fovY = Math.PI / 4;
  near = 0.5;
  far = 4000;

  private viewportW = 1;
  private viewportH = 1;
  private proj: Mat4 = identity4();
  private view: Mat4 = identity4();
  private viewProj: Mat4 = identity4();
  private invViewProj: Mat4 = identity4();

  eye: Vec3 = [0, 0, 0];

  setViewport(w: number, h: number): void {
    this.viewportW = Math.max(1, w);
    this.viewportH = Math.max(1, h);
  }

  update(): void {
    const ce = Math.cos(this.elevation);
    this.eye = [
      this.target[0] + this.distance * ce * Math.cos(this.azimuth),
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * ce * Math.sin(this.azimuth),
    ];
    const aspect = this.viewportW / this.viewportH;
    this.proj = perspective4(this.fovY, aspect, this.near, this.far);
    this.view = lookAt4(this.eye, this.target, [0, 1, 0]);
    this.viewProj = multiply4(this.proj, this.view);
    this.invViewProj = invert4(this.viewProj);
  }

  get viewProjection(): Mat4 {
    return this.viewProj;
  }

  get position(): Vec3 {
    return this.eye;
  }

  rotate(dx: number, dy: number): void {
    const k = 0.005;
    this.azimuth -= dx * k;
    this.elevation += dy * k;
    const lim = Math.PI / 2 - 0.05;
    this.elevation = Math.max(-lim, Math.min(lim, this.elevation));
  }

  zoom(delta: number): void {
    // 指数缩放，手感一致
    this.distance *= Math.exp(delta * 0.0012);
    this.distance = Math.max(2, Math.min(2000, this.distance));
  }

  /** 屏幕像素位移 -> 世界平移（保持相机朝向）。 */
  pan(dx: number, dy: number): void {
    const forward = norm3(sub3(this.target, this.eye));
    const right = norm3(cross3(forward, [0, 1, 0]));
    const up = cross3(right, forward);
    const scale = (this.distance * Math.tan(this.fovY / 2) * 2) / this.viewportH;
    const move = add3(
      scale3(right, -dx * scale),
      scale3(up, dy * scale)
    );
    this.target = add3(this.target, move);
  }

  /** 屏幕像素坐标 -> 世界空间射线（起点 + 单位方向）。 */
  screenRay(px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const nx = (px / this.viewportW) * 2 - 1;
    const ny = 1 - (py / this.viewportH) * 2;
    const near = transformPoint4(this.invViewProj, [nx, ny, -1]);
    const far = transformPoint4(this.invViewProj, [nx, ny, 1]);
    return {
      origin: near,
      dir: norm3(sub3(far, near)),
    };
  }

  /** 把世界点投影回屏幕像素（用于调试/标注）。 */
  worldToScreen(p: Vec3): [number, number] {
    const m = this.viewProj;
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return [
      ((cx + 1) * 0.5) * this.viewportW,
      ((1 - cy) * 0.5) * this.viewportH,
    ];
  }
}
