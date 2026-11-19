import type { AppState, Store } from '../app/state.ts';
import type {
  BlendMode,
  EmissionMode,
  EmitterConfig,
  MotionType,
  SpaceMode,
  TextureKind,
} from '../core/types.ts';
import { STAGE_HEIGHT, STAGE_WIDTH } from '../core/types.ts';
import {
  BLEND_LABELS,
  EMISSION_LABELS,
  MOTION_LABELS,
  SPACE_HINTS,
  SPACE_LABELS,
  TEXTURE_LABELS,
} from '../core/labels.ts';
import { createEmitter } from '../core/project.ts';
import { sanitizeRange } from '../core/simulation.ts';
import { buildTextures } from '../render/textures.ts';
import { button, field, rangePair, section, selectField, slider, toggle } from './controls.ts';
import { curveEditor } from './curve-editor.ts';
import { gradientEditor } from './gradient-editor.ts';
import { clear, h, toast } from './dom.ts';

export interface InspectorView {
  root: HTMLElement;
  /** 工程/选择变化时调用；内部按结构签名决定是否真正重建 */
  refresh(state: AppState, options?: { force?: boolean }): void;
}

export interface InspectorDeps {
  store: Store;
  requestRender: () => void;
}

interface Syncable {
  sync(emitter: EmitterConfig): void;
}

/**
 * 右侧属性面板。
 *
 * 拖动滑杆会高频触发更新；若每次都重建 DOM，拖动会被中断。
 * 这里只在「结构签名」变化（换发射器、切换模式、增删曲线点等）时重建，
 * 其余情况只把最新数值同步进已有控件。
 */
export function createInspector(deps: InspectorDeps): InspectorView {
  const { store } = deps;
  const body = h('div', { class: 'inspector-body' });
  const empty = h('div', { class: 'inspector-empty' }, h('p', { text: '没有选中的发射器。' }));
  const root = h('aside', { class: 'inspector', attrs: { 'aria-label': '发射器属性' } }, body);

  let builtId: string | null = null;
  let builtSignature = '';
  let builtEpoch = -1;
  let syncables: Syncable[] = [];
  let disposers: (() => void)[] = [];

  function commit(mutator: (emitter: EmitterConfig) => void, options: { restructure?: boolean } = {}) {
    if (!builtId) return;
    store.setEmitter(builtId, mutator);
    deps.requestRender();
    if (options.restructure) refresh(store.state, { force: true });
  }

  /** 决定哪些变化必须重建 DOM。 */
  function signature(emitter: EmitterConfig | null): string {
    if (!emitter) return 'none';
    return [
      emitter.id,
      emitter.texture,
      emitter.emission.mode,
      emitter.emission.loop,
      emitter.motion.type,
      emitter.enabled,
      emitter.sizeCurve.points.length,
      emitter.alphaCurve.points.length,
      emitter.gradient.stops.length,
    ].join('|');
  }

  function build(state: AppState) {
    for (const dispose of disposers) dispose();
    disposers = [];
    syncables = [];
    clear(body);

    const emitter = state.project.emitters.find((e) => e.id === state.view.selectedEmitterId) ?? null;
    if (!emitter) {
      builtId = null;
      builtSignature = 'none';
      body.append(empty);
      return;
    }
    builtId = emitter.id;
    builtSignature = signature(emitter);
    builtEpoch = state.epoch;

    body.append(renderHeader(emitter));
    body.append(renderBasic(emitter));
    body.append(renderEmission(emitter));
    body.append(renderMotion(emitter));
    body.append(renderAppearance(emitter));
  }

  function refresh(state: AppState, options: { force?: boolean } = {}) {
    const emitter = state.project.emitters.find((e) => e.id === state.view.selectedEmitterId) ?? null;
    const nextSignature = signature(emitter);
    // 工程被整体替换（载入/撤销/重做）时，旧控件引用的已是旧对象，必须重建。
    if (options.force || nextSignature !== builtSignature || !emitter || state.epoch !== builtEpoch) {
      build(state);
      return;
    }
    for (const syncable of syncables) syncable.sync(emitter);
  }

  function renderHeader(emitter: EmitterConfig): HTMLElement {
    const nameInput = h('input', {
      class: 'text-input',
      attrs: { type: 'text', value: emitter.name, maxlength: '40', 'aria-label': '发射器名称' },
    });
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim() || emitter.name;
      nameInput.value = name;
      commit((e) => {
        e.name = name;
      }, { restructure: true });
    });

    const enabled = toggle(emitter.enabled ? '启用' : '已停用', emitter.enabled, (checked) => {
      commit((e) => {
        e.enabled = checked;
      }, { restructure: true });
    });

    const duplicate = button(
      '复制',
      () => {
        if (store.state.project.emitters.length >= 16) {
          toast('发射器数量已达上限。', 'warn');
          return;
        }
        const copy = structuredClone(emitter);
        copy.id = createEmitter().id;
        copy.name = `${emitter.name} 副本`;
        copy.position = {
          x: Math.min(STAGE_WIDTH - 20, emitter.position.x + 40),
          y: Math.min(STAGE_HEIGHT - 20, emitter.position.y + 40),
        };
        store.update((app) => {
          app.project.emitters.push(copy);
          app.view.selectedEmitterId = copy.id;
          app.dirty = true;
        }, 'project');
        deps.requestRender();
        toast(`已复制「${emitter.name}」`);
      },
      { title: '复制当前发射器' },
    );

    const remove = button(
      '删除',
      () => {
        if (store.state.project.emitters.length <= 1) {
          toast('至少保留一个发射器。', 'warn');
          return;
        }
        store.update((app) => {
          const index = app.project.emitters.findIndex((e) => e.id === emitter.id);
          app.project.emitters.splice(Math.max(0, index), 1);
          app.view.selectedEmitterId =
            app.project.emitters[Math.max(0, index - 1)]?.id ?? app.project.emitters[0]?.id ?? null;
          app.dirty = true;
        }, 'project');
        deps.requestRender();
      },
      { variant: 'danger', title: '删除当前发射器' },
    );

    return h(
      'div',
      { class: 'inspector-head' },
      h('div', { class: 'inspector-title' }, nameInput),
      h('div', { class: 'inspector-actions' }, enabled.root, duplicate, remove),
    );
  }

  function renderBasic(emitter: EmitterConfig): HTMLElement {
    const x = slider({
      min: -200,
      max: STAGE_WIDTH + 200,
      step: 1,
      value: emitter.position.x,
      onChange: (v) =>
        commit((e) => {
          e.position.x = v;
        }),
      format: (v) => `${Math.round(v)}`,
    });
    const y = slider({
      min: -200,
      max: STAGE_HEIGHT + 200,
      step: 1,
      value: emitter.position.y,
      onChange: (v) =>
        commit((e) => {
          e.position.y = v;
        }),
      format: (v) => `${Math.round(v)}`,
    });
    syncables.push({
      sync(e) {
        x.setValue(e.position.x);
        y.setValue(e.position.y);
      },
    });

    const spaceSelect = selectField<SpaceMode>(
      (Object.keys(SPACE_LABELS) as SpaceMode[]).map((value) => ({ value, label: SPACE_LABELS[value] })),
      emitter.space,
      (value) => {
        commit((e) => {
          e.space = value;
        });
        toast(SPACE_HINTS[value], 'info');
      },
    );
    const spaceHint = h('div', { class: 'field-hint', text: SPACE_HINTS[emitter.space] });
    spaceSelect.addEventListener('change', () => {
      spaceHint.textContent = SPACE_HINTS[spaceSelect.value as SpaceMode];
    });

    const spaceControl = h('div', {}, spaceSelect, spaceHint);

    const textureSelect = selectField<TextureKind>(
      (Object.keys(TEXTURE_LABELS) as TextureKind[]).map((value) => ({
        value,
        label: TEXTURE_LABELS[value],
      })),
      emitter.texture,
      (value) =>
        commit((e) => {
          e.texture = value;
        }, { restructure: true }),
    );

    const blendSelect = selectField<BlendMode>(
      (Object.keys(BLEND_LABELS) as BlendMode[]).map((value) => ({ value, label: BLEND_LABELS[value] })),
      emitter.blend,
      (value) =>
        commit((e) => {
          e.blend = value;
        }),
    );

    return section(
      '位置与基础',
      h('div', { class: 'field-grid' }, field('X 坐标', x.root), field('Y 坐标', y.root)),
      field('坐标空间', spaceControl),
      h('div', { class: 'field-grid' }, field('贴图', textureSelect), field('混合', blendSelect)),
    );
  }

  function renderEmission(emitter: EmitterConfig): HTMLElement {
    const modeSelect = selectField<EmissionMode>(
      (Object.keys(EMISSION_LABELS) as EmissionMode[]).map((value) => ({
        value,
        label: EMISSION_LABELS[value],
      })),
      emitter.emission.mode,
      (value) =>
        commit(
          (e) => {
            e.emission.mode = value;
          },
          { restructure: true },
        ),
    );

    const children: (HTMLElement | null)[] = [field('发射模式', modeSelect)];

    if (emitter.emission.mode === 'rate') {
      const rate = slider({
        min: 0,
        max: 400,
        step: 1,
        value: emitter.emission.rate,
        onChange: (v) =>
          commit((e) => {
            e.emission.rate = v;
          }),
        format: (v) => `${Math.round(v)}/s`,
      });
      const cycle = slider({
        min: 0.1,
        max: 30,
        step: 0.1,
        value: emitter.emission.duration,
        onChange: (v) =>
          commit((e) => {
            e.emission.duration = v;
          }),
        format: (v) => `${v.toFixed(1)}s`,
      });
      const loop = toggle('持续循环', emitter.emission.loop, (checked) =>
        commit(
          (e) => {
            e.emission.loop = checked;
          },
          { restructure: true },
        ),
      );
      syncables.push({
        sync(e) {
          rate.setValue(e.emission.rate);
          cycle.setValue(e.emission.duration);
        },
      });
      children.push(
        field('发射频率', rate.root, '每秒新生的粒子数。'),
        field(
          '持续时间',
          cycle.root,
          '关闭循环时只在前 N 秒持续发射；开启循环则一直发射。',
        ),
        loop.root,
      );
    } else {
      const count = slider({
        min: 0,
        max: 800,
        step: 1,
        value: emitter.emission.burstCount,
        onChange: (v) =>
          commit((e) => {
            e.emission.burstCount = Math.round(v);
          }),
        format: (v) => `${Math.round(v)} 个`,
      });
      const every = slider({
        min: 0.1,
        max: 30,
        step: 0.1,
        value: emitter.emission.duration,
        onChange: (v) =>
          commit((e) => {
            e.emission.duration = v;
          }),
        format: (v) => `${v.toFixed(1)}s`,
      });
      const at = slider({
        min: 0,
        max: Math.max(0.2, Math.min(30, emitter.emission.duration)),
        step: 0.05,
        value: emitter.emission.burstTime,
        onChange: (v) =>
          commit((e) => {
            e.emission.burstTime = v;
          }),
        format: (v) => `${v.toFixed(2)}s`,
      });
      const loop = toggle('按周期重复爆发', emitter.emission.loop, (checked) =>
        commit(
          (e) => {
            e.emission.loop = checked;
          },
          { restructure: true },
        ),
      );
      at.setLimits(0, Math.max(0.2, emitter.emission.duration));
      syncables.push({
        sync(e) {
          count.setValue(e.emission.burstCount);
          every.setValue(e.emission.duration);
          at.setLimits(0, Math.max(0.2, e.emission.duration));
          at.setValue(Math.min(e.emission.burstTime, Math.max(0.2, e.emission.duration)));
        },
      });
      children.push(
        field('爆发数量', count.root, '每次爆发一次性喷出的粒子数；数量越多越容易触发上限。'),
        field(
          emitter.emission.loop ? '爆发周期' : '爆发周期（仅循环时生效）',
          every.root,
          emitter.emission.loop ? '每过该周期再次爆发。' : '关闭循环时只爆发一次，此参数仅用于预览循环节奏。',
        ),
        field('周期内偏移', at.root, '爆发在周期开始后再延迟多久触发。'),
        loop.root,
      );
    }

    const delay = slider({
      min: 0,
      max: 20,
      step: 0.05,
      value: emitter.emission.startDelay,
      onChange: (v) =>
        commit((e) => {
          e.emission.startDelay = v;
        }),
      format: (v) => `${v.toFixed(2)}s`,
    });
    syncables.push({
      sync(e) {
        delay.setValue(e.emission.startDelay);
      },
    });
    children.push(field('起始延迟', delay.root));

    return section('发射', ...children);
  }

  function renderMotion(emitter: EmitterConfig): HTMLElement {
    const typeSelect = selectField<MotionType>(
      (Object.keys(MOTION_LABELS) as MotionType[]).map((value) => ({
        value,
        label: MOTION_LABELS[value],
      })),
      emitter.motion.type,
      (value) =>
        commit(
          (e) => {
            e.motion.type = value;
          },
          { restructure: true },
        ),
    );

    const children: (HTMLElement | null)[] = [field('运动方式', typeSelect)];

    if (emitter.motion.type !== 'static') {
      const speed = slider({
        min: -6,
        max: 6,
        step: 0.05,
        value: emitter.motion.speed,
        onChange: (v) =>
          commit((e) => {
            e.motion.speed = v;
          }),
        format: (v) => `${v.toFixed(2)} rad/s`,
      });
      const radius = slider({
        min: 0,
        max: 400,
        step: 1,
        value: emitter.motion.radius,
        onChange: (v) =>
          commit((e) => {
            e.motion.radius = v;
          }),
        format: (v) => `${Math.round(v)} px`,
      });
      const radiusY = slider({
        min: 0,
        max: 400,
        step: 1,
        value: emitter.motion.radiusY,
        onChange: (v) =>
          commit((e) => {
            e.motion.radiusY = v;
          }),
        format: (v) => `${Math.round(v)} px`,
      });
      const phase = slider({
        min: -360,
        max: 360,
        step: 1,
        value: emitter.motion.phase,
        onChange: (v) =>
          commit((e) => {
            e.motion.phase = v;
          }),
        format: (v) => `${Math.round(v)}°`,
      });
      syncables.push({
        sync(e) {
          speed.setValue(e.motion.speed);
          radius.setValue(e.motion.radius);
          radiusY.setValue(e.motion.radiusY);
          phase.setValue(e.motion.phase);
        },
      });
      children.push(
        field('角速度', speed.root, '环绕为角速度（弧度/秒）；往返为摆动速度。'),
        h(
          'div',
          { class: 'field-grid' },
          field('水平半径', radius.root),
          field('纵向半径', radiusY.root),
        ),
        field('相位', phase.root),
      );
    }

    const [minSpeed, maxSpeed] = sanitizeRange(emitter.speed.min, emitter.speed.max);
    const speed = rangePair('最小', '最大', 0, 800, 1, { min: minSpeed, max: maxSpeed }, (value) =>
      commit((e) => {
        e.speed.min = value.min;
        e.speed.max = value.max;
      }),
    );
    syncables.push({
      sync(e) {
        const [lo, hi] = sanitizeRange(e.speed.min, e.speed.max);
        speed.setValue(lo, hi);
      },
    });
    children.push(field('初速度范围', speed.root, '像素/秒'));

    const angle = slider({
      min: -180,
      max: 540,
      step: 1,
      value: emitter.direction.angle,
      onChange: (v) =>
        commit((e) => {
          e.direction.angle = v;
        }),
      format: (v) => `${Math.round(v)}°`,
    });
    const spread = slider({
      min: 0,
      max: 360,
      step: 1,
      value: emitter.direction.spread,
      onChange: (v) =>
        commit((e) => {
          e.direction.spread = v;
        }),
      format: (v) => `${Math.round(v)}°`,
    });
    const radius = slider({
      min: 0,
      max: 200,
      step: 1,
      value: emitter.spawnRadius,
      onChange: (v) =>
        commit((e) => {
          e.spawnRadius = v;
        }),
      format: (v) => `${Math.round(v)} px`,
    });
    const gravity = slider({
      min: -2,
      max: 2,
      step: 0.05,
      value: emitter.gravityScale,
      onChange: (v) =>
        commit((e) => {
          e.gravityScale = v;
        }),
      format: (v) => `×${v.toFixed(2)}`,
    });
    const lifetime = rangePair(
      '最短',
      '最长',
      0.05,
      15,
      0.05,
      { min: emitter.lifetime.min, max: emitter.lifetime.max },
      (value) =>
        commit((e) => {
          e.lifetime.min = value.min;
          e.lifetime.max = value.max;
        }),
    );
    syncables.push({
      sync(e) {
        angle.setValue(e.direction.angle);
        spread.setValue(e.direction.spread);
        radius.setValue(e.spawnRadius);
        gravity.setValue(e.gravityScale);
        const [lo, hi] = sanitizeRange(e.lifetime.min, e.lifetime.max);
        lifetime.setValue(lo, hi);
      },
    });
    children.push(
      h('div', { class: 'field-grid' }, field('方向角', angle.root), field('扩散角', spread.root)),
      field('出生半径', radius.root),
      field('寿命范围', lifetime.root, '秒；决定粒子存活多久。'),
      field('重力倍率', gravity.root, '乘以场景重力；负值让粒子上升。'),
    );

    return section('速度、方向与寿命', ...children);
  }

  function renderAppearance(emitter: EmitterConfig): HTMLElement {
    const sizeEditor = curveEditor({
      min: 0,
      max: 120,
      format: (v) => `${Math.round(v)}px`,
      onChange: (curve) =>
        commit((e) => {
          e.sizeCurve = curve;
        }),
    });
    sizeEditor.setCurve(emitter.sizeCurve);
    disposers.push(() => sizeEditor.destroy());

    const alphaEditor = curveEditor({
      min: 0,
      max: 1,
      format: (v) => v.toFixed(2),
      onChange: (curve) =>
        commit((e) => {
          e.alphaCurve = curve;
        }),
    });
    alphaEditor.setCurve(emitter.alphaCurve);
    disposers.push(() => alphaEditor.destroy());

    const gradient = gradientEditor({
      onChange: (value) =>
        commit((e) => {
          e.gradient = value;
        }),
    });
    gradient.setGradient(emitter.gradient);
    disposers.push(() => gradient.destroy());

    syncables.push({
      sync(e) {
        sizeEditor.setCurve(e.sizeCurve);
        alphaEditor.setCurve(e.alphaCurve);
        gradient.setGradient(e.gradient);
      },
    });

    const alpha = slider({
      min: 0,
      max: 1,
      step: 0.01,
      value: emitter.alpha,
      onChange: (v) =>
        commit((e) => {
          e.alpha = v;
        }),
      format: (v) => `${Math.round(v * 100)}%`,
    });
    syncables.push({
      sync(e) {
        alpha.setValue(e.alpha);
      },
    });

    return section(
      '外观',
      field('大小（随寿命）', sizeEditor.root, '横轴 0→1 为粒子寿命进度，纵轴为像素大小。'),
      field('不透明度（随寿命）', alphaEditor.root),
      field('颜色渐变', gradient.root, '拖动色标改变颜色随寿命的变化。'),
      field('整体不透明度', alpha.root),
      textureStrip(emitter),
    );
  }

  function textureStrip(emitter: EmitterConfig): HTMLElement {
    const previews = buildTextures().previews;
    const strip = h('div', { class: 'texture-strip' });
    for (const kind of Object.keys(TEXTURE_LABELS) as TextureKind[]) {
      strip.append(
        h(
          'button',
          {
            class: `texture-swatch${emitter.texture === kind ? ' is-active' : ''}`,
            attrs: { type: 'button', title: TEXTURE_LABELS[kind] },
            on: {
              click: () =>
                commit(
                  (e) => {
                    e.texture = kind;
                  },
                  { restructure: true },
                ),
            },
          },
          h('img', { attrs: { src: previews[kind], alt: TEXTURE_LABELS[kind] } }),
          h('span', { text: TEXTURE_LABELS[kind] }),
        ),
      );
    }
    return strip;
  }

  return {
    root,
    refresh,
  };
}
