import type { CameraState, LightState } from '../core/state.ts';

export type OrbitTarget = 'camera' | 'light';

/**
 * 鼠标/触控轨道控制。拖拽旋转（相机或灯光二选一），滚轮缩放相机距离。
 * 两个视口共用同一份 CameraState，保证左右画面始终同步。
 */
export function attachOrbit(
  el: HTMLElement,
  getTarget: () => OrbitTarget,
  camera: CameraState,
  light: LightState,
  onchange: () => void,
): () => void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const target = getTarget();
    if (target === 'camera') {
      camera.yawDeg += dx * 0.4;
      camera.pitchDeg = clamp(camera.pitchDeg - dy * 0.4, -85, 85);
    } else {
      light.yawDeg = clamp(light.yawDeg + dx * 0.4, -180, 180);
      light.pitchDeg = clamp(light.pitchDeg - dy * 0.4, -85, 85);
    }
    onchange();
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    camera.distance = clamp(camera.distance * Math.exp(e.deltaY * 0.001), 3, 22);
    onchange();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
