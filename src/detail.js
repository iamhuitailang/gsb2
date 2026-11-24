import { statusLabel } from './topview.js';

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function statusClass(status) {
  return `badge badge-${status}`;
}

function pathText(path) {
  return path.join(' → ');
}

function projectionText(p) {
  if (!p) return '';
  const parts = [];
  if (p.rect) parts.push(`投影 ${JSON.stringify(p.rect)}`);
  if (p.clipped) parts.push(`裁剪后 ${JSON.stringify(p.clipped)}`);
  if (p.parentRect) parts.push(`上一门区 ${JSON.stringify(p.parentRect)}`);
  if (typeof p.minEndpointDistance === 'number') parts.push(`门边最近 ${p.minEndpointDistance}m`);
  if (p.behindCornerCount) parts.push(`${p.behindCornerCount} 角点越近平面`);
  return `<div class="eval-meta">${parts.map(esc).join('；')}</div>`;
}

function evalCard(e) {
  return `
    <div class="eval-card">
      <div class="eval-head">
        <span class="${statusClass(e.status)}">${esc(statusLabel(e.status))}</span>
        <strong>${esc(e.portalShort)}</strong>
        <span class="eval-path">${esc(pathText(e.path))} ⇢ ${esc(e.toRoom)}</span>
      </div>
      <div class="eval-title">${esc(e.title)}</div>
      <p>${esc(e.message)}</p>
      ${projectionText(e.projection)}
    </div>`;
}

function roomHTML(selection, trace, scene, doorOpen) {
  const room = scene.rooms.find((r) => r.id === selection.id);
  if (!room) return '<p>未找到房间。</p>';
  const isRoot = trace.cameraRoomIds.includes(room.id);
  const isVisible = trace.visibleRoomIds.includes(room.id);
  const incoming = trace.evaluations.filter((e) => e.toRoom === room.id);
  const outgoing = trace.evaluations.filter((e) => e.fromRoom === room.id);
  const propCount = scene.propIds.filter((id) => id.startsWith(`${room.id}-`)).length;

  let headline;
  if (isRoot) headline = '<span class="badge badge-root">相机所在/交界</span> 从该房间以完整视锥开始查找，避免门槛处闪没。';
  else if (isVisible) headline = '<span class="badge badge-continue">保留并绘制</span> 至少一条门洞路径通过裁剪。';
  else headline = '<span class="badge badge-culled">略过</span> 所有到达该房间的候选路径都被门态或孔径裁剪拒绝。';

  return `
    <div class="detail-head">
      <h3>${esc(room.id)} · ${esc(room.name)}</h3>
      <button class="mini" data-select="null">返回总览</button>
    </div>
    <p class="detail-summary">${headline}</p>
    <p class="muted">尺寸 ${(room.x1 - room.x0).toFixed(1)}m × ${(room.z1 - room.z0).toFixed(1)}m；编号摆件 ${propCount} 组。</p>

    <h4>进入该房间的判定</h4>
    ${incoming.length ? incoming.map(evalCard).join('') : '<p class="muted">根房间没有“从其他门进入”的记录。</p>'}

    <h4>从该房间继续检查的门</h4>
    ${outgoing.length ? outgoing.map(evalCard).join('') : '<p class="muted">无。</p>'}
  `;
}

function portalHTML(selection, trace, scene, doorOpen) {
  const p = scene.portals.find((x) => x.id === selection.id);
  if (!p) return '<p>未找到门。</p>';
  const open = doorOpen[p.id] !== false;
  const evals = trace.evaluations.filter((e) => e.portalId === p.id);
  const roomA = scene.rooms.find((r) => r.id === p.a);
  const roomB = scene.rooms.find((r) => r.id === p.b);
  return `
    <div class="detail-head">
      <h3>${esc(p.short)} 门</h3>
      <button class="mini" data-toggle-portal="${esc(p.id)}">${open ? '关门' : '开门'}</button>
    </div>
    <p class="muted">${esc(roomA.id + ' ' + roomA.name)} ↔ ${esc(roomB.id + ' ' + roomB.name)}；当前<strong class="${open ? 'ok' : 'warn'}">${open ? '打开' : '关闭'}</strong>。</p>
    <p>${open
      ? '打开时会投影门洞并与沿途孔径求交；即使该门未通过，也会给出屏外或遮挡原因。'
      : '关闭时不继续搜索另一侧；门板属于相邻房间，仍会提交一次绘制。'}</p>
    <h4>这一帧的 ${evals.length} 条候选判定</h4>
    ${evals.length ? evals.map(evalCard).join('') : '<p class="muted">当前没有搜索路径到达此门。</p>'}
  `;
}

function overviewHTML(trace, scene, stats) {
  const visible = new Set(trace.visibleRoomIds);
  return `
    <h3>判定检查器</h3>
    <p class="muted">点俯视图中的房间或门，可查看这一帧保留/略过和继续查找的具体原因。</p>
    <div class="room-check-list">
      ${scene.rooms.map((r) => {
        const root = trace.cameraRoomIds.includes(r.id);
        const on = visible.has(r.id);
        const cls = root ? 'root' : on ? 'continue' : 'culled';
        const label = root ? '相机房间' : on ? '保留' : '略过';
        return `<button class="room-check ${cls}" data-select-room="${r.id}">
          <b>${esc(r.id)}</b><span>${esc(r.name)}</span><em>${label}</em>
        </button>`;
      }).join('')}
    </div>
    <div class="legend">
      <span><i class="dot dot-root"></i>相机/交界</span>
      <span><i class="dot dot-visible"></i>保留</span>
      <span><i class="dot dot-culled"></i>略过</span>
      <span><i class="dot dot-continue"></i>继续门</span>
    </div>
    ${stats ? `<p class="muted">当前分区列表 ${stats.meshes} 个几何块、${stats.propCount}/${scene.propIds.length} 组摆件；每个可见 ID 只在集合中出现一次。</p>` : ''}
  `;
}

export function detailHTML(selection, trace, scene, doorOpen, stats) {
  if (!trace) return '<h3>判定检查器</h3><p class="muted">正在初始化 WebGL…</p>';
  if (selection?.type === 'room') return roomHTML(selection, trace, scene, doorOpen);
  if (selection?.type === 'portal') return portalHTML(selection, trace, scene, doorOpen);
  return overviewHTML(trace, scene, stats);
}
