import type { AppDeps } from './deps';
import type { CameraParams } from '../core/types';
import { checkboxField, h, numberField, section } from './dom';

const PARAM_META: { key: keyof CameraParams; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: 'distance', label: '默认跟随距离', min: 1.5, max: 16, step: 0.1, unit: 'm' },
  { key: 'targetHeight', label: '枢轴高度', min: 0, max: 3, step: 0.05, unit: 'm' },
  { key: 'height', label: '额外高度偏移', min: -2, max: 5, step: 0.05, unit: 'm' },
  { key: 'shoulder', label: '肩部水平偏移', min: -4, max: 4, step: 0.05, unit: 'm' },
  { key: 'pitch', label: '俯仰角', min: -15, max: 80, step: 1, unit: '°' },
  { key: 'yawOffset', label: '水平角度偏移', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'lookAhead', label: '前向注视', min: 0, max: 4, step: 0.1, unit: 'm' },
  { key: 'fov', label: '视野 FOV', min: 35, max: 90, step: 1, unit: '°' },
];

export function renderCameraTab(deps: AppDeps): HTMLElement {
  const p = deps.project.defaultParams;
  const grid = h('div', { class: 'form-grid' });
  for (const meta of PARAM_META) {
    grid.append(
      numberField({
        label: meta.label,
        value: p[meta.key],
        min: meta.min,
        max: meta.max,
        step: meta.step,
        unit: meta.unit,
        onChange: (v) => {
          p[meta.key] = v;
          deps.notifyChange('params');
        },
      }).el,
    );
  }

  const occ = deps.project.occlusion;
  const occBox = h('div', { class: 'form-grid' });
  occBox.append(
    checkboxField({
      label: '启用遮挡检测与自动避让',
      value: occ.enabled,
      onChange: (v) => {
        occ.enabled = v;
        deps.notifyChange('params');
      },
    }),
    numberField({
      label: '碰撞皮肤距离 skin',
      value: occ.skin,
      min: 0.05,
      max: 1,
      step: 0.05,
      unit: 'm',
      onChange: (v) => {
        occ.skin = v;
        deps.notifyChange('params');
      },
    }).el,
    numberField({
      label: '避让平滑时间',
      value: occ.smoothing,
      min: 0.01,
      max: 0.5,
      step: 0.01,
      unit: 's',
      onChange: (v) => {
        occ.smoothing = v;
        deps.notifyChange('params');
      },
    }).el,
    checkboxField({
      label: '允许侧向移位探测',
      value: occ.sideProbe,
      onChange: (v) => {
        occ.sideProbe = v;
        deps.notifyChange('params');
      },
    }),
    checkboxField({
      label: '允许抬高镜头探测',
      value: occ.raiseProbe,
      onChange: (v) => {
        occ.raiseProbe = v;
        deps.notifyChange('params');
      },
    }),
  );

  const help = h(
    'div',
    { class: 'help-box' },
    h('p', {}, '区域未覆盖角色时使用这里的默认参数。'),
    h('p', {}, '遮挡求解顺序：期望机位 → 沿射线前移 → 左右侧移（含侧移+回收）→ 抬高；选择调整代价最小且视线通畅的候选，并在右侧检查器给出中文避让原因。'),
  );

  return h(
    'div',
    { class: 'tab-camera' },
    section('默认跟随参数（无区域时）', grid),
    section('遮挡处理', occBox),
    help,
  );
}
