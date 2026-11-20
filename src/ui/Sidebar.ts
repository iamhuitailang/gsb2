import type { UniformMeta, UniformValue } from '../types';
import { h, clear } from './dom';
import { BUILTIN_TEXTURES, fileToDataUrl } from '../webgl/textures';

interface SidebarCallbacks {
  getValue: (name: string) => UniformValue | undefined;
  setValue: (name: string, value: UniformValue) => void;
  onTextureFile: (name: string, dataUrl: string) => void;
}

const rgbToHex = (v: number[]) => {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const hex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${hex(v[0] ?? 0)}${hex(v[1] ?? 0)}${hex(v[2] ?? 0)}`;
};

const hexToRgb = (hex: string): number[] => {
  const m = hex.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
};

export class Sidebar {
  readonly element: HTMLElement;
  private cb: SidebarCallbacks;

  constructor(cb: SidebarCallbacks) {
    this.cb = cb;
    this.element = h('div', { className: 'sidebar' });
  }

  /** uniform 签名变化时整体重建 */
  render(mainMetas: UniformMeta[], postMetas: UniformMeta[], postEnabled: boolean) {
    clear(this.element);
    this.element.append(this.renderGroup('着色器参数', mainMetas));
    const extra = postMetas.filter((m) => !mainMetas.some((x) => x.name === m.name));
    if (postEnabled && extra.length > 0) {
      this.element.append(this.renderGroup('后处理附加参数', extra));
    }
    if (mainMetas.length === 0 && extra.length === 0) {
      this.element.append(
        h('p', { className: 'sidebar-empty', textContent: '在着色器里声明 uniform 后，这里会出现对应控件。' }),
      );
    }
  }

  private renderGroup(title: string, metas: UniformMeta[]): HTMLElement {
    const group = h('section', { className: 'control-group' }, [
      h('h3', { textContent: title }),
    ]);
    for (const meta of metas) {
      const value = this.cb.getValue(meta.name);
      if (value === undefined) continue;
      group.append(this.renderControl(meta, value));
    }
    return group;
  }

  private renderControl(meta: UniformMeta, value: UniformValue): HTMLElement {
    const row = h('div', { className: `control-row control-${meta.kind}` }, [
      h('label', { className: 'control-name', textContent: meta.name, title: meta.glslType }),
    ]);
    const body = h('div', { className: 'control-body' });

    switch (meta.kind) {
      case 'float':
        body.append(this.floatControl(meta, Number(value)));
        break;
      case 'int':
        body.append(this.intControl(meta, Number(value)));
        break;
      case 'bool':
        body.append(this.boolControl(meta, Boolean(value)));
        break;
      case 'color':
        body.append(this.colorControl(meta, value as number[]));
        break;
      case 'vec2':
      case 'vec3':
      case 'vec4':
        body.append(this.vecControl(meta, value as number[]));
        break;
      case 'texture':
        body.append(this.textureControl(meta, String(value)));
        break;
    }
    row.append(body);
    return row;
  }

  private floatControl(meta: UniformMeta, value: number): HTMLElement {
    const min = meta.min ?? 0;
    const max = meta.max ?? 1;
    const step = meta.step ?? 0.01;
    const slider = h('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    }) as HTMLInputElement;
    const number = h('input', {
      type: 'number', step: String(step), value: String(value),
    }) as HTMLInputElement;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      number.value = String(v);
      this.cb.setValue(meta.name, v);
    });
    number.addEventListener('input', () => this.cb.setValue(meta.name, Number(number.value)));
    return h('div', { className: 'control-inline' }, [slider, number]);
  }

  private intControl(meta: UniformMeta, value: number): HTMLElement {
    const input = h('input', {
      type: 'number', step: '1', value: String(Math.round(value)),
    }) as HTMLInputElement;
    input.addEventListener('input', () => this.cb.setValue(meta.name, Math.round(Number(input.value))));
    return input;
  }

  private boolControl(meta: UniformMeta, value: boolean): HTMLElement {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    input.checked = value;
    input.addEventListener('change', () => this.cb.setValue(meta.name, input.checked));
    return input;
  }

  private colorControl(meta: UniformMeta, value: number[]): HTMLElement {
    const picker = h('input', { type: 'color', value: rgbToHex(value) }) as HTMLInputElement;
    const raw = h('input', {
      type: 'text',
      className: 'color-raw',
      value: value.map((v) => v.toFixed(2)).join(', '),
      readonly: 'true',
    }) as HTMLInputElement;
    picker.addEventListener('input', () => {
      const rgb = hexToRgb(picker.value);
      // vec4 颜色保留 alpha 分量
      if (meta.size === 4) rgb.push(value[3] ?? 1);
      raw.value = rgb.map((v) => v.toFixed(2)).join(', ');
      this.cb.setValue(meta.name, rgb);
    });
    return h('div', { className: 'control-inline' }, [picker, raw]);
  }

  private vecControl(meta: UniformMeta, value: number[]): HTMLElement {
    const wrap = h('div', { className: 'vec-wrap' });
    for (let i = 0; i < meta.size; i++) {
      const input = h('input', {
        type: 'number',
        step: meta.step ? String(meta.step) : '0.01',
        value: String(value[i] ?? 0),
      }) as HTMLInputElement;
      input.addEventListener('input', () => {
        const next = value.slice();
        next[i] = Number(input.value);
        this.cb.setValue(meta.name, next);
      });
      wrap.append(input);
    }
    return wrap;
  }

  private textureControl(meta: UniformMeta, dataUrl: string): HTMLElement {
    const wrap = h('div', { className: 'texture-wrap' });
    const thumb = h('img', { className: 'texture-thumb', alt: meta.name }) as HTMLImageElement;
    thumb.src = dataUrl || BUILTIN_TEXTURES[0].dataUrl;
    thumb.title = dataUrl ? '当前纹理' : '未指定（使用引擎占位纹理）';

    const fileInput = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const url = await fileToDataUrl(file);
      this.cb.onTextureFile(meta.name, url);
      thumb.src = url;
      fileInput.value = '';
    });

    const uploadBtn = h('button', { type: 'button', textContent: '上传图片' });
    uploadBtn.addEventListener('click', () => fileInput.click());

    const clearBtn = h('button', { type: 'button', textContent: '清除' });
    clearBtn.addEventListener('click', () => {
      this.cb.setValue(meta.name, '');
      thumb.src = BUILTIN_TEXTURES[0].dataUrl;
    });

    const chips = h('div', { className: 'texture-chips' });
    for (const builtin of BUILTIN_TEXTURES) {
      const chip = h('button', {
        type: 'button',
        className: 'texture-chip',
        textContent: builtin.label,
      });
      chip.addEventListener('click', () => {
        this.cb.setValue(meta.name, builtin.dataUrl);
        thumb.src = builtin.dataUrl;
      });
      chips.append(chip);
    }

    wrap.append(thumb, h('div', { className: 'texture-actions' }, [uploadBtn, clearBtn]), chips, fileInput);
    return wrap;
  }
}
