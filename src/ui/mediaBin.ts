import type { Store } from '../store';
import type { AudioEngine } from '../audio/AudioEngine';
import { Recorder } from '../audio/Recorder';
import { decodeAudio } from '../audio/wav';
import { uid } from '../utils/helpers';

/**
 * 素材库：
 * - 列出工程可用资源（内置示例 + 录音 + 本地导入）
 * - 点击资源后再点轨道的 ＋，或通过右键菜单把片段放到时间线
 * - 录音：getUserMedia 采集，WAV 存 IndexedDB
 * - 导入：本地选择音频文件，对象 URL 仅存于内存（刷新前可用）
 */
export class MediaBin {
  private el: HTMLElement;
  private store: Store;
  private engine: AudioEngine;
  private recorder = new Recorder();
  private selectedResourceId: string | null = null;
  private fileInput: HTMLInputElement;

  constructor(el: HTMLElement, store: Store, engine: AudioEngine) {
    this.el = el;
    this.store = store;
    this.engine = engine;

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'audio/*';
    this.fileInput.multiple = true;
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files) void this.importFiles(Array.from(this.fileInput.files));
      this.fileInput.value = '';
    });
    document.body.appendChild(this.fileInput);

    store.subscribe(() => this.render());
    this.bindAddClipEvents();
    this.render();
  }

  get selectedResource(): string | null {
    return this.selectedResourceId && this.store.project.resources[this.selectedResourceId]
      ? this.selectedResourceId
      : null;
  }

  private bindAddClipEvents(): void {
    document.addEventListener('arranger:add-clip-at', (e) => {
      const detail = (e as CustomEvent<{ trackId: string; time: number }>).detail;
      const resourceId = this.selectedResource;
      if (!resourceId) {
        window.dispatchEvent(new CustomEvent('arranger:toast', { detail: '请先在素材库选择一个资源' }));
        return;
      }
      this.store.addClip(detail.trackId, resourceId, detail.time);
    });
  }

  private render(): void {
    this.el.innerHTML = '';

    const title = document.createElement('h2');
    title.className = 'bin-title';
    title.textContent = '素材库';
    this.el.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'bin-actions';

    const importBtn = document.createElement('button');
    importBtn.className = 'btn';
    importBtn.textContent = '导入本地音频';
    importBtn.addEventListener('click', () => this.fileInput.click());

    const recordBtn = document.createElement('button');
    recordBtn.className = `btn ${this.recorder.isActive ? 'recording' : ''}`;
    recordBtn.textContent = this.recorder.isActive ? '● 停止录音' : '● 开始录音';
    recordBtn.addEventListener('click', () => {
      if (this.recorder.isActive) void this.stopRecording(recordBtn);
      else void this.startRecording(recordBtn);
    });

    actions.append(importBtn, recordBtn);
    this.el.appendChild(actions);

    const hint = document.createElement('p');
    hint.className = 'bin-hint';
    hint.textContent = '选中资源后，点击轨道「＋」或在时间线右键放置片段';
    this.el.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'resource-list';
    for (const meta of Object.values(this.store.project.resources)) {
      const item = document.createElement('button');
      item.className = `resource-item ${this.selectedResourceId === meta.id ? 'selected' : ''}`;
      const icon = meta.kind === 'recording' ? '🎙' : meta.kind === 'sample' ? '♪' : '📁';
      item.innerHTML = `<span class="resource-icon">${icon}</span><span class="resource-meta"><span class="resource-name"></span><span class="resource-dur">${meta.duration.toFixed(1)}s · ${meta.kind === 'recording' ? '录音' : meta.kind === 'sample' ? '示例' : '导入'}</span></span>`;
      item.querySelector<HTMLElement>('.resource-name')!.textContent = meta.name;
      item.addEventListener('click', () => {
        this.selectedResourceId = meta.id;
        this.render();
      });
      list.appendChild(item);
    }
    this.el.appendChild(list);
  }

  private async startRecording(btn: HTMLButtonElement): Promise<void> {
    try {
      await this.engine.ensureContext();
      await this.recorder.start();
      btn.classList.add('recording');
      btn.textContent = '● 停止录音';
      window.dispatchEvent(new CustomEvent('arranger:toast', { detail: '录音中…再次点击停止' }));
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('arranger:toast', { detail: `无法访问麦克风：${(err as Error).message}` }),
      );
    }
  }

  private async stopRecording(btn: HTMLButtonElement): Promise<void> {
    try {
      const id = uid('rec');
      const result = await this.recorder.stop(id);
      this.engine.cacheBuffer(id, result.buffer);
      this.store.addResource({
        id,
        name: `录音 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
        duration: result.duration,
        kind: 'recording',
      });
      this.selectedResourceId = id;
      window.dispatchEvent(new CustomEvent('arranger:toast', { detail: '录音已保存到本地（IndexedDB）' }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('arranger:toast', { detail: `录音失败：${(err as Error).message}` }));
    } finally {
      btn.classList.remove('recording');
      btn.textContent = '● 开始录音';
      this.render();
    }
  }

  private async importFiles(files: File[]): Promise<void> {
    await this.engine.ensureContext();
    for (const file of files) {
      try {
        const data = await file.arrayBuffer();
        const ctx = await this.engine.ensureContext();
        const buffer = await decodeAudio(ctx, data);
        const id = uid('imp');
        const url = URL.createObjectURL(file);
        this.engine.cacheBuffer(id, buffer);
        this.store.addResource({
          id,
          name: file.name.replace(/\.[^.]+$/, ''),
          duration: buffer.duration,
          kind: 'sample',
          url,
        });
        this.selectedResourceId = id;
        window.dispatchEvent(new CustomEvent('arranger:toast', { detail: `已导入：${file.name}` }));
      } catch (err) {
        window.dispatchEvent(
          new CustomEvent('arranger:toast', { detail: `导入失败 ${file.name}：${(err as Error).message}` }),
        );
      }
    }
  }
}
