import type { Store } from '../app/state.ts';
import { stepTime } from '../app/player.ts';
import { button, chip } from './controls.ts';
import { fmt, formatTime, h } from './dom.ts';

export interface TimelineView {
  root: HTMLElement;
  update(): void;
}

export function createTimeline(store: Store, deps: { requestRender: () => void }): TimelineView {
  const playButton = button('播放', () => togglePlay(), { variant: 'primary', title: '播放 / 暂停（空格）' });
  const prevFrame = button('◀ 帧', () => step(store, -1, deps), { title: '上一帧（←）' });
  const nextFrame = button('帧 ▶', () => step(store, 1, deps), { title: '下一帧（→）' });
  const restart = button(
    '⟲',
    () => {
      store.update((app) => {
        app.playback.playing = false;
        app.playback.time = 0;
      }, 'playback');
      deps.requestRender();
    },
    { title: '回到开头（Home）' },
  );

  const loopToggle = h('input', { attrs: { type: 'checkbox', 'aria-label': '循环播放' } });
  loopToggle.addEventListener('change', () => {
    store.update((app) => {
      app.playback.loop = loopToggle.checked;
    }, 'playback');
  });
  const loopLabel = h('label', { class: 'inline-toggle' }, loopToggle, '循环');

  const rail = h('div', {
    class: 'timeline-rail',
    attrs: { role: 'slider', tabindex: '0', 'aria-label': '时间轴' },
  });
  const ticks = h('div', { class: 'timeline-ticks' });
  const progress = h('div', { class: 'timeline-progress' });
  const head = h('div', { class: 'timeline-head' });
  const hover = h('div', { class: 'timeline-hover' });
  rail.append(ticks, progress, hover, head);

  const timeLabel = h('div', { class: 'time-label' });
  const fpsLabel = h('div', { class: 'time-fps' });

  const root = h(
    'div',
    { class: 'timeline' },
    h(
      'div',
      { class: 'timeline-controls' },
      restart,
      prevFrame,
      playButton,
      nextFrame,
      loopLabel,
      h('div', { class: 'time-readout' }, timeLabel, fpsLabel),
    ),
    h('div', { class: 'timeline-track-wrap' }, rail),
  );

  let scrubbing = false;
  let tickSignature = '';

  function duration(): number {
    return Math.max(0.05, store.state.project.scene.duration);
  }

  function togglePlay() {
    store.update((app) => {
      if (!app.playback.playing && !app.playback.loop && app.playback.time >= duration() - 1e-6) {
        app.playback.time = 0;
      }
      app.playback.playing = !app.playback.playing;
    }, 'playback');
    deps.requestRender();
  }

  function seekFromEvent(event: PointerEvent) {
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    store.update((app) => {
      app.playback.time = ratio * duration();
    }, 'playback');
    deps.requestRender();
  }

  rail.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    rail.setPointerCapture(event.pointerId);
    store.update((app) => {
      app.playback.playing = false;
    }, 'playback');
    seekFromEvent(event);
    event.preventDefault();
  });
  rail.addEventListener('pointermove', (event) => {
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    hover.style.left = `${ratio * 100}%`;
    hover.dataset.label = formatTime(ratio * duration(), store.state.project.scene.fps);
    hover.classList.add('visible');
    if (scrubbing) seekFromEvent(event);
  });
  const endScrub = (event: PointerEvent) => {
    scrubbing = false;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
  };
  rail.addEventListener('pointerup', endScrub);
  rail.addEventListener('pointercancel', endScrub);
  rail.addEventListener('pointerleave', () => {
    if (!scrubbing) hover.classList.remove('visible');
  });
  rail.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      step(store, -1, deps);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      step(store, 1, deps);
      event.preventDefault();
    } else if (event.code === 'Space') {
      togglePlay();
      event.preventDefault();
    }
  });

  function buildTicks() {
    const total = duration();
    const signature = `${total}|${store.state.project.scene.fps}`;
    if (signature === tickSignature) return;
    tickSignature = signature;
    ticks.replaceChildren();
    const stepSeconds = total > 20 ? 5 : total > 8 ? 2 : 1;
    for (let t = 0; t <= total + 1e-6; t += stepSeconds) {
      const tick = h('div', { class: 'timeline-tick' });
      tick.style.left = `${(t / total) * 100}%`;
      tick.append(h('span', { text: `${Math.round(t)}s` }));
      ticks.append(tick);
    }
  }

  return {
    root,
    update() {
      const state = store.state;
      const total = duration();
      const ratio = Math.min(1, Math.max(0, state.playback.time / total));
      progress.style.width = `${ratio * 100}%`;
      head.style.left = `${ratio * 100}%`;
      playButton.textContent = state.playback.playing ? '暂停' : '播放';
      playButton.classList.toggle('is-playing', state.playback.playing);
      timeLabel.textContent = formatTime(state.playback.time, state.project.scene.fps);
      fpsLabel.textContent = `${state.project.scene.fps} fps 时间轴 · 时长 ${fmt(total, 1)}s`;
      loopToggle.checked = state.playback.loop;
      buildTicks();
      rail.setAttribute('aria-valuenow', ratio.toFixed(3));
    },
  };
}

function step(store: Store, direction: 1 | -1, deps: { requestRender: () => void }) {
  stepTime(store, direction);
  deps.requestRender();
}

export function createStatusChips(): {
  root: HTMLElement;
  update(state: import('../app/state.ts').AppState): void;
} {
  const particleChip = chip('0 粒子');
  const timeChip = chip('—');
  const capChip = chip('预算内', 'good');
  const root = h('div', { class: 'status-chips' }, particleChip, timeChip, capChip);
  return {
    root,
    update(state) {
      const stats = state.stats;
      particleChip.textContent = `${fmt(stats.particleCount)} 粒子`;
      particleChip.className = `chip chip-${stats.overCap ? 'bad' : 'neutral'}`;
      timeChip.textContent = `仿真 ${fmt(stats.simMs, 2)}ms · 绘制 ${fmt(stats.drawMs, 2)}ms`;
      if (stats.capped) {
        capChip.textContent = `已抽稀 ${fmt(stats.omitted)} 个`;
        capChip.className = 'chip chip-warn';
        capChip.title = `存活粒子超过上限 ${fmt(state.project.scene.maxParticles)}，已按比例抽稀显示。`;
      } else if (stats.overCap) {
        capChip.textContent = '预算紧张';
        capChip.className = 'chip chip-warn';
        capChip.title = '粒子数接近上限。';
      } else if (stats.scanReduced) {
        capChip.textContent = '候选过多·已抽样';
        capChip.className = 'chip chip-warn';
        capChip.title = '发射候选过多，仿真按等距抽样统计。';
      } else {
        capChip.textContent = '预算内';
        capChip.className = 'chip chip-good';
        capChip.title = `粒子上限 ${fmt(state.project.scene.maxParticles)}`;
      }
    },
  };
}
