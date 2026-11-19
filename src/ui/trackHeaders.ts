import type { Store } from '../store';
import type { AudioEngine } from '../audio/AudioEngine';
import { RULER_HEIGHT, TRACK_HEIGHT } from '../types';

/**
 * 左侧轨道控制列：新增、重命名、静音(M)、独奏(S)、轨道音量。
 * 行高与时间线 TRACK_HEIGHT 严格一致，并跟随时间线纵向滚动。
 */
export class TrackHeaders {
  private el: HTMLElement;
  private store: Store;
  private engine: AudioEngine;

  constructor(el: HTMLElement, store: Store, engine: AudioEngine) {
    this.el = el;
    this.store = store;
    this.engine = engine;
    store.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const anySolo = this.store.project.tracks.some((t) => t.solo);
    this.el.innerHTML = '';

    for (const track of this.store.project.tracks) {
      const row = document.createElement('div');
      row.className = 'track-header';
      row.style.height = `${TRACK_HEIGHT}px`;
      if (track.id === this.store.view.automationTrackId) row.classList.add('has-automation');
      if (anySolo && !track.solo) row.classList.add('dimmed');

      const top = document.createElement('div');
      top.className = 'track-header-top';

      const name = document.createElement('button');
      name.className = 'track-name';
      name.title = '点击重命名轨道';
      name.textContent = track.name;
      name.addEventListener('click', () => {
        const next = window.prompt('轨道名称', track.name);
        if (next !== null) this.store.renameTrack(track.id, next);
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'icon-btn';
      addBtn.title = '在该轨道添加所选资源片段';
      addBtn.textContent = '＋';
      addBtn.addEventListener('click', () => {
        document.dispatchEvent(
          new CustomEvent('arranger:add-clip-at', { detail: { trackId: track.id, time: this.store.project.length } }),
        );
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn danger';
      delBtn.title = '删除轨道';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        if (window.confirm(`删除轨道「${track.name}」及其全部片段？`)) {
          this.store.removeTrack(track.id);
        }
      });

      top.append(name, addBtn, delBtn);

      const controls = document.createElement('div');
      controls.className = 'track-header-controls';

      const muteBtn = document.createElement('button');
      muteBtn.className = `state-btn ${track.muted ? 'active mute' : ''}`;
      muteBtn.textContent = 'M';
      muteBtn.title = '静音';
      muteBtn.addEventListener('click', () => {
        this.store.toggleMute(track.id);
        this.engine.reschedule(this.store.project);
      });

      const soloBtn = document.createElement('button');
      soloBtn.className = `state-btn ${track.solo ? 'active solo' : ''}`;
      soloBtn.textContent = 'S';
      soloBtn.title = '独奏';
      soloBtn.addEventListener('click', () => {
        this.store.toggleSolo(track.id);
        this.engine.reschedule(this.store.project);
      });

      const autoBtn = document.createElement('button');
      autoBtn.className = `state-btn auto ${this.store.view.automationTrackId === track.id ? 'active' : ''}`;
      autoBtn.textContent = 'A';
      autoBtn.title = '显示/隐藏音量自动化层';
      autoBtn.addEventListener('click', () => {
        this.store.view.automationTrackId =
          this.store.view.automationTrackId === track.id ? null : track.id;
        this.store.commit();
      });

      const volume = document.createElement('div');
      volume.className = 'volume-control';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = String(track.volume);
      slider.title = '轨道音量';
      slider.addEventListener('input', () => {
        this.store.setTrackVolume(track.id, Number(slider.value));
        this.engine.reschedule(this.store.project);
      });
      const pct = document.createElement('span');
      pct.className = 'volume-pct';
      pct.textContent = `${Math.round(track.volume * 100)}%`;
      volume.append(slider, pct);

      controls.append(muteBtn, soloBtn, autoBtn, volume);
      row.append(top, controls);
      this.el.appendChild(row);
    }

    const addTrackRow = document.createElement('button');
    addTrackRow.className = 'add-track-btn';
    addTrackRow.style.height = `${TRACK_HEIGHT}px`;
    addTrackRow.textContent = '＋ 新增轨道';
    addTrackRow.addEventListener('click', () => this.store.addTrack());
    this.el.appendChild(addTrackRow);

    this.el.style.paddingTop = '0';
    this.el.style.minHeight = `calc(100% - ${RULER_HEIGHT}px)`;
  }
}
