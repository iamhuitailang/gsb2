import type { AppState, Store } from '../app/state.ts';
import type { BackgroundMode, EmitterConfig, Project } from '../core/types.ts';
import { HARD_EMITTER_LIMIT, HARD_PARTICLE_LIMIT } from '../core/simulation.ts';
import { BACKGROUND_LABELS } from '../core/labels.ts';
import { PRESETS } from '../core/presets.ts';
import { createEmitter } from '../core/project.ts';
import { button, chip, field, section, selectField, slider, toggle } from './controls.ts';
import { clear, fmt, h, toast } from './dom.ts';

export interface SidebarView {
  root: HTMLElement;
  /** 状态变化时同步；内部按需重建列表、局部同步控件 */
  refresh(state: AppState): void;
  /** 只更新统计区（每帧调用） */
  updateStats(state: AppState): void;
}

export interface SidebarDeps {
  store: Store;
  onProjectChanged(): void;
  loadProject(project: Project): void;
  saveProject(): void;
  openProject(): void;
  exportConfig(): void;
  exportSheet(): void;
  randomizeSeed(): void;
}

export type { EmitterConfig };

const EMITTER_COLORS = [
  '#7ae2ff',
  '#ffcf7a',
  '#ff8a8a',
  '#9dff9d',
  '#c79bff',
  '#ff9bd6',
  '#7affd9',
  '#e0e07a',
];

/**
 * 左侧面板：示例、发射器列表、场景参数、性能统计、工程文件。
 *
 * 场景滑杆等控件只构建一次，后续仅同步数值；否则拖动过程中重建 DOM
 * 会打断拖动。发射器列表则按结构签名重建。
 */
export function createSidebar(deps: SidebarDeps): SidebarView {
  const { store } = deps;
  const root = h('aside', { class: 'sidebar', attrs: { 'aria-label': '场景与发射器' } });

  const emitterList = h('div', { class: 'emitter-list' });
  const emitterCount = h('span', { class: 'muted small' });
  const emitterSection = section(
    '发射器',
    emitterList,
    h('div', { class: 'row-actions' }, button('+ 新增发射器', () => addEmitter(), { variant: 'ghost' }), emitterCount),
  );

  let listSignature = '';
  let statsHost: HTMLElement | null = null;
  // 场景控件与发射器列表都依赖工程纪元；纪元变化时统一重建。
  let builtEpoch = store.state.epoch;

  /**
   * 场景控件在载入其他工程时重建；普通数值编辑只同步，避免打断拖动。
   * 返回控件根节点与同步函数。
   */
  function buildSceneSection(): { root: HTMLElement; sync(sceneState: AppState['project']['scene'], view: AppState['view']): void } {
    const scene = store.state.project.scene;

    const seedInput = h('input', {
      class: 'text-input seed-input',
      attrs: { type: 'number', min: '0', max: String(0xffffffff), step: '1', value: String(scene.seed) },
    });
    seedInput.addEventListener('change', () => {
      const value = Math.max(0, Math.min(0xffffffff, Math.floor(Number(seedInput.value) || 0)));
      seedInput.value = String(value);
      store.update((app) => {
        app.project.scene.seed = value;
        app.dirty = true;
      }, 'project');
      deps.onProjectChanged();
    });

    const duration = slider({
      min: 1,
      max: 30,
      step: 0.5,
      value: scene.duration,
      onChange: (v) => {
        store.update((app) => {
          app.project.scene.duration = v;
          app.playback.time = Math.min(app.playback.time, v);
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
      format: (v) => `${v.toFixed(1)}s`,
    });

    const fps = selectField(
      [24, 30, 60].map((value) => ({ value: String(value), label: `${value} fps` })),
      String(scene.fps),
      (value) => {
        store.update((app) => {
          app.project.scene.fps = Number(value);
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
    );

    const gravityX = slider({
      min: -800,
      max: 800,
      step: 10,
      value: scene.gravity.x,
      onChange: (v) => {
        store.update((app) => {
          app.project.scene.gravity.x = v;
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
      format: (v) => `${Math.round(v)}`,
    });
    const gravityY = slider({
      min: -800,
      max: 800,
      step: 10,
      value: scene.gravity.y,
      onChange: (v) => {
        store.update((app) => {
          app.project.scene.gravity.y = v;
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
      format: (v) => `${Math.round(v)}`,
    });

    const cap = slider({
      min: 200,
      max: HARD_PARTICLE_LIMIT,
      step: 100,
      value: scene.maxParticles,
      onChange: (v) => {
        store.update((app) => {
          app.project.scene.maxParticles = Math.round(v);
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
      format: (v) => fmt(v),
    });

    const background = selectField<BackgroundMode>(
      (Object.keys(BACKGROUND_LABELS) as BackgroundMode[]).map((value) => ({
        value,
        label: BACKGROUND_LABELS[value],
      })),
      scene.background,
      (value) => {
        store.update((app) => {
          app.project.scene.background = value;
          app.dirty = true;
        }, 'project');
        deps.onProjectChanged();
      },
    );

    const grid = toggle('网格参考线', store.state.view.showGrid, (checked) => {
      store.update((app) => {
        app.view.showGrid = checked;
      }, 'view');
      deps.onProjectChanged();
    });
    const markers = toggle('发射器标记', store.state.view.showMarkers, (checked) => {
      store.update((app) => {
        app.view.showMarkers = checked;
      }, 'view');
      deps.onProjectChanged();
    });

    const root = section(
      '场景',
      field(
        '随机种子',
        h('div', { class: 'seed-row' }, seedInput, button('随机', () => deps.randomizeSeed(), { title: '生成新的随机种子' })),
        '相同参数 + 相同种子 → 完全一致的结果。',
      ),
      field('时间轴时长', duration.root),
      h('div', { class: 'field-grid' }, field('帧率', fps), field('背景', background)),
      h('div', { class: 'field-grid' }, field('重力 X', gravityX.root), field('重力 Y', gravityY.root)),
      field('粒子上限', cap.root, '超出后按比例抽稀，并在统计区明确提示，页面不会卡死。'),
      h('div', { class: 'toggle-row' }, grid.root, markers.root),
    );

    return {
      root,
      sync(sceneState, view) {
        if (document.activeElement !== seedInput) seedInput.value = String(sceneState.seed);
        duration.setValue(sceneState.duration);
        gravityX.setValue(sceneState.gravity.x);
        gravityY.setValue(sceneState.gravity.y);
        cap.setValue(sceneState.maxParticles);
        if (document.activeElement !== fps) fps.value = String(sceneState.fps);
        if (document.activeElement !== background) background.value = sceneState.background;
        grid.input.checked = view.showGrid;
        markers.input.checked = view.showMarkers;
      },
    };
  }

  /* --------------------------- 文件控件 --------------------------- */

  const nameInput = h('input', {
    class: 'text-input',
    attrs: { type: 'text', value: store.state.project.name, maxlength: '60', 'aria-label': '工程名称' },
  });
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim() || '未命名粒子工程';
    nameInput.value = name;
    store.update((app) => {
      app.project.name = name;
      app.dirty = true;
    }, 'project');
    deps.onProjectChanged();
  });

  const savedLabel = h('span');
  const dirtyLabel = h('span');
  const fileSection = section(
    '工程文件',
    field('工程名称', nameInput),
    h(
      'div',
      { class: 'file-actions' },
      button('保存工程', () => deps.saveProject(), { variant: 'primary' }),
      button('打开工程', () => deps.openProject()),
      button('导出配置', () => deps.exportConfig()),
      button('导出序列图', () => deps.exportSheet()),
    ),
    h('div', { class: 'file-meta' }, savedLabel, dirtyLabel),
  );

  function renderPresets(): HTMLElement {
    const list = h('div', { class: 'preset-list' });
    for (const preset of PRESETS) {
      list.append(
        h(
          'button',
          {
            class: 'preset-card',
            attrs: { type: 'button', title: preset.description },
            on: { click: () => deps.loadProject(preset.build()) },
          },
          h('strong', { text: preset.name }),
          h('span', { text: preset.description }),
        ),
      );
    }
    return section('示例工程', list);
  }

  let sceneSection = buildSceneSection();
  root.append(renderPresets(), emitterSection, sceneSection.root);
  statsHost = renderStats(store.state);
  root.append(statsHost, fileSection);

  /* --------------------------- 发射器列表 --------------------------- */

  function addEmitter() {
    if (store.state.project.emitters.length >= HARD_EMITTER_LIMIT) {
      toast(`最多 ${HARD_EMITTER_LIMIT} 个发射器。`, 'warn');
      return;
    }
    const emitter = createEmitter({ name: `发射器 ${store.state.project.emitters.length + 1}` });
    store.update((app) => {
      app.project.emitters.push(emitter);
      app.view.selectedEmitterId = emitter.id;
      app.dirty = true;
    }, 'project');
    deps.onProjectChanged();
  }

  function emitterSignature(state: AppState): string {
    return [
      state.view.selectedEmitterId ?? '',
      state.project.emitters
        .map((e) => [e.id, e.name, e.enabled ? 1 : 0, e.space, e.emission.mode].join(','))
        .join('|'),
    ].join('::');
  }

  function renderEmitterList(state: AppState) {
    clear(emitterList);
    state.project.emitters.forEach((emitter, index) => {
      emitterList.append(
        h(
          'div',
          {
            class: `emitter-item${emitter.id === state.view.selectedEmitterId ? ' is-selected' : ''}${
              emitter.enabled ? '' : ' is-disabled'
            }`,
          },
          h(
            'button',
            {
              class: 'emitter-select',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  store.update((app) => {
                    app.view.selectedEmitterId = emitter.id;
                  }, 'selection');
                  deps.onProjectChanged();
                },
              },
            },
            h('span', { class: 'emitter-index', text: String(index + 1).padStart(2, '0') }),
            h('span', { class: 'emitter-name', text: emitter.name }),
            h(
              'span',
              { class: 'emitter-badges' },
              chip(emitter.space === 'local' ? '本地' : '世界'),
              chip(emitter.emission.mode === 'burst' ? '爆发' : '持续'),
            ),
          ),
          h(
            'button',
            {
              class: `emitter-eye${emitter.enabled ? ' is-on' : ''}`,
              attrs: { type: 'button', title: emitter.enabled ? '停用' : '启用', 'aria-label': '切换启用' },
              on: {
                click: (event) => {
                  event.stopPropagation();
                  store.setEmitter(emitter.id, (e) => {
                    e.enabled = !e.enabled;
                  });
                  deps.onProjectChanged();
                },
              },
            },
            emitter.enabled ? '●' : '○',
          ),
        ),
      );
    });
    emitterCount.textContent = `${state.project.emitters.length}/${HARD_EMITTER_LIMIT}`;
  }

  /* --------------------------- 统计 --------------------------- */

  function renderStats(state: AppState): HTMLElement {
    const stats = state.stats;
    const rows = h('div', { class: 'stats-rows' });
    const max = Math.max(1, ...stats.perEmitter.map((item) => item.count));

    if (stats.perEmitter.length === 0) {
      rows.append(h('div', { class: 'muted small', text: '暂无数据' }));
    }

    stats.perEmitter.forEach((item, index) => {
      const ratio = item.count / max;
      const color = EMITTER_COLORS[index % EMITTER_COLORS.length];
      rows.append(
        h(
          'div',
          { class: 'stats-row' },
          h('span', { class: 'stats-dot', attrs: { style: `--dot: ${item.enabled ? color : '#4b5563'}` } }),
          h('span', { class: 'stats-name', text: item.name, title: item.name }),
          h(
            'span',
            { class: 'stats-bar' },
            h('span', {
              class: 'stats-bar-fill',
              attrs: { style: `width:${Math.min(100, ratio * 100)}%;--fill:${color}` },
            }),
          ),
          h('span', { class: 'stats-value', text: fmt(item.count) }),
          h('span', {
            class: `stats-time${item.simMs > 8 ? ' is-slow' : ''}`,
            text: `${fmt(item.simMs, 2)}ms`,
            title: `存活 ${fmt(item.alive)} · 预算 ${fmt(item.budget)} · 抽稀 ${fmt(item.omitted)}`,
          }),
        ),
      );
    });

    const summary = h(
      'div',
      { class: 'stats-summary' },
      statTile(fmt(stats.particleCount), '渲染粒子', stats.overCap ? 'warn' : undefined),
      statTile(`${fmt(stats.simMs, 2)}ms`, '仿真耗时'),
      statTile(`${fmt(stats.drawMs, 2)}ms`, '绘制耗时'),
      statTile(fmt(stats.fps, 0), 'FPS'),
    );

    const warning = h('div', { class: 'stats-warning' });
    if (stats.capped) {
      warning.classList.add('is-visible');
      warning.textContent = `已超出粒子上限：存活约 ${fmt(stats.aliveTotal)}，仅渲染 ${fmt(
        stats.particleCount,
      )}，抽稀 ${fmt(stats.omitted)} 个。可调低发射率/寿命，或在「场景」中提高上限。`;
    } else if (stats.scanReduced) {
      warning.classList.add('is-visible');
      warning.textContent = '候选粒子极多，仿真已按等距抽样统计；画面密度为近似值。';
    }

    return section('性能统计', summary, rows, warning);
  }

  function syncScene(state: AppState) {
    sceneSection.sync(state.project.scene, state.view);
    if (document.activeElement !== nameInput) nameInput.value = state.project.name;
    savedLabel.textContent = state.lastSavedAt
      ? `上次保存 ${new Date(state.lastSavedAt).toLocaleTimeString('zh-CN')}`
      : '尚未保存';
    dirtyLabel.textContent = state.dirty ? '有未保存修改' : '已保存';
  }

  function statTile(value: string, label: string, tone?: 'warn'): HTMLElement {
    return h(
      'div',
      { class: 'stat' },
      h('span', { class: `stat-value${tone ? ` is-${tone}` : ''}`, text: value }),
      h('span', { class: 'stat-label', text: label }),
    );
  }

  return {
    root,
    refresh(state) {
      // 工程被整体替换（载入 / 撤销 / 重做）时先重建场景控件，再刷新列表。
      if (state.epoch !== builtEpoch) {
        builtEpoch = state.epoch;
        const next = buildSceneSection();
        sceneSection.root.replaceWith(next.root);
        sceneSection = next;
        listSignature = '';
      }
      const signature = emitterSignature(state);
      if (signature !== listSignature) {
        listSignature = signature;
        renderEmitterList(state);
      }
      syncScene(state);
    },
    updateStats(state) {
      if (!statsHost) return;
      const next = renderStats(state);
      statsHost.replaceWith(next);
      statsHost = next;
    },
  };
}
