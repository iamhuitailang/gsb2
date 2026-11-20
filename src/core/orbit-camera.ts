// 轨道相机：左键旋转、右键/中键平移、滚轮缩放；状态可序列化以便项目文件恢复

import { bbox, mat4, v3, type BBox, type Mat4, type Vec3 } from './math';
import type { CameraState } from './types';

const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MIN_DISTANCE = 1e-4;

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 10;
  yaw = Math.PI * 0.25;
  pitch = Math.PI * 0.22;
  /** 垂直视角（弧度） */
  fovy = Math.PI / 4;
  aspect = 1;

  getState(): CameraState {
    return {
      target: [...this.target] as Vec3,
      distance: this.distance,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  setState(state: CameraState): void {
    this.target = [...state.target] as Vec3;
    this.distance = Math.max(MIN_DISTANCE, state.distance);
    this.yaw = state.yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch));
  }

  eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    const offset: Vec3 = [
      this.distance * cp * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw),
    ];
    return v3.add(this.target, offset);
  }

  viewMatrix(): Mat4 {
    return mat4.lookAt(this.eye(), this.target, [0, 1, 0]);
  }

  projectionMatrix(): Mat4 {
    // near/far 随距离缩放，避免大模型被远裁剪面切掉
    const near = Math.max(MIN_DISTANCE, this.distance / 1000);
    const far = Math.max(this.distance * 100, 100);
    return mat4.perspective(this.fovy, this.aspect, near, far);
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch + dy * 0.005),
    );
  }

  /** 屏幕像素位移 -> 目标点平移（在视图平面内） */
  pan(dx: number, dy: number, viewportHeight: number): void {
    const viewHeight = 2 * this.distance * Math.tan(this.fovy / 2);
    const worldPerPixel = viewHeight / Math.max(viewportHeight, 1);
    const eye = this.eye();
    const forward = v3.normalize(v3.sub(this.target, eye));
    const right = v3.normalize(v3.cross(forward, [0, 1, 0]));
    const up = v3.cross(right, forward);
    const move = v3.add(
      v3.scale(right, -dx * worldPerPixel),
      v3.scale(up, dy * worldPerPixel),
    );
    this.target = v3.add(this.target, move);
  }

  zoom(deltaY: number): void {
    // 指数缩放，手感与距离无关
    const factor = Math.exp(deltaY * 0.0012);
    this.distance = Math.max(MIN_DISTANCE, this.distance * factor);
  }

  /** 让指定包围盒适配视锥体；保留当前朝向 */
  frame(box: BBox): void {
    if (bbox.isEmpty(box)) return;
    this.target = bbox.center(box);
    const radius = Math.max(bbox.radius(box), 1e-4);
    // 垂直方向适配，再考虑宽高比
    const fitVertical = radius / Math.sin(this.fovy / 2);
    const aspectFactor = this.aspect < 1 ? 1 / Math.max(this.aspect, 0.1) : 1;
    this.distance = Math.max(MIN_DISTANCE, fitVertical * aspectFactor * 1.15);
  }
}
