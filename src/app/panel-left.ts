import type { CameraPathEditorUi } from './ui.js';
import type { LeftPanelApi, UiRefs } from './ui-types.js';
import {
  button,
  el,
  formatNumber,
  section,
  segmented,
} from './dom.js';
import { showToast } from './toast.js';
import { projectSummary } from './panels-helpers.js';
import type { Vec3 } from '../math/vec3.js';

/**
 * Left sidebar: project info, path controls, control-point list and the
 * inspector for the selected point.
 */
export function buildLeftPanel(ui: CameraPathEditorUi, refs: UiRefs): void {
  const host = document.getElementById('sidebar-left');
  if (!host) return;

  const api: LeftPanelApi = {
    refresh: () => render(true),
    refreshLight: () => render(false),
  };
  refs.left = api;

  let lastSignature = '';

  function signature(): string {
    const app = ui.app;
    return [
      app.selectedPointId,
      app.project.path.closed,
      app.project.name,
      app.project.path.points.map((p) => `${p.id}:${p.position.map((v) => v.toFixed(2)).join(',')}`).join('|'),
    ].join('#');
  }

  function render(full: boolean): void {
    if (!host) return;
    const sig = signature();
    if (!full && sig === lastSignature) {
      // Nothing visible changed; keep inputs (and their focus) untouched.
      return;
    }
    lastSignature = sig;
    // Selection/navigation state is read through closures inside each section,
    // so rebuilding the sidebar is safe. refreshLight() is only used while the
    // pointer is captured by the canvas, when no input holds focus.
    host.replaceChildren(
      buildProjectSection(ui),
      buildPathSection(ui),
      buildPointList(ui),
      buildPointInspector(ui),
    );
  }

  function buildProjectSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const nameInput = el('input', {
      type: 'text',
      class: 'num-input',
      value: app.project.name,
      ariaLabel: '镜头名称',
    });
    nameInput.style.fontFamily = 'var(--sans)';
    nameInput.addEventListener('change', () => {
      const next = nameInput.value.trim() || '未命名镜头';
      ui.mutate('重命名镜头', () => {
        app.project.name = next;
        app.markDirty();
      });
    });
    return section('镜头工程', [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: '名称' }),
        nameInput,
      ]),
      el('p', { class: 'hint-text', text: projectSummary(app.project) }),
      el('div', { class: 'info-grid mt-8' }, [
        el('div', { class: 'info-cell' }, [
          el('span', { text: '总时长' }),
          el('b', { text: `${app.duration.toFixed(2)}s` }),
        ]),
        el('div', { class: 'info-cell' }, [
          el('span', { text: '总帧数' }),
          el('b', { text: `${app.totalFrames}` }),
        ]),
      ]),
    ]);
  }

  function buildPathSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const closure = segmented({
      value: app.project.path.closed ? 'closed' : 'open',
      options: [
        { value: 'open', label: '开放路径' },
        { value: 'closed', label: '闭合路径', title: '首尾相连，曲线连续' },
      ],
      onChange: (value) => {
        if ((value === 'closed') !== app.project.path.closed) ui.toggleClosed();
      },
    });
    closure.classList.add('is-wide');

    const deleteDisabled = app.project.path.points.length <= 2 || app.selectedPointIndex < 0;
    return section('路径', [
      closure,
      el('div', { class: 'info-grid mt-8' }, [
        el('div', { class: 'info-cell' }, [
          el('span', { text: '控制点' }),
          el('b', { text: String(app.project.path.points.length) }),
        ]),
        el('div', { class: 'info-cell' }, [
          el('span', { text: '路径长度' }),
          el('b', { text: formatNumber(app.spline.totalLength) }),
        ]),
      ]),
      el('div', { class: 'btn-group is-grid mt-8' }, [
        button('＋ 插入控制点', () => {
          ui.mutate('插入控制点', () => app.addPointAfterSelected());
        }, { class: 'btn' }),
        button('在指针处加点', () => {
          ui.mutate('在时间指针处加控制点', () => app.addPointAtPlayhead());
          showToast('已在当前镜头位置插入控制点');
        }, { class: 'btn' }),
        button('删除控制点', () => ui.deleteSelectedPoint(), { class: 'btn is-danger', disabled: deleteDisabled }),
        button('框选全部', () => ui.frameAll(), { class: 'btn' }),
      ]),
      el('p', {
        class: 'hint-text',
        text: '曲线为向心 Catmull-Rom：移动控制点后曲线在每一点处保持 C1 连续；闭合时首尾自动平滑衔接。',
      }),
    ]);
  }

  function buildPointList(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const list = el('div', { class: 'list', dataset: { role: 'point-list' } });
    app.project.path.points.forEach((point, index) => {
      const item = el(
        'div',
        { class: `list-item${point.id === app.selectedPointId ? ' is-selected' : ''}` },
        [
          el('span', { class: 'idx', text: String(index + 1).padStart(2, '0') }),
          el('span', {
            class: 'name',
            text: `P${index + 1}  (${point.position.map((v) => formatNumber(v)).join(', ')})`,
          }),
          point.id === app.selectedPointId ? el('span', { class: 'badge is-active', text: '选中' }) : null,
        ],
      );
      item.addEventListener('click', () => {
        app.selectPoint(point.id);
        ui.refreshAll();
      });
      list.append(item);
    });
    return section('控制点', [list]);
  }

  function buildPointInspector(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const index = app.selectedPointIndex;
    const point = index >= 0 ? app.project.path.points[index] : undefined;
    const wrap = el('section', { class: 'panel-section', dataset: { role: 'point-inspector' } });
    wrap.append(el('h2', { class: 'panel-title', text: '控制点坐标' }));
    if (!point) {
      wrap.append(el('p', { class: 'hint-text', text: '在视口或列表中选择一个控制点以编辑坐标。' }));
      return wrap;
    }

    const axis = (label: string, name: 'X' | 'Y' | 'Z', component: number) => {
      const input = el('input', {
        type: 'number',
        class: 'num-input',
        value: formatNumber(point.position[component]),
        step: '0.1',
        ariaLabel: `${label} ${name}`,
      });
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        const next: Vec3 = [point.position[0], point.position[1], point.position[2]];
        next[component] = component === 1 ? Math.max(0.2, value) : value;
        ui.mutate(`移动 P${index + 1}`, () => app.movePoint(point.id, next));
      });
      return el('div', { class: 'vec-axis', dataset: { axis: name } }, [input]);
    };

    wrap.append(
      el('div', { class: 'vec-row' }, [
        el('span', { class: 'field-label', text: `P${index + 1} 位置` }),
        axis(`P${index + 1}`, 'X', 0),
        axis(`P${index + 1}`, 'Y', 1),
        axis(`P${index + 1}`, 'Z', 2),
      ]),
      el('p', {
        class: 'hint-text',
        text: 'Y 轴限制在地面以上。相邻控制点的切线由样条自动求解，移动后曲线立即重新连续。',
      }),
    );

    const nearestS = app.spline.nearest(point.position).s;
    const tangent = app.spline.tangentAt(nearestS);
    wrap.append(
      el('div', { class: 'info-grid mt-8' }, [
        el('div', { class: 'info-cell' }, [
          el('span', { text: '弧长参数 s' }),
          el('b', { text: `${(nearestS * 100).toFixed(1)}%` }),
        ]),
        el('div', { class: 'info-cell' }, [
          el('span', { text: '切线方向' }),
          el('b', { text: tangent.map((v) => v.toFixed(2)).join(' / ') }),
        ]),
      ]),
    );
    return wrap;
  }

  render(true);
}
