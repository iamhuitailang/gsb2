import type { AppDeps } from './deps';
import { EASING_OPTIONS } from '../core/easing';
import type { CameraParams, CameraZone } from '../core/types';
import { checkboxField, colorField, h, numberField, section, selectField, vec3Field } from './dom';

const PARAM_META: { key: keyof CameraParams; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: 'distance', label: '跟随距离', min: 1.5, max: 16, step: 0.1, unit: 'm' },
  { key: 'targetHeight', label: '枢轴高度', min: 0, max: 3, step: 0.05, unit: 'm' },
  { key: 'height', label: '额外高度偏移', min: -2, max: 5, step: 0.05, unit: 'm' },
  { key: 'shoulder', label: '肩部水平偏移', min: -4, max: 4, step: 0.05, unit: 'm' },
  { key: 'pitch', label: '俯仰角', min: -15, max: 80, step: 1, unit: '°' },
  { key: 'yawOffset', label: '水平角度偏移', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'lookAhead', label: '前向注视', min: 0, max: 4, step: 0.1, unit: 'm' },
  { key: 'fov', label: '视野 FOV', min: 35, max: 90, step: 1, unit: '°' },
];

export function renderZoneTab(deps: AppDeps): HTMLElement {
  const listWrap = h('div', { class: 'zone-list' });
  const editorWrap = h('div', { class: 'zone-editor' });

  function renderList() {
    listWrap.innerHTML = '';
    deps.project.zones.forEach((z) => {
      listWrap.append(
        h(
          'button',
          {
            class: `zone-item ${deps.selectedZoneId === z.id ? 'selected' : ''}`,
            onclick: () => {
              deps.selectZone(z.id);
              renderList();
              renderEditor();
            },
          },
          h('span', { class: 'dot', style: `background:${z.color}` }),
          h('span', { class: 'zone-item-name' }, z.name),
          h('span', { class: 'zone-item-prio' }, `P${z.priority}`),
        ),
      );
    });
    listWrap.append(
      h(
        'button',
        {
          class: 'btn small block',
          onclick: () => {
            deps.addZone();
            renderList();
            renderEditor();
          },
        },
        '＋ 新建镜头区域',
      ),
    );
  }

  function renderEditor() {
    editorWrap.innerHTML = '';
    const zone = deps.project.zones.find((z) => z.id === deps.selectedZoneId);
    if (!zone) {
      editorWrap.append(h('p', { class: 'empty-hint' }, '在上方选择一个区域进行编辑，或新建区域。'));
      return;
    }

    const patch = (fn: (z: CameraZone) => void) => {
      fn(zone);
      deps.notifyChange('zones');
    };

    // ---- 基础 ----
    const basic = h('div', { class: 'form-grid' });
    basic.append(
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '区域名称'), (() => {
        const inp = h('input', { type: 'text', class: 'text-input', value: zone.name }) as HTMLInputElement;
        inp.addEventListener('change', () =>
          patch((z) => {
            z.name = inp.value || z.name;
          }),
        );
        return inp;
      })()),
      colorField({
        label: '标记颜色',
        value: zone.color,
        onChange: (v) => patch((z) => void (z.color = v)),
      }),
      numberField({
        label: '优先级（大优先）',
        value: zone.priority,
        step: 1,
        onChange: (v) => patch((z) => void (z.priority = Math.round(v))),
      }).el,
      numberField({
        label: '出区滞回',
        value: zone.hysteresis,
        min: 0,
        max: 2,
        step: 0.05,
        unit: 'm',
        onChange: (v) => patch((z) => void (z.hysteresis = v)),
      }).el,
    );

    // ---- 形状 ----
    const shape = h('div', {});
    shape.append(
      vec3Field({
        label: '中心 center',
        value: zone.center,
        onChange: (v) => patch((z) => void (z.center = v)),
      }),
      vec3Field({
        label: '尺寸 size（长宽高）',
        value: zone.size,
        onChange: (v) =>
          patch((z) => {
            z.size = [Math.max(0.2, v[0]), Math.max(0.2, v[1]), Math.max(0.2, v[2])];
          }),
      }),
      numberField({
        label: '绕 Y 旋转',
        value: zone.rotationY,
        min: -180,
        max: 180,
        step: 1,
        unit: '°',
        onChange: (v) => patch((z) => void (z.rotationY = v)),
      }).el,
    );

    // ---- 过渡 ----
    const trans = h('div', { class: 'form-grid' });
    trans.append(
      numberField({
        label: '切换缓动时间',
        value: zone.transitionTime,
        min: 0,
        max: 4,
        step: 0.05,
        unit: 's',
        onChange: (v) => patch((z) => void (z.transitionTime = Math.max(0, v))),
      }).el,
      selectField({
        label: '缓动曲线',
        value: zone.easing,
        options: EASING_OPTIONS,
        onChange: (v) => patch((z) => void (z.easing = v)),
      }).el,
    );

    // ---- 镜头参数 ----
    const paramsGrid = h('div', { class: 'form-grid' });
    for (const meta of PARAM_META) {
      paramsGrid.append(
        numberField({
          label: meta.label,
          value: zone.params[meta.key],
          min: meta.min,
          max: meta.max,
          step: meta.step,
          unit: meta.unit,
          onChange: (v) =>
            patch((z) => {
              z.params[meta.key] = v;
            }),
        }).el,
      );
    }

    // ---- 边界 ----
    const boundsBox = h('div', {});
    boundsBox.append(
      checkboxField({
        label: '启用镜头世界坐标边界（最终机位 clamp 到 AABB）',
        value: zone.bounds.enabled,
        onChange: (v) => patch((z) => void (z.bounds.enabled = v)),
      }),
      vec3Field({
        label: '边界最小 min',
        value: zone.bounds.min,
        onChange: (v) => patch((z) => void (z.bounds.min = v)),
      }),
      vec3Field({
        label: '边界最大 max',
        value: zone.bounds.max,
        onChange: (v) => patch((z) => void (z.bounds.max = v)),
      }),
    );

    const danger = h('div', { class: 'btn-row' });
    danger.append(
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            deps.duplicateZone(zone.id);
            renderList();
            renderEditor();
          },
        },
        '复制区域',
      ),
      h(
        'button',
        {
          class: 'btn small danger',
          onclick: () => {
            deps.removeZone(zone.id);
            renderList();
            renderEditor();
          },
        },
        '删除区域',
      ),
    );

    editorWrap.append(
      section('基础', basic),
      section('区域形状（盒体）', shape),
      section('过渡缓动', trans),
      section('该区域镜头参数', paramsGrid),
      section('镜头边界 Bounds', boundsBox, false),
      danger,
    );
  }

  renderList();
  renderEditor();

  const root = h('div', { class: 'tab-zone' }, listWrap, editorWrap);
  // 暴露刷新：左栏整体 rerender 时会重新执行本函数，这里仅满足潜在调用
  (root as HTMLElement & { refresh?: () => void }).refresh = () => {
    renderList();
    renderEditor();
  };
  return root;
}
