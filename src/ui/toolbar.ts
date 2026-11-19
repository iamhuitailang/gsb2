import type { Store } from '../store';
import type { AudioEngine } from '../audio/AudioEngine';
import { exportMix } from '../audio/exporter';
import { formatTime } from '../utils/helpers';

/** 顶部工具栏：播放/暂停/停止/跳转、缩放、吸附、导出、工程保存与重置 */
export class Toolbar {
  private store: Store;
  private engine: AudioEngine;
  private timeDisplay: HTMLElement;
  private exportBtn: HTMLButtonElement | null = null;

  constructor(store: Store, engine: AudioEngine) {
    this.store = store;
    this.engine = engine;
    this.timeDisplay = document.getElementById('time-display')!;

    this.buildTransport();
    this.buildViewControls();
    this.buildModeControls();
    this.buildExportControls();
    this.buildProjectControls();

    engine.onPosition((t) => this.updateTime(t));
    engine.onStateChange(() => this.syncPlayButton());
    store.subscribe(() => {
      this.updateTime(engine.currentTime);
      this.syncSnapButton();
    });
    this.updateTime(0);
  }

  private buildTransport(): void {
    const host = document.getElementById('transport')!;
    const make = (label: string, title: string, fn: () => void) => {
      const btn = document.createElement('button');
      btn.className = 'btn transport-btn';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', fn);
      host.appendChild(btn);
      return btn;
    };
    make('⏮', '回到开头 (Home)', () => this.engine.seek(this.store.project, 0));
    const playBtn = make('▶', '播放/暂停 (空格)', () => {
      if (this.engine.isPlaying) this.engine.pause();
      else void this.engine.play(this.store.project);
    });
    playBtn.dataset.role = 'play';
    make('⏹', '停止', () => this.engine.stop());
    make('⏪ 5s', '后退 5 秒', () => this.engine.seek(this.store.project, this.engine.currentTime - 5));
    make('5s ⏩', '前进 5 秒', () =>
      this.engine.seek(this.store.project, this.engine.currentTime + 5),
    );
  }

  private buildViewControls(): void {
    const host = document.getElementById('view-controls')!;
    const make = (label: string, title: string, fn: () => void) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', fn);
      host.appendChild(btn);
    };
    make('－', '缩小（Ctrl/⌘ + 滚轮也可缩放）', () => this.zoom(1 / 1.25));
    make('＋', '放大', () => this.zoom(1.25));
    make('适应', '缩放至完整工程', () => this.fitProject());
  }

  private buildModeControls(): void {
    const host = document.getElementById('mode-controls')!;
    const snapBtn = document.createElement('button');
    snapBtn.className = 'btn';
    snapBtn.dataset.role = 'snap';
    snapBtn.addEventListener('click', () => {
      this.store.view.snap = !this.store.view.snap;
      this.store.commit();
    });
    host.appendChild(snapBtn);

    const fadeLabel = document.createElement('label');
    fadeLabel.className = 'fade-control';
    fadeLabel.textContent = '末尾淡出 ';
    const fadeInput = document.createElement('input');
    fadeInput.type = 'number';
    fadeInput.min = '0';
    fadeInput.step = '0.5';
    fadeInput.value = String(this.store.project.tailFade);
    fadeInput.addEventListener('change', () => {
      this.store.project.tailFade = Math.max(0, Number(fadeInput.value) || 0);
      this.store.commit();
    });
    fadeLabel.append(fadeInput, document.createTextNode(' s'));
    host.appendChild(fadeLabel);
  }

  private buildExportControls(): void {
    const host = document.getElementById('export-controls')!;
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = '导出混音 WAV';
    btn.title = '按项目长度离线渲染，与播放预览同源';
    btn.addEventListener('click', () => void this.doExport());
    host.appendChild(btn);
    this.exportBtn = btn;
  }

  private buildProjectControls(): void {
    const host = document.getElementById('project-controls')!;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.textContent = '保存';
    saveBtn.title = '立即写入 localStorage（平时自动保存）';
    saveBtn.addEventListener('click', () => {
      this.store.flushSave();
      this.toast('工程已保存');
    });

    const sampleBtn = document.createElement('button');
    sampleBtn.className = 'btn';
    sampleBtn.textContent = '载入示例';
    sampleBtn.addEventListener('click', () => {
      if (window.confirm('载入示例工程将覆盖当前编辑，确定？')) {
        this.store.resetToSample();
        this.toast('已载入示例工程');
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn danger';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      if (window.confirm('清空全部轨道？（资源保留，可重新放置）')) {
        this.store.clearProject();
      }
    });

    host.append(saveBtn, sampleBtn, clearBtn);
  }

  private zoom(factor: number): void {
    const view = this.store.view;
    const center = view.scrollTime + (this.timelineWidth() / 2) / view.pxPerSecond;
    view.pxPerSecond = Math.min(600, Math.max(8, view.pxPerSecond * factor));
    view.scrollTime = Math.max(0, center - this.timelineWidth() / 2 / view.pxPerSecond);
    this.store.commit();
  }

  private fitProject(): void {
    const length = Math.max(4, this.store.project.length);
    const width = this.timelineWidth();
    this.store.view.pxPerSecond = Math.min(600, Math.max(8, (width - 40) / length));
    this.store.view.scrollTime = 0;
    this.store.commit();
  }

  private timelineWidth(): number {
    return document.getElementById('timeline-scroll')?.clientWidth ?? 800;
  }

  private async doExport(): Promise<void> {
    if (this.store.project.length <= 0) {
      this.toast('工程为空：请先在时间线上放置片段');
      return;
    }
    const ctx = await this.engine.ensureContext();
    if (!this.exportBtn) return;
    this.exportBtn.disabled = true;
    const original = this.exportBtn.textContent;
    try {
      const blob = await exportMix(this.store.project, ctx, (msg) => {
        if (this.exportBtn) this.exportBtn.textContent = msg;
      });
      if (!blob) {
        this.toast('工程为空，无可导出内容');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.store.project.name || 'mix'}.wav`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.toast(`导出完成：${a.download}（时长 ${this.store.project.length.toFixed(1)}s）`);
    } catch (err) {
      console.error(err);
      this.toast(`导出失败：${(err as Error).message}`);
    } finally {
      if (this.exportBtn) {
        this.exportBtn.disabled = false;
        this.exportBtn.textContent = original;
      }
    }
  }

  private updateTime(t: number): void {
    this.timeDisplay.textContent = `${formatTime(t)} / ${formatTime(this.store.project.length)}`;
  }

  private syncPlayButton(): void {
    const btn = document.querySelector<HTMLButtonElement>('[data-role="play"]');
    if (btn) btn.textContent = this.engine.isPlaying ? '⏸' : '▶';
  }

  private syncSnapButton(): void {
    const btn = document.querySelector<HTMLButtonElement>('[data-role="snap"]');
    if (btn) {
      btn.textContent = this.store.view.snap ? '吸附：开' : '吸附：关';
      btn.classList.toggle('active', this.store.view.snap);
    }
  }

  private toast(message: string): void {
    window.dispatchEvent(new CustomEvent('arranger:toast', { detail: message }));
  }
}
