import { clamp } from './math.js';

const PLAYER_RADIUS = 0.27;
const EYE_HEIGHT = 1.62;

function circleHitsRect(x, z, r, c) {
  const nx = clamp(x, c.minX, c.maxX);
  const nz = clamp(z, c.minZ, c.maxZ);
  const dx = x - nx;
  const dz = z - nz;
  return dx * dx + dz * dz < r * r;
}

export class FirstPersonControls {
  constructor(canvas, camera, scene, doorOpen, onToggleDoor) {
    this.canvas = canvas;
    this.camera = camera;
    this.scene = scene;
    this.doorOpen = doorOpen;
    this.onToggleDoor = onToggleDoor;
    this.keys = new Set();
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.enabled = true;

    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        try {
          const result = canvas.requestPointerLock();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch { /* drag-look still works if pointer lock is unavailable */ }
      }
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.lastX = e.touches[0].clientX;
        this.lastY = e.touches[0].clientY;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this.look(t.clientX - this.lastX, t.clientY - this.lastY);
        this.lastX = t.clientX;
        this.lastY = t.clientY;
      }
    }, { passive: true });
  }

  handleKeyDown(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    this.keys.add(e.code);
    if (e.code === 'KeyE' && !e.repeat) {
      const id = this.nearestPortal();
      if (id && this.onToggleDoor) this.onToggleDoor(id);
    }
  }

  handleMouseMove(e) {
    if (document.pointerLockElement === this.canvas) {
      this.look(e.movementX || 0, e.movementY || 0);
    } else if (this.dragging) {
      this.look(e.clientX - this.lastX, e.clientY - this.lastY);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  }

  look(dx, dy) {
    if (!this.enabled) return;
    this.camera.yaw += dx * 0.00225;
    this.camera.pitch = clamp((this.camera.pitch || 0) - dy * 0.00225, -1.35, 1.35);
  }

  blocked(x, z) {
    for (const c of this.scene.colliders) {
      if (circleHitsRect(x, z, PLAYER_RADIUS, c)) return true;
    }
    for (const c of this.scene.doorColliders) {
      if (this.doorOpen[c.portalId] === false && circleHitsRect(x, z, PLAYER_RADIUS, c)) return true;
    }
    return false;
  }

  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    let forward = 0;
    let strafe = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) forward += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) forward -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) strafe += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) strafe -= 1;

    if (forward === 0 && strafe === 0) return;
    const len = Math.hypot(forward, strafe) || 1;
    forward /= len;
    strafe /= len;

    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 5.0 : 3.15) * dt;
    const yaw = this.camera.yaw || 0;
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = Math.sin(yaw);

    const dx = (fx * forward + rx * strafe) * speed;
    const dz = (fz * forward + rz * strafe) * speed;
    const p = this.camera.position;

    // Axis-separated collision gives wall sliding.
    if (!this.blocked(p[0] + dx, p[2])) p[0] += dx;
    if (!this.blocked(p[0], p[2] + dz)) p[2] += dz;
    p[1] = EYE_HEIGHT;
  }

  nearestPortal(maxDistance = 2.35) {
    const [x, , z] = this.camera.position;
    let best = null;
    let bestD = maxDistance;
    for (const p of this.scene.portals) {
      const vx = p.x2 - p.x1;
      const vz = p.z2 - p.z1;
      const wx = x - p.x1;
      const wz = z - p.z1;
      const t = clamp((wx * vx + wz * vz) / (vx * vx + vz * vz), 0, 1);
      const px = p.x1 + vx * t;
      const pz = p.z1 + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }
}
