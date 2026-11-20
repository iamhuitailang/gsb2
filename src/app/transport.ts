import type { CameraPathEditorUi } from './ui.js';
import type { TransportApi, UiRefs } from './ui-types.js';
import { button, el, formatTime } from './dom.js';

/**
 * Transport bar under the viewport: frame stepping, play/pause, timeline
 * scrubbing readout and playback options.
 */
export function buildTransport(ui: CameraPathEditorUi, refs: UiRefs): void {
  const host = document.getElementById('transport');
  if (!host) return;

  const timeLabel = el('div', { class: 'transport-time' });
  const meta = el('div', { class: 'transport-meta' });

  const playBtn = button('▶', () => {
    ui.app.togglePlay();
    api.refresh();
    ui.needsRenderNow();
  }, { class: 'btn is-primary', title: '播放 / 暂停 (Space)' });

  const prevBtn = button('⏮', () => ui.setTime(0), { class: 'btn is-icon', title: '回到开头 (Home)' });
  const stepBack = button('◀', () => {
    ui.app.stepFrame(-1);
    ui.setTime(ui.app.time);
  }, { class: 'btn is-icon', title: '上一帧 (←)' });
  const stepFwd = button('▶', () => {
    ui.app.stepFrame(1);
    ui.setTime(ui.app.time);
  }, { class: 'btn is-icon', title: '下一帧 (→)' });
  const endBtn = button('⏭', () => ui.setTime(ui.app.duration), { class: 'btn is-icon', title: '到结尾 (End)' });

  const loopToggle = button('循环：开', () => {
    ui.mutate('切换循环', () => {
      ui.app.project.timeline.loop = !ui.app.project.timeline.loop;
      ui.app.markDirty();
    }, { refresh: 'none' });
    api.refresh();
  }, { class: 'btn', title: '循环播放（时间指针到达结尾后回到开头）' });

  const frameInput = el('input', {
    type: 'number',
    class: 'num-input',
    value: '0',
    min: '0',
    step: '1',
    ariaLabel: '跳转到帧',
  });
  frameInput.style.width = '70px';
  frameInput.addEventListener('change', () => {
    const frame = Number(frameInput.value);
    if (Number.isFinite(frame)) ui.setTime(frame / ui.app.fps);
    api.sync();
  });

  host.replaceChildren(
    el('div', { class: 'transport-group' }, [prevBtn, stepBack, playBtn, stepFwd, endBtn]),
    timeLabel,
    el('div', { class: 'transport-group' }, [
      el('span', { class: 'field-label', text: '帧' }),
      frameInput,
      button('截图', () => ui.exportScreenshot(), { class: 'btn is-ghost', title: '导出当前帧截图（不含辅助线）' }),
    ]),
    el('div', { class: 'transport-spacer' }),
    meta,
    el('div', { class: 'transport-group' }, [loopToggle]),
  );

  const api: TransportApi = {
    refresh(): void {
      playBtn.textContent = ui.app.playing ? '❚❚' : '▶';
      playBtn.classList.toggle('is-primary', !ui.app.playing);
      loopToggle.classList.toggle('is-primary', ui.app.project.timeline.loop);
      loopToggle.textContent = ui.app.project.timeline.loop ? '循环：开' : '循环：关';
      api.sync();
    },
    sync(): void {
      const app = ui.app;
      timeLabel.replaceChildren(
        el('span', { text: formatTime(app.time, app.fps) }),
        el('small', { text: `帧 ${app.frame} / ${app.totalFrames}` }),
      );
      meta.replaceChildren(
        el('span', {}, [el('b', { text: `${app.duration.toFixed(2)}s` }), document.createTextNode(' 总时长')]),
        el('span', {}, [el('b', { text: `${app.totalFrames}` }), document.createTextNode(' 总帧数')]),
        el('span', {}, [el('b', { text: `${app.fps}fps` }), document.createTextNode(' 采样率')]),
        el('span', {}, [el('b', { text: `${app.timeline.entries.length}` }), document.createTextNode(' 段')]),
      );
      if (document.activeElement !== frameInput) frameInput.value = String(app.frame);
    },
  };
  refs.transport = api;
  api.refresh();
}
