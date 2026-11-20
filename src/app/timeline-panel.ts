import type { CameraPathEditorUi } from './ui.js';
import type { TimelinePanelApi, UiRefs } from './ui-types.js';
import { button, el, formatNumber, formatTime } from './dom.js';
import { showToast } from './toast.js';
import { EASES, type EaseKind } from '../core/types.js';

const EASE_LABELS: Record<EaseKind, string> = {
  linear: '线性',
  easeInOut: '缓入缓出',
  easeIn: '缓入',
  easeOut: '缓出',
};

/**
 * Timeline with a ruler, key markers, hold bars and a speed lane.
 *
 * Dragging a key square changes its normalized path position, dragging the
 * right edge of a hold bar changes the dwell duration, and dragging a speed
 * stem vertically changes the outgoing segment speed.
 */
export function buildTimelinePanel(ui: CameraPathEditorUi, refs: UiRefs): void {
  const host = document.getElementById('timeline-panel');
  if (!host) return;

  let holdDrag: { keyId: string; startX: number; startHold: number } | null = null;
  let keyDrag: { keyId: string; startX: number; startS: number } | null = null;
  let speedDrag: { keyId: string; startY: number; startSpeed: number } | null = null;
  let scrubbing = false;

  const title = el('div', { class: 'timeline-title' }, [
    el('b', { text: '时间线' }),
    el('span', { text: '关键点 · 停留 · 速度' }),
  ]);
  const inspector = el('div', { class: 'timeline-tools', dataset: { role: 'key-inspector' } });

  const head = el('div', { class: 'timeline-head' }, [
    title,
    inspector,
    el('div', { class: 'timeline-tools' }, [
      button('均匀分布', () => {
        ui.mutate('关键点均匀分布', () => {
          const keys = ui.app.sortedKeys();
          keys.forEach((key, i) => {
            key.s = keys.length > 1 ? i / keys.length : 0;
          });
          ui.app.rebuild();
        });
      }, { class: 'btn is-ghost', title: '按序号重新均匀分布关键点的路径位置' }),
      button('＋ 关键点', () => {
        ui.mutate('添加关键点', () => ui.app.addKeyAtPlayhead(), { refresh: 'light' });
        timelineApi.refresh();
        showToast('已在时间指针处添加关键点');
      }, { class: 'btn', title: '在当前时间添加关键点 (K)' }),
      button('删除', () => {
        ui.beginEdit('删除关键点');
        if (!ui.app.deleteSelectedKey()) {
          ui.cancelEdit();
          showToast('至少保留一个关键点', 'error');
          return;
        }
        ui.commitEdit();
        timelineApi.refresh();
      }, { class: 'btn is-danger' }),
    ]),
  ]);

  const laneLabels = el('div', { class: 'timeline-lanes' }, [
    el('div', { class: 'lane-label' }, [el('span', { text: '关键点' })]),
    el('div', { class: 'lane-label' }, [el('span', { text: '停留' })]),
    el('div', { class: 'lane-label' }, [el('span', { text: '速度' })]),
  ]);

  const ruler = el('div', { class: 'timeline-ruler', dataset: { role: 'ruler' } });
  const keyRow = el('div', { class: 'lane-row', dataset: { role: 'keys' } });
  const holdRow = el('div', { class: 'lane-row is-hold', dataset: { role: 'holds' } });
  const speedRow = el('div', { class: 'lane-row is-speed', dataset: { role: 'speeds' } });
  const playhead = el('div', { class: 'playhead' });

  const trackWrap = el('div', { class: 'timeline-track-wrap', dataset: { role: 'track' } }, [
    ruler,
    keyRow,
    holdRow,
    speedRow,
    playhead,
  ]);

  host.replaceChildren(head, el('div', { class: 'timeline-body' }, [laneLabels, trackWrap]));

  // ------------------------------------------------------------- interaction

  const timeAt = (clientX: number): number => {
    const rect = trackWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * ui.app.duration;
  };

  trackWrap.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.timeline-key, .hold-bar, .speed-tick')) return;
    scrubbing = true;
    trackWrap.setPointerCapture?.(e.pointerId);
    ui.setTime(timeAt(e.clientX));
    sync();
  });

  // Drags are tracked on window so they keep working if the pointer leaves the
  // track, and so the per-move DOM rebuild cannot detach the active handler.
  const onMove = (e: PointerEvent): void => {
    if (scrubbing) {
      ui.setTime(timeAt(e.clientX));
      sync();
      return;
    }
    if (keyDrag) {
      const rect = trackWrap.getBoundingClientRect();
      const delta = (e.clientX - keyDrag.startX) / Math.max(1, rect.width);
      ui.app.moveKey(keyDrag.keyId, Math.max(0, Math.min(1, keyDrag.startS + delta)));
      ui.needsRenderNow();
      renderKeys();
      return;
    }
    if (holdDrag) {
      const rect = trackWrap.getBoundingClientRect();
      const secondsPerPixel = (ui.app.duration / Math.max(1, rect.width)) * 0.6;
      const deltaSeconds = (e.clientX - holdDrag.startX) * secondsPerPixel;
      const next = Math.max(0, Math.round((holdDrag.startHold + deltaSeconds) * 20) / 20);
      ui.app.updateKey(holdDrag.keyId, { hold: next });
      ui.needsRenderNow();
      renderKeys();
      return;
    }
    if (speedDrag) {
      const delta = (speedDrag.startY - e.clientY) / 60;
      const next = Math.max(0.1, Math.min(6, Math.round((speedDrag.startSpeed + delta) * 100) / 100));
      ui.app.updateKey(speedDrag.keyId, { speed: next });
      ui.needsRenderNow();
      renderKeys();
    }
  };
  window.addEventListener('pointermove', onMove);

  const endDrag = (e: PointerEvent) => {
    if (scrubbing) {
      scrubbing = false;
      ui.setTime(timeAt(e.clientX));
      sync();
      return;
    }
    if (keyDrag) {
      keyDrag = null;
      ui.commitEdit();
      timelineApi.refresh();
      return;
    }
    if (holdDrag) {
      holdDrag = null;
      ui.commitEdit();
      timelineApi.refresh();
      return;
    }
    if (speedDrag) {
      speedDrag = null;
      ui.commitEdit();
      timelineApi.refresh();
    }
  };
  window.addEventListener('pointerup', endDrag);

  trackWrap.tabIndex = 0;
  trackWrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      ui.app.stepFrame(-1);
      ui.setTime(ui.app.time);
      sync();
    } else if (e.key === 'ArrowRight') {
      ui.app.stepFrame(1);
      ui.setTime(ui.app.time);
      sync();
    }
  });

  // ------------------------------------------------------------------ render

  function renderRuler(): void {
    ruler.replaceChildren();
    const duration = ui.app.duration;
    const width = trackWrap.clientWidth;
    if (duration <= 0 || width <= 0) return;
    const targetTicks = Math.max(3, Math.floor(width / 92));
    const rawStep = duration / targetTicks;
    const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s >= rawStep) ?? rawStep;
    const count = Math.floor(duration / step + 1e-6);
    for (let i = 0; i <= count; i++) {
      const t = i * step;
      const ratio = t / duration;
      const tick = el('div', {
        class: `ruler-tick${i % 5 === 0 ? ' is-major' : ''}`,
        text: `${formatNumber(t)}s`,
      });
      tick.style.left = `${ratio * width}px`;
      ruler.append(tick);
    }
    // End marker.
    const end = el('div', { class: 'ruler-tick is-major', text: `${formatNumber(duration)}s` });
    end.style.left = `${width - 2}px`;
    end.style.transform = 'translateX(-100%)';
    ruler.append(end);
  }

  function renderKeys(): void {
    keyRow.replaceChildren();
    holdRow.replaceChildren();
    speedRow.replaceChildren();
    const width = trackWrap.clientWidth;
    const duration = Math.max(ui.app.duration, 1e-6);
    const app = ui.app;

    for (const entry of app.timeline.entries) {
      const hold = entry.holdEnd - entry.holdStart;
      if (hold <= 1e-6) continue;
      const bar = el(
        'div',
        {
          class: 'hold-bar',
          title: `停留 ${hold.toFixed(2)}s（左右拖动调整）`,
          dataset: { keyId: entry.key.id },
        },
        [el('span', { text: `${hold.toFixed(2)}s` })],
      );
      bar.style.left = `${(entry.holdStart / duration) * width}px`;
      bar.style.width = `${Math.max(3, (hold / duration) * width)}px`;
      bar.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        app.selectedKeyId = entry.key.id;
        ui.beginEdit('调整停留时长');
        holdDrag = { keyId: entry.key.id, startX: e.clientX, startHold: entry.key.hold };
        refreshInspector();
        sync();
      });
      holdRow.append(bar);
    }

    const sorted = app.sortedKeys();
    sorted.forEach((key, index) => {
      const entry = app.timeline.entries.find((en) => en.key.id === key.id);
      const timeAtKey = entry ? entry.holdStart : 0;
      const x = (timeAtKey / duration) * width;

      if (entry && entry.travelEnd > entry.travelStart) {
        const seg = el('div', { class: 'speed-bar' });
        const segWidth = Math.max(1, ((entry.travelEnd - entry.travelStart) / duration) * width - 2);
        seg.style.left = `${(entry.travelStart / duration) * width}px`;
        seg.style.width = `${segWidth}px`;
        // Fade the bar by speed so transport speed reads at a glance.
        const alpha = 0.2 + Math.min(0.6, key.speed / 4);
        seg.style.background = `rgba(242, 176, 74, ${alpha.toFixed(2)})`;
        speedRow.append(seg);
      }

      const marker = el('div', {
        class: `timeline-key${key.id === app.selectedKeyId ? ' is-selected' : ''}`,
        title: `K${index + 1} · s=${(key.s * 100).toFixed(1)}% · 停留 ${key.hold.toFixed(2)}s · 速度 x${key.speed.toFixed(2)}`,
        dataset: { keyId: key.id },
      });
      marker.style.left = `${x}px`;
      marker.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        app.selectedKeyId = key.id;
        ui.setTime(timeAtKey);
        ui.beginEdit('调整关键点位置');
        keyDrag = { keyId: key.id, startX: e.clientX, startS: key.s };
        refreshInspector();
        sync();
      });
      keyRow.append(marker);

      const chip = el('div', { class: 'ease-chip', text: EASE_LABELS[key.ease] });
      chip.style.left = `${x + 9}px`;
      keyRow.append(chip);

      const maxSpeed = 6;
      const stemHeight = 6 + (Math.min(key.speed, maxSpeed) / maxSpeed) * 20;
      const stem = el('div', {
        class: 'speed-tick',
        title: `速度 x${key.speed.toFixed(2)}（上下拖动调整）`,
        dataset: { keyId: key.id },
      });
      stem.style.left = `${x}px`;
      stem.style.height = `${stemHeight}px`;
      stem.style.top = `${30 - stemHeight}px`;
      stem.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        app.selectedKeyId = key.id;
        ui.beginEdit('调整速度');
        speedDrag = { keyId: key.id, startY: e.clientY, startSpeed: key.speed };
        refreshInspector();
        sync();
      });
      speedRow.append(stem);
    });
  }

  function refreshInspector(): void {
    inspector.replaceChildren();
    const app = ui.app;
    const key = app.project.timeline.keys.find((k) => k.id === app.selectedKeyId);
    if (!key) {
      inspector.append(el('span', { class: 'hint-text', text: '选择一个关键点' }));
      return;
    }
    const sorted = app.sortedKeys();
    const index = sorted.findIndex((k) => k.id === key.id);
    const entry = app.timeline.entries.find((en) => en.key.id === key.id);
    const arrivalTime = entry ? entry.holdStart : 0;

    const holdInput = el('input', {
      type: 'number',
      class: 'num-input',
      value: formatNumber(key.hold),
      min: '0',
      max: '60',
      step: '0.1',
      ariaLabel: '停留秒数',
    });
    holdInput.style.width = '62px';
    holdInput.addEventListener('change', () => {
      const v = Math.max(0, Number(holdInput.value));
      if (!Number.isFinite(v)) return;
      ui.mutate('调整停留', () => app.updateKey(key.id, { hold: Math.round(v * 20) / 20 }), { refresh: 'none' });
      refresh();
    });

    const speedInput = el('input', {
      type: 'number',
      class: 'num-input',
      value: formatNumber(key.speed),
      min: '0.1',
      max: '6',
      step: '0.05',
      ariaLabel: '速度倍率',
    });
    speedInput.style.width = '62px';
    speedInput.addEventListener('change', () => {
      const v = Math.max(0.1, Number(speedInput.value));
      if (!Number.isFinite(v)) return;
      ui.mutate('调整速度', () => app.updateKey(key.id, { speed: v }), { refresh: 'none' });
      refresh();
    });

    const easeSelect = el('select', { class: 'select-input', ariaLabel: '缓动曲线' });
    easeSelect.style.width = '94px';
    for (const ease of EASES) {
      const option = el('option', { value: ease, text: EASE_LABELS[ease] });
      if (ease === key.ease) option.selected = true;
      easeSelect.append(option);
    }
    easeSelect.addEventListener('change', () => {
      ui.mutate('调整缓动', () => app.updateKey(key.id, { ease: easeSelect.value as EaseKind }), { refresh: 'none' });
      refresh();
    });

    const sInput = el('input', {
      type: 'number',
      class: 'num-input',
      value: formatNumber(Number((key.s * 100).toFixed(2))),
      min: '0',
      max: '100',
      step: '0.5',
      ariaLabel: '路径位置百分比',
    });
    sInput.style.width = '62px';
    sInput.addEventListener('change', () => {
      const v = Math.max(0, Math.min(100, Number(sInput.value)));
      if (!Number.isFinite(v)) return;
      ui.mutate('调整关键点位置', () => app.moveKey(key.id, v / 100), { refresh: 'none' });
      refresh();
    });

    inspector.append(
      el('span', { class: 'badge is-active', text: `K${index + 1}` }),
      el('span', { class: 'field-label', text: 's%' }),
      sInput,
      el('span', { class: 'field-label', text: '停留' }),
      holdInput,
      el('span', { class: 'field-label', text: '速度' }),
      speedInput,
      easeSelect,
      el('span', { class: 'field-label', text: `到达 ${formatTime(arrivalTime, app.fps)}` }),
    );
  }

  function sync(): void {
    const duration = Math.max(ui.app.duration, 1e-6);
    const width = trackWrap.clientWidth;
    const ratio = Math.max(0, Math.min(1, ui.app.time / duration));
    playhead.style.left = `${ratio * width}px`;
  }

  function refresh(): void {
    renderRuler();
    renderKeys();
    refreshInspector();
    sync();
  }

  const timelineApi: TimelinePanelApi = { refresh, sync };
  refs.timeline = timelineApi;

  const observer = new ResizeObserver(() => {
    if (ui.disposedFlag) return;
    renderRuler();
    renderKeys();
    sync();
  });
  observer.observe(trackWrap);
  refresh();
}
