import type { AppDeps } from './deps';
import type { Waypoint } from '../core/types';
import { h, numberField } from './dom';

export function renderRouteTab(deps: AppDeps): HTMLElement {
  const rowsWrap = h('div', { class: 'wp-list' });

  const groundBtn = h(
    'button',
    {
      class: `btn small block ${deps.groundAddMode ? 'active' : ''}`,
      onclick: () => deps.setGroundAddMode(!deps.groundAddMode),
    },
    deps.groundAddMode ? '● 地面加点模式开启中：点击场景地面添加（再次点击关闭）' : '○ 开启「点击地面添加路径点」',
  );

  const charBtn = h(
    'button',
    { class: 'btn small block', onclick: () => deps.addWaypointAtCharacter() },
    '＋ 在假角色当前位置追加路径点',
  );

  function renderRows() {
    rowsWrap.innerHTML = '';
    deps.project.route.waypoints.forEach((w, i) => {
      const patch = (fn: (ww: Waypoint) => void) => {
        fn(w);
        deps.notifyChange('route');
      };

      const xInput = compactNum('X', w.x, (v) => patch((ww) => void (ww.x = v)));
      const yInput = compactNum('Y', w.y, (v) => patch((ww) => void (ww.y = v)));
      const zInput = compactNum('Z', w.z, (v) => patch((ww) => void (ww.z = v)));
      const tInput = compactNum('移动s', w.moveTime, (v) => patch((ww) => void (ww.moveTime = Math.max(0.05, v))), 0.1);
      const holdInput = compactNum('停留s', w.hold, (v) => patch((ww) => void (ww.hold = Math.max(0, v))), 0.1);

      const nameInput = h('input', {
        class: 'text-input tiny wp-name',
        value: w.name,
        placeholder: `路径点 ${i + 1}`,
      }) as HTMLInputElement;
      nameInput.addEventListener('change', () =>
        patch((ww) => {
          ww.name = nameInput.value;
        }),
      );

      const card = h(
        'div',
        { class: 'wp-card' },
        h(
          'div',
          { class: 'wp-head' },
          h('span', { class: `wp-index ${i === 0 ? 'first' : i === deps.project.route.waypoints.length - 1 ? 'last' : ''}` }, String(i + 1)),
          nameInput,
          h(
            'button',
            {
              class: 'icon-btn',
              title: '时间轴定位到该点',
              onclick: () => deps.seekToWaypoint(w.id),
            },
            '⏯',
          ),
          h(
            'button',
            {
              class: 'icon-btn danger',
              title: '删除路径点',
              onclick: () => {
                deps.removeWaypoint(w.id);
                renderRows();
              },
            },
            '✕',
          ),
        ),
        h('div', { class: 'wp-coords' }, xInput, yInput, zInput),
        h('div', { class: 'wp-times' }, tInput, holdInput),
      );
      rowsWrap.append(card);
    });
  }

  renderRows();

  const hint = h(
    'div',
    { class: 'help-box' },
    h('p', {}, '路线由有序路径点组成，点间使用向心 Catmull-Rom 曲线平滑连接；「移动s」是从上一点到该点的秒数，「停留s」是到达后的停顿。'),
    h('p', {}, '编辑方式：① 直接改坐标/时间；② 开启地面加点后点击 3D 地面；③ 在角色当前位置追加；④ 用顶部「保存项目」存 JSON，或直接编辑 JSON 后「打开项目」。详见 README。'),
    h('p', { class: 'muted' }, '提示：顶部循环模式切到「往返」，角色会反向经过所有区域，可验证镜头不会突然跳回。'),
  );

  return h(
    'div',
    { class: 'tab-route' },
    h('div', { class: 'btn-row vertical' }, groundBtn, charBtn),
    rowsWrap,
    hint,
  );
}

function compactNum(label: string, value: number, onChange: (v: number) => void, step = 0.25) {
  const field = numberField({ label, value, step, digits: 2, onChange });
  field.el.classList.add('compact-field');
  return field.el;
}
