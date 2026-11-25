/**
 * 轻量轨道视角控制器。
 * 左键保留给绘制工具；旋转使用右键 / 中键 / 按住空格后的任意拖动。
 */
import * as THREE from 'three';

export class OrbitController {
  private spherical = new THREE.Spherical();
  private target = new THREE.Vector3();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private spaceHeld = false;
  private disposed = false;

  // 阻尼用当前速度
  private velTheta = 0;
  private velPhi = 0;

  minDistance = 0.05;
  maxDistance = 100;
  rotateSpeed = 0.005;
  zoomSpeed = 0.0015;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    this.syncFromCamera();
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  /** 是否正在旋转视角（UI 用来屏蔽绘制） */
  get isNavigating(): boolean {
    return this.dragging;
  }

  get spaceNavigation(): boolean {
    return this.spaceHeld;
  }

  syncFromCamera(): void {
    const offset = this.camera.position.clone().sub(this.target);
    this.spherical.setFromVector3(offset);
  }

  setTarget(target: THREE.Vector3): void {
    this.target.copy(target);
    this.update();
  }

  /** 根据模型包围球重置视角 */
  frameObject(center: THREE.Vector3, radius: number): void {
    this.target.copy(center);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.25;
    this.spherical.radius = THREE.MathUtils.clamp(
      dist,
      this.minDistance,
      this.maxDistance,
    );
    this.spherical.theta = Math.PI / 4;
    this.spherical.phi = Math.PI / 3;
    this.update();
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !this.isTypingTarget(e)) {
      this.spaceHeld = true;
      this.dom.style.cursor = 'grab';
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      this.spaceHeld = false;
      this.dom.style.cursor = '';
    }
  };

  private isTypingTarget(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  private onPointerDown = (e: PointerEvent) => {
    const isNavButton = e.button === 1 || e.button === 2 || this.spaceHeld;
    if (!isNavButton) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dom.setPointerCapture(e.pointerId);
    this.dom.style.cursor = 'grabbing';
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.velTheta = -dx * this.rotateSpeed;
    this.velPhi = -dy * this.rotateSpeed;
    this.spherical.theta += this.velTheta;
    this.spherical.phi = THREE.MathUtils.clamp(
      this.spherical.phi + this.velPhi,
      0.05,
      Math.PI - 0.05,
    );
    this.update();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.dom.style.cursor = this.spaceHeld ? 'grab' : '';
    try {
      this.dom.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * this.zoomSpeed);
    this.spherical.radius = THREE.MathUtils.clamp(
      this.spherical.radius * factor,
      this.minDistance,
      this.maxDistance,
    );
    this.update();
  };

  private update(): void {
    const pos = new THREE.Vector3().setFromSpherical(this.spherical).add(this.target);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
