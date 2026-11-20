import type { CameraPathEditorUi } from './ui.js';
import type { RightPanelApi, UiRefs } from './ui-types.js';
import {
  button,
  checkField,
  el,
  formatNumber,
  numberField,
  section,
  segmented,
  selectField,
  sliderField,
} from './dom.js';
import { targetCandidates } from './panels-helpers.js';
import { formatAspect } from './guides.js';
import { showToast } from './toast.js';
import { SHAPES, type SceneObjectData } from '../core/types.js';
import type { Vec3 } from '../math/vec3.js';

const FOCAL_PRESETS = [18, 24, 35, 50, 85, 135];
const ASPECT_PRESETS: Array<[number, string]> = [
  [16 / 9, '16:9'],
  [2.39, '2.39:1'],
  [1.85, '1.85:1'],
  [4 / 3, '4:3'],
  [1, '1:1'],
  [9 / 16, '9:16'],
];

/**
 * Right sidebar: lens, aim mode, composition guides and scene objects.
 */
export function buildRightPanel(ui: CameraPathEditorUi, refs: UiRefs): void {
  const host = document.getElementById('sidebar-right');
  if (!host) return;

  const api: RightPanelApi = {
    refresh: () => render(true),
    // Live drags in the viewport do too little to the right panel to justify a
    // rebuild (which would steal focus from inputs); the 3D view is redrawn
    // by the caller via needsRenderNow().
    refreshLight: () => undefined,
  };
  refs.right = api;

  function render(_full: boolean): void {
    if (!host) return;
    host.replaceChildren(
      buildLensSection(ui),
      buildAimSection(ui),
      buildAimPreviewSection(ui),
      buildCompositionSection(ui),
      buildObjectsSection(ui),
    );
  }

  function buildLensSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const cam = app.project.camera;
    const fov = app.fov;
    const fovYdeg = (fov.fovY * 180) / Math.PI;
    const fovXdeg = (fov.fovX * 180) / Math.PI;

    const focal = sliderField({
      label: '焦距',
      value: cam.focalLengthMm,
      min: 10,
      max: 200,
      step: 1,
      unit: ' mm',
      onStart: () => ui.beginEdit('调整焦距'),
      onChange: (v) => {
        app.setFocalLength(v);
        ui.needsRenderNow();
        const valueLabel = focal.querySelector('.field-value');
        if (valueLabel) valueLabel.textContent = `${formatNumber(v)} mm`;
        const readout = focal.ownerDocument.getElementById('fov-readout');
        if (readout) {
          const current = app.fov;
          readout.textContent = `${((current.fovX * 180) / Math.PI).toFixed(1)}°`;
        }
      },
      onCommit: () => {
        ui.commitEdit({ refresh: false });
        api.refresh();
      },
    });

    const presets = el('div', { class: 'btn-group' });
    for (const mm of FOCAL_PRESETS) {
      presets.append(
        button(`${mm}`, () => {
          ui.mutate('调整焦距', () => app.setFocalLength(mm), { refresh: 'none' });
          api.refresh();
        }, { class: Math.abs(cam.focalLengthMm - mm) < 0.5 ? 'btn is-primary' : 'btn' }),
      );
    }

    return section('镜头 · 焦距与视野', [
      focal,
      presets,
      el('div', { class: 'info-grid mt-8' }, [
        el('div', { class: 'info-cell' }, [
          el('span', { text: '垂直视野' }),
          el('b', { text: `${fovYdeg.toFixed(1)}°` }),
        ]),
        el('div', { class: 'info-cell' }, [
          el('span', { text: '水平视野' }),
          el('b', { id: 'fov-readout', text: `${fovXdeg.toFixed(1)}°` }),
        ]),
      ]),
      el('div', { class: 'divider' }),
      numberField({
        label: '传感器高',
        value: cam.sensorHeightMm,
        min: 4,
        max: 70,
        step: 0.5,
        unit: 'mm',
        onChange: (v) => ui.mutate('调整传感器', () => {
          app.project.camera.sensorHeightMm = v;
          app.markDirty();
        }),
      }),
      numberField({
        label: '近裁切',
        value: cam.near,
        min: 0.01,
        max: 10,
        step: 0.01,
        onChange: (v) => ui.mutate('调整近裁切', () => {
          app.project.camera.near = v;
          app.markDirty();
        }),
      }),
      numberField({
        label: '远裁切',
        value: cam.far,
        min: 50,
        max: 20000,
        step: 50,
        onChange: (v) => ui.mutate('调整远裁切', () => {
          app.project.camera.far = v;
          app.markDirty();
        }),
      }),
      el('p', { class: 'hint-text', text: '焦距由传感器高度换算垂直视野，水平视野随画幅比例变化。' }),
    ]);
  }

  function buildAimSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const aim = app.project.camera.aim;
    const mode = segmented({
      value: aim.mode,
      options: [
        { value: 'tangent', label: '沿切线', title: '镜头朝向路径前进方向' },
        { value: 'target', label: '跟随目标', title: '镜头始终看向指定目标' },
      ],
      onChange: (value) => {
        ui.mutate(value === 'target' ? '切换为跟随目标' : '切换为沿切线', () => {
          app.setAimMode(value as 'tangent' | 'target');
        });
        if (value === 'target') showToast('四元数插值过渡中，镜头不会翻转');
      },
    });
    mode.classList.add('is-wide');

    const candidates = targetCandidates(app.project);
    const targetSelect = selectField({
      label: '目标物体',
      value: aim.targetObjectId ?? '',
      options: [
        { value: '', label: '（使用目标点坐标）' },
        ...candidates.map((o) => ({
          value: o.id,
          label: `${o.name}${o.role === 'target' ? ' · 目标' : ''}`,
        })),
      ],
      onChange: (value) => {
        ui.mutate('更换目标', () => app.setTargetObject(value || null));
      },
    });

    const numberAxis = (
      label: string,
      axis: 'X' | 'Y' | 'Z',
      value: number,
      apply: (next: number) => void,
    ): HTMLElement => {
      const input = el('input', {
        type: 'number',
        class: 'num-input',
        value: formatNumber(value),
        step: '0.1',
        ariaLabel: `${label} ${axis}`,
      });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) ui.mutate(label, () => apply(v));
      });
      return el('div', { class: 'vec-axis', dataset: { axis } }, [input]);
    };

    const offsetRow = el('div', { class: 'vec-row' }, [
      el('span', { class: 'field-label', text: '目标偏移' }),
      ...([0, 1, 2] as const).map((i) =>
        numberAxis('调整目标偏移', (['X', 'Y', 'Z'] as const)[i], aim.targetOffset[i], (v) => {
          const next: Vec3 = [aim.targetOffset[0], aim.targetOffset[1], aim.targetOffset[2]];
          next[i] = v;
          app.project.camera.aim.targetOffset = next;
          app.markDirty();
        }),
      ),
    ]);

    const pointRow = el('div', { class: 'vec-row' }, [
      el('span', { class: 'field-label', text: '目标点' }),
      ...([0, 1, 2] as const).map((i) =>
        numberAxis('调整目标点', (['X', 'Y', 'Z'] as const)[i], aim.targetPoint[i], (v) => {
          const next: Vec3 = [aim.targetPoint[0], aim.targetPoint[1], aim.targetPoint[2]];
          next[i] = v;
          app.project.camera.aim.targetPoint = next;
          app.markDirty();
        }),
      ),
    ]);

    const roll = sliderField({
      label: '镜头滚转',
      value: aim.rollDeg,
      min: -180,
      max: 180,
      step: 1,
      unit: '°',
      onStart: () => ui.beginEdit('调整滚转'),
      onChange: (v) => {
        app.project.camera.aim.rollDeg = v;
        app.markDirty();
        ui.needsRenderNow();
      },
      onCommit: () => ui.commitEdit({ refresh: false }),
    });

    return section('镜头朝向', [
      mode,
      el('p', {
        class: 'hint-text',
        text: '两种模式之间用四元数 slerp 过渡（约 0.45s），切换时不会出现 180° 翻转。',
      }),
      targetSelect,
      offsetRow,
      el('p', { class: 'hint-text', text: '未选择目标物体时，使用固定目标点坐标。' }),
      pointRow,
      roll,
      el('div', { class: 'info-grid mt-8' }, [
        el('div', { class: 'info-cell' }, [
          el('span', { text: '当前模式' }),
          el('b', { text: aim.mode === 'target' ? '跟随目标' : '沿切线' }),
        ]),
        el('div', { class: 'info-cell' }, [
          el('span', { text: '混合系数' }),
          el('b', { text: ui.app.aimBlender.mix.toFixed(2) }),
        ]),
      ]),
    ]);
  }

  function buildAimPreviewSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    return section('朝向过渡预览', [
      el('div', { class: 'btn-group is-grid' }, [
        button('切向 → 目标', () => {
          app.previewAimMode('target', 1100);
          ui.needsRenderNow();
          showToast('预览：切向 → 目标（不改动项目数据）');
        }, { class: 'btn' }),
        button('目标 → 切向', () => {
          app.previewAimMode('tangent', 1100);
          ui.needsRenderNow();
          showToast('预览：目标 → 切向（不改动项目数据）');
        }, { class: 'btn' }),
      ]),
      el('p', {
        class: 'hint-text',
        text: '预览只改变视口里的朝向插值，不写入项目文件，用于检查过渡过程中是否出现翻滚。',
      }),
    ]);
  }

  function buildCompositionSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const comp = app.project.composition;
    const aspectButtons = el('div', { class: 'btn-group' });
    for (const [value, label] of ASPECT_PRESETS) {
      aspectButtons.append(
        button(label, () => {
          ui.mutate('调整画幅比例', () => app.setComposition({ aspect: value }));
        }, { class: Math.abs(comp.aspect - value) < 0.01 ? 'btn is-primary' : 'btn' }),
      );
    }

    const toggle = (
      label: string,
      key: 'showThirds' | 'showCenter' | 'showActionSafe' | 'showTitleSafe',
    ) =>
      checkField({
        label,
        checked: comp[key],
        onChange: (checked) => ui.mutate('切换构图辅助线', () => app.setComposition({ [key]: checked })),
      });

    return section('画幅与构图', [
      el('div', { class: 'row-between mb-6' }, [
        el('span', { class: 'field-label', text: '当前画幅' }),
        el('span', { class: 'badge is-mono', text: formatAspect(comp.aspect) }),
      ]),
      aspectButtons,
      numberField({
        label: '自定义比例',
        value: Number(comp.aspect.toFixed(3)),
        min: 0.5,
        max: 3,
        step: 0.01,
        onChange: (v) => ui.mutate('调整画幅比例', () => app.setComposition({ aspect: v })),
      }),
      el('div', { class: 'divider' }),
      toggle('三分线', 'showThirds'),
      toggle('中心线 / 中心点', 'showCenter'),
      toggle('动作安全框', 'showActionSafe'),
      toggle('字幕安全框', 'showTitleSafe'),
      sliderField({
        label: '安全框比例',
        value: comp.actionSafePct,
        min: 60,
        max: 99,
        step: 1,
        unit: '%',
        onStart: () => ui.beginEdit('调整安全框'),
        onChange: (v) => {
          app.setComposition({ actionSafePct: v });
          ui.guidesDirty();
        },
        onCommit: () => ui.commitEdit({ refresh: false }),
      }),
      sliderField({
        label: '字幕框比例',
        value: comp.titleSafePct,
        min: 50,
        max: 95,
        step: 1,
        unit: '%',
        onStart: () => ui.beginEdit('调整字幕框'),
        onChange: (v) => {
          app.setComposition({ titleSafePct: v });
          ui.guidesDirty();
        },
        onCommit: () => ui.commitEdit({ refresh: false }),
      }),
      el('p', {
        class: 'hint-text',
        text: '辅助线是 DOM 覆盖层，仅用于构图参考；导出截图使用纯 WebGL 画面，不包含任何辅助线。',
      }),
    ]);
  }

  function buildObjectsSection(ui: CameraPathEditorUi): HTMLElement {
    const app = ui.app;
    const selected = app.selectedObject;
    const list = el('div', { class: 'list' });

    // Keep the object list short and purposeful: named/hero objects first.
    const prioritized = [...app.project.objects].sort((a, b) => score(b) - score(a)).slice(0, 32);
    function score(o: SceneObjectData): number {
      let s = 0;
      if (o.role === 'target') s += 10;
      if (o.id.startsWith('hero')) s += 8;
      if (o.id.startsWith('colonnade') || o.id.startsWith('beacon')) s += 5;
      if (o.motion) s += 4;
      return s;
    }

    for (const obj of prioritized) {
      const item = el(
        'div',
        { class: `list-item${obj.id === app.selectedObjectId ? ' is-selected' : ''}` },
        [
          el('span', { class: 'idx', text: obj.shape.slice(0, 3).toUpperCase() }),
          el('span', { class: 'name', text: obj.name }),
          obj.role === 'target' ? el('span', { class: 'badge is-target', text: '目标' }) : null,
          obj.motion ? el('span', { class: 'badge', text: '运动' }) : null,
        ],
      );
      item.addEventListener('click', () => {
        app.selectObject(obj.id);
        ui.refreshAll();
      });
      list.append(item);
    }

    const inspector = el('div', { dataset: { role: 'object-inspector' } });
    if (selected) inspector.append(buildObjectInspector(ui, selected));
    else inspector.append(el('p', { class: 'hint-text', text: '选择一个物体以编辑位置、外形，或将其设为镜头目标。' }));

    return section('场景物体', [
      el('p', {
        class: 'hint-text',
        text: '示例场景全部由几何体构成：方块、球、圆柱、圆锥、圆环、八面体。',
      }),
      list,
      el('div', { class: 'divider' }),
      inspector,
    ]);
  }

  function buildObjectInspector(ui: CameraPathEditorUi, obj: SceneObjectData): HTMLElement {
    const app = ui.app;
    const wrap = el('div');
    wrap.append(
      el('div', { class: 'row-between mb-6' }, [
        el('span', { class: 'badge is-mono', text: obj.shape }),
        el('span', {
          class: 'hint-text',
          text: obj.role === 'target' ? '目标物体' : '场景装饰',
          dataset: { role: 'object-live' },
        }),
      ]),
    );

    const vectorRow = (label: string, key: 'position' | 'rotation' | 'scale') => {
      const cells = (['X', 'Y', 'Z'] as const).map((axis, i) => {
        const input = el('input', {
          type: 'number',
          class: 'num-input',
          value: formatNumber(obj[key][i]),
          step: key === 'rotation' ? '1' : '0.1',
          ariaLabel: `${label} ${axis}`,
        });
        input.addEventListener('change', () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          const next: Vec3 = [obj[key][0], obj[key][1], obj[key][2]];
          next[i] = v;
          ui.mutate(`调整物体${label}`, () => app.updateObject(obj.id, { [key]: next }));
        });
        return el('div', { class: 'vec-axis', dataset: { axis } }, [input]);
      });
      return el('div', { class: 'vec-row' }, [el('span', { class: 'field-label', text: label }), ...cells]);
    };

    wrap.append(
      vectorRow('位置', 'position'),
      vectorRow('旋转', 'rotation'),
      vectorRow('缩放', 'scale'),
      selectField({
        label: '外形',
        value: obj.shape,
        options: SHAPES.map((s) => ({ value: s, label: s })),
        onChange: (value) =>
          ui.mutate('更换外形', () => app.updateObject(obj.id, { shape: value as SceneObjectData['shape'] })),
      }),
      checkField({
        label: '设为镜头目标',
        checked: app.project.camera.aim.targetObjectId === obj.id,
        onChange: (checked) =>
          ui.mutate('设置镜头目标', () => {
            app.setTargetObject(checked ? obj.id : null);
            if (checked) {
              app.project.camera.aim.mode = 'target';
              app.aimBlender.setMode('target', performance.now() / 1000, true);
            }
          }),
      }),
      el('div', { class: 'btn-group mt-8' }, [
        button('定位到视图', () => {
          app.orbit = { ...app.orbit, target: [obj.position[0], obj.position[1], obj.position[2]] };
          ui.needsRenderNow();
        }, { class: 'btn' }),
        button('删除物体', () => {
          ui.mutate('删除物体', () => app.deleteObject(obj.id));
        }, { class: 'btn is-danger' }),
      ]),
    );

    if (obj.motion) {
      wrap.append(
        el('div', { class: 'divider' }),
        el('p', { class: 'hint-text', text: '该物体沿轨道运动；镜头跟随目标时会实时追踪它。' }),
        numberField({
          label: '轨道半径 X',
          value: obj.motion.radiusX,
          min: 0.1,
          max: 80,
          step: 0.5,
          onChange: (v) => ui.mutate('调整运动轨道', () => {
            if (obj.motion) obj.motion.radiusX = v;
            app.markDirty();
          }),
        }),
        numberField({
          label: '轨道半径 Z',
          value: obj.motion.radiusZ,
          min: 0.1,
          max: 80,
          step: 0.5,
          onChange: (v) => ui.mutate('调整运动轨道', () => {
            if (obj.motion) obj.motion.radiusZ = v;
            app.markDirty();
          }),
        }),
        numberField({
          label: '轨道速度',
          value: obj.motion.speed,
          min: -3,
          max: 3,
          step: 0.05,
          onChange: (v) => ui.mutate('调整运动速度', () => {
            if (obj.motion) obj.motion.speed = v;
            app.markDirty();
          }),
        }),
        numberField({
          label: '上下浮动',
          value: obj.motion.bob,
          min: 0,
          max: 20,
          step: 0.1,
          onChange: (v) => ui.mutate('调整浮动幅度', () => {
            if (obj.motion) obj.motion.bob = v;
            app.markDirty();
          }),
        }),
      );
    }
    return wrap;
  }

  render(true);
}
