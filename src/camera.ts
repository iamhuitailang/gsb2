import {
  matLookAt,
  matMultiply,
  matPerspective,
  type Mat4,
  type Vec3,
} from './math';

export interface CameraSnapshot {
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
}

const DEFAULT_SNAPSHOT: CameraSnapshot = {
  yaw: 0.7,
  pitch: 0.42,
  distance: 26,
  target: [0, 0, 0],
};

export class OrbitCamera {
  yaw = DEFAULT_SNAPSHOT.yaw;
  pitch = DEFAULT_SNAPSHOT.pitch;
  distance = DEFAULT_SNAPSHOT.distance;
  target: Vec3 = [...DEFAULT_SNAPSHOT.target];
  fovy = Math.PI / 4;
  near = 0.1;
  far = 200;

  private aspect = 1;

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch += dy * 0.005;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  zoom(delta: number): void {
    this.distance *= Math.exp(delta * 0.0012);
    this.distance = Math.max(2, Math.min(120, this.distance));
  }

  /** 屏幕空间平移：把像素位移换算为过 target 的相机平面上的世界位移 */
  pan(dx: number, dy: number, width: number, height: number): void {
    const eye = this.eye();
    const forward = this.normalize([
      this.target[0] - eye[0],
      this.target[1] - eye[1],
      this.target[2] - eye[2],
    ]);
    const right = this.normalize(cross([0, 1, 0], forward));
    const up = cross(forward, right);
    const worldPerPixel =
      (2 * this.distance * Math.tan(this.fovy / 2)) / height;
    const shift = [
      -dx * worldPerPixel,
      dy * worldPerPixel,
      0,
    ] as Vec3;
    const move = add(scale(right, shift[0]), scale(up, shift[1]));
    this.target = add(this.target, move);
    void width;
  }

  eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  viewProj(): Mat4 {
    const proj = matPerspective(this.fovy, this.aspect, this.near, this.far);
    const view = matLookAt(this.eye(), this.target, [0, 1, 0]);
    return matMultiply(proj, view);
  }

  snapshot(): CameraSnapshot {
    return {
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      target: [...this.target] as Vec3,
    };
  }

  restore(snap: CameraSnapshot): void {
    this.yaw = snap.yaw;
    this.pitch = snap.pitch;
    this.distance = snap.distance;
    this.target = [...snap.target];
  }

  reset(): void {
    this.restore(DEFAULT_SNAPSHOT);
  }

  private normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

// 供标签投影复用的小工具：世界点 -> 屏幕 CSS 像素
export function worldToScreen(
  mvp: Mat4,
  p: Vec3,
  width: number,
  height: number,
): { x: number; y: number; visible: boolean } {
  const x =
    mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12];
  const y =
    mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13];
  const z =
    mvp[2] * p[0] + mvp[6] * p[1] + mvp[10] * p[2] + mvp[14];
  const w =
    mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15];
  if (w <= 0) return { x: 0, y: 0, visible: false };
  const ndcX = x / w;
  const ndcY = y / w;
  const ndcZ = z / w;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    visible: ndcZ >= -1 && ndcZ <= 1,
  };
}
