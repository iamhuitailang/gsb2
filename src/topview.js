const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value);
  }
  if (parent) parent.appendChild(el);
  return el;
}

const STATUS_LABEL = {
  continue: '继续',
  offscreen: '屏外',
  occluded: '遮挡',
  closed: '关门',
  cycle: '回路',
};

export class TopView {
  constructor(container, scene, { onSelect } = {}) {
    this.scene = scene;
    this.onSelect = onSelect;
    this.roomElements = new Map();
    this.portalElements = new Map();

    container.innerHTML = '';
    this.svg = svg('svg', {
      class: 'topview-svg',
      viewBox: '-7 -20.7 21.8 33.4',
      role: 'img',
      'aria-label': '房间和门洞可见性判定俯视图',
    }, container);

    svg('rect', { x: -7, y: -20.7, width: 21.8, height: 33.4, class: 'tv-background' }, this.svg);
    const roomLayer = svg('g', { class: 'tv-rooms' }, this.svg);
    const wallLayer = svg('g', { class: 'tv-walls' }, this.svg);
    const portalLayer = svg('g', { class: 'tv-portals' }, this.svg);
    this.overlayLayer = svg('g', { class: 'tv-overlay' }, this.svg);
    this.cameraLayer = svg('g', { class: 'tv-camera-layer' }, this.svg);

    for (const room of scene.rooms) {
      const g = svg('g', { class: 'tv-room-group', tabindex: '0', role: 'button' }, roomLayer);
      const rect = svg('rect', {
        x: room.x0, y: room.z0,
        width: room.x1 - room.x0, height: room.z1 - room.z0,
        rx: 0.18, class: 'tv-room',
      }, g);
      const cx = (room.x0 + room.x1) / 2;
      const cz = (room.z0 + room.z1) / 2;
      svg('text', {
        x: cx, y: cz - 0.35, class: 'tv-room-id', 'text-anchor': 'middle', text: room.id,
      }, g);
      svg('text', {
        x: cx, y: cz + 0.55, class: 'tv-room-name', 'text-anchor': 'middle', text: room.name,
      }, g);
      const title = svg('title', { text: `${room.id} ${room.name}：点击查看判定原因` }, rect);
      g.addEventListener('click', () => this.onSelect?.({ type: 'room', id: room.id }));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') this.onSelect?.({ type: 'room', id: room.id });
      });
      this.roomElements.set(room.id, { g, rect });
    }

    for (const w of scene.wallSegments) {
      if (w.orientation === 'H') {
        svg('line', { x1: w.a, y1: w.fixed, x2: w.b, y2: w.fixed, class: 'tv-wall' }, wallLayer);
      } else {
        svg('line', { x1: w.fixed, y1: w.a, x2: w.fixed, y2: w.b, class: 'tv-wall' }, wallLayer);
      }
    }

    for (const p of scene.portals) {
      const g = svg('g', { class: 'tv-portal-group' }, portalLayer);
      svg('line', { x1: p.x1, y1: p.z1, x2: p.x2, y2: p.z2, class: 'tv-door-base' }, g);
      const statusLine = svg('line', {
        x1: p.x1, y1: p.z1, x2: p.x2, y2: p.z2, class: 'tv-door-status',
      }, g);
      const hit = svg('line', {
        x1: p.x1, y1: p.z1, x2: p.x2, y2: p.z2, class: 'tv-door-hit',
      }, g);
      const mx = (p.x1 + p.x2) / 2;
      const mz = (p.z1 + p.z2) / 2;
      const badge = svg('g', { class: 'tv-badge', transform: `translate(${mx} ${mz})` }, g);
      const circle = svg('circle', { r: 0.43, class: 'tv-badge-circle' }, badge);
      const text = svg('text', {
        class: 'tv-badge-text', 'text-anchor': 'middle', 'dominant-baseline': 'central', text: '',
      }, badge);
      svg('title', { text: `${p.short} 门：点击查看各条搜索路径的判定` }, hit);
      g.style.cursor = 'pointer';
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect?.({ type: 'portal', id: p.id });
      });
      this.portalElements.set(p.id, { g, statusLine, badge, circle, text });
    }

    this.cone = svg('polygon', { class: 'tv-cone' }, this.cameraLayer);
    this.cameraDot = svg('circle', { r: 0.34, class: 'tv-camera-dot' }, this.cameraLayer);
    this.cameraRing = svg('circle', { r: 0.58, class: 'tv-camera-ring' }, this.cameraLayer);
    this.viewLine = svg('line', { class: 'tv-view-line' }, this.cameraLayer);
  }

  update({ trace, camera, selection, aspect = 1.25, doorOpen = {} }) {
    const visible = new Set(trace?.visibleRoomIds || []);
    const roots = new Set(trace?.cameraRoomIds || []);

    for (const [id, els] of this.roomElements) {
      els.g.classList.toggle('is-root', roots.has(id));
      els.g.classList.toggle('is-visible', !roots.has(id) && visible.has(id));
      els.g.classList.toggle('is-culled', !visible.has(id));
      els.g.classList.toggle('is-selected', selection?.type === 'room' && selection.id === id);
    }

    const byPortal = new Map();
    for (const e of trace?.evaluations || []) {
      if (!byPortal.has(e.portalId)) byPortal.set(e.portalId, []);
      byPortal.get(e.portalId).push(e);
    }

    for (const p of this.scene.portals) {
      const els = this.portalElements.get(p.id);
      const evals = byPortal.get(p.id) || [];
      const counts = { continue: 0, offscreen: 0, occluded: 0, closed: 0, cycle: 0 };
      for (const e of evals) counts[e.status] = (counts[e.status] || 0) + 1;

      let status = 'idle';
      if (doorOpen[p.id] === false || counts.closed > 0) status = 'closed';
      if (counts.continue > 0) status = 'continue';
      else if (status !== 'closed' && counts.occluded > 0) status = 'occluded';
      else if (status !== 'closed' && counts.offscreen > 0) status = 'offscreen';
      else if (counts.cycle > 0) status = 'cycle';

      els.g.dataset.status = status;
      els.g.classList.toggle('is-selected', selection?.type === 'portal' && selection.id === p.id);
      if (status === 'continue') {
        els.text.textContent = `↗${counts.continue}`;
      } else if (status === 'closed') {
        els.text.textContent = '关';
      } else if (status === 'occluded') {
        els.text.textContent = '遮';
      } else if (status === 'offscreen') {
        els.text.textContent = '外';
      } else if (status === 'cycle') {
        els.text.textContent = '↻';
      } else {
        els.text.textContent = '';
      }
      els.badge.style.display = els.text.textContent ? '' : 'none';
    }

    const [x, , z] = camera.position;
    const yaw = camera.yaw || 0;
    const halfFov = Math.atan(Math.tan((camera.fovY || Math.PI / 180 * 70) / 2) * aspect);
    const len = 6.2;
    const left = [x + Math.sin(yaw - halfFov) * len, z - Math.cos(yaw - halfFov) * len];
    const right = [x + Math.sin(yaw + halfFov) * len, z - Math.cos(yaw + halfFov) * len];
    this.cone.setAttribute('points', `${x},${z} ${left[0]},${left[1]} ${right[0]},${right[1]}`);
    this.cameraDot.setAttribute('cx', x);
    this.cameraDot.setAttribute('cy', z);
    this.cameraRing.setAttribute('cx', x);
    this.cameraRing.setAttribute('cy', z);
    const end = [x + Math.sin(yaw) * 1.05, z - Math.cos(yaw) * 1.05];
    this.viewLine.setAttribute('x1', x);
    this.viewLine.setAttribute('y1', z);
    this.viewLine.setAttribute('x2', end[0]);
    this.viewLine.setAttribute('y2', end[1]);
  }
}

export function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}
