import type { PreviewSettings, ShaderDiagnostic } from '../types';
import { RESOLUTION_PRESETS } from '../state/store';
import { h, clear } from './dom';

interface PreviewCallbacks {
  getPreview: () => PreviewSettings;
  setPreview: (patch: Partial<PreviewSettings>) => void;
  onExportPng: () => void;
}

export class PreviewPanel {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private cb: PreviewCallbacks;
  private errorBox: HTMLElement;
  private sizeLabel: HTMLElement;
  private fullBtn!: HTMLButtonElement;
  private meshBtn!: HTMLButtonElement;
  private resSelect!: HTMLSelectElement;
  private postCheckbox!: HTMLInputElement;

  constructor(cb: PreviewCallbacks) {
    this.cb = cb;
    this.canvas = h('canvas', { className: 'preview-canvas' }) as HTMLCanvasElement;
    this.errorBox = h('div', { className: 'error-box' });
    this.sizeLabel = h('span', { className: 'size-label' });

    const modeGroup = this.buildModeGroup();
    const resGroup = this.buildResolutionGroup();
    const postToggle = this.buildPostToggle();
    const exportBtn = h('button', { type: 'button', textContent: '导出 PNG' });
    exportBtn.addEventListener('click', () => this.cb.onExportPng());

    const toolbar = h('div', { className: 'preview-toolbar' }, [
      modeGroup, resGroup, postToggle, exportBtn,
    ]);

    this.element = h('div', { className: 'preview-panel' }, [
      toolbar,
      h('div', { className: 'canvas-stage' }, [this.canvas]),
      this.sizeLabel,
      this.errorBox,
    ]);
  }

  /** 工程切换 / 设置变化后，把控件状态同步回当前 store */
  syncControls() {
    const preview = this.cb.getPreview();
    this.fullBtn.classList.toggle('seg-active', preview.mode === 'fullscreen');
    this.meshBtn.classList.toggle('seg-active', preview.mode === 'mesh');
    this.resSelect.value = preview.resolutionKey;
    this.postCheckbox.checked = preview.postEnabled;
  }

  private buildModeGroup(): HTMLElement {
    const preview = this.cb.getPreview();
    this.fullBtn = h('button', {
      type: 'button',
      className: preview.mode === 'fullscreen' ? 'seg seg-active' : 'seg',
      textContent: '全屏图形',
    }) as HTMLButtonElement;
    this.meshBtn = h('button', {
      type: 'button',
      className: preview.mode === 'mesh' ? 'seg seg-active' : 'seg',
      textContent: '纹理网格',
    }) as HTMLButtonElement;
    this.fullBtn.addEventListener('click', () => this.cb.setPreview({ mode: 'fullscreen' }));
    this.meshBtn.addEventListener('click', () => this.cb.setPreview({ mode: 'mesh' }));
    return h('div', { className: 'seg-group' }, [this.fullBtn, this.meshBtn]);
  }

  private buildResolutionGroup(): HTMLElement {
    const preview = this.cb.getPreview();
    this.resSelect = h('select', { className: 'res-select' }) as HTMLSelectElement;
    for (const preset of RESOLUTION_PRESETS) {
      const option = h('option', {
        value: preset.key,
        textContent: preset.label,
      }) as HTMLOptionElement;
      if (preset.key === preview.resolutionKey) option.selected = true;
      this.resSelect.append(option);
    }
    this.resSelect.addEventListener('change', () => {
      this.cb.setPreview({ resolutionKey: this.resSelect.value });
    });

    const widthInput = h('input', {
      type: 'number', min: '64', max: '1920', value: String(preview.customWidth),
      className: 'res-number',
    }) as HTMLInputElement;
    const heightInput = h('input', {
      type: 'number', min: '64', max: '1080', value: String(preview.customHeight),
      className: 'res-number',
    }) as HTMLInputElement;
    const commit = () => this.cb.setPreview({
      resolutionKey: 'custom',
      customWidth: Number(widthInput.value) || 640,
      customHeight: Number(heightInput.value) || 480,
    });
    widthInput.addEventListener('change', commit);
    heightInput.addEventListener('change', commit);

    return h('div', { className: 'res-group' }, [
      this.resSelect,
      h('span', { className: 'res-x', textContent: '×' }),
      widthInput,
      heightInput,
    ]);
  }

  private buildPostToggle(): HTMLElement {
    const preview = this.cb.getPreview();
    this.postCheckbox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.postCheckbox.checked = preview.postEnabled;
    this.postCheckbox.addEventListener('change', () => {
      this.cb.setPreview({ postEnabled: this.postCheckbox.checked });
    });
    return h('label', { className: 'post-toggle' }, [this.postCheckbox, ' 后处理']);
  }

  showErrors(diagnostics: ShaderDiagnostic[], onJump: (line: number) => void) {
    clear(this.errorBox);
    if (diagnostics.length === 0) {
      this.errorBox.classList.add('hidden');
      return;
    }
    this.errorBox.classList.remove('hidden');
    this.errorBox.append(
      h('div', { className: 'error-title', textContent: '编译失败 —— 画布保留上一次成功结果' }),
    );
    // 同一行去重，避免日志噪音
    const seen = new Set<number>();
    for (const d of diagnostics) {
      const key = d.line * 100000 + d.message.length;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = h('button', {
        type: 'button',
        className: 'error-item',
      });
      item.append(
        h('span', { className: 'error-line', textContent: `第 ${d.line} 行` }),
        h('span', { className: 'error-msg', textContent: d.message }),
      );
      item.addEventListener('click', () => onJump(d.line));
      this.errorBox.append(item);
    }
  }

  setSizeLabel(width: number, height: number) {
    this.sizeLabel.textContent = `画布 ${width} × ${height}（CSS 缩放不影响内部像素）`;
  }
}
