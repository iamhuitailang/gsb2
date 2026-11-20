// 材质面板：列出场景全部材质，支持漫反射颜色/不透明度覆盖，并标注贴图缺失占位状态

import type { MaterialOverride, MtlMaterial, SceneModel } from '../core/types';
import { clear, h } from './dom';
import { rgbToHex } from '../render/textures';

export class MaterialPanel {
  constructor(
    private container: HTMLElement,
    private onOverrideChange: (name: string, override: MaterialOverride | null) => void,
  ) {}

  update(model: SceneModel | null, overrides: Map<string, MaterialOverride>): void {
    clear(this.container);
    if (!model) {
      this.container.append(
        h('div', { className: 'empty-hint', textContent: '载入模型后在此预览和调整材质。' }),
      );
      return;
    }

    const names = [...model.materials.keys()];
    if (names.length === 0) {
      this.container.append(
        h('div', { className: 'empty-hint', textContent: '该模型没有任何材质（包括自动生成的默认材质），无法调整。' }),
      );
      return;
    }

    for (const name of names) {
      const mat = model.materials.get(name);
      if (!mat) continue;
      this.container.append(this.renderMaterial(name, mat, model, overrides));
    }
  }

  private renderMaterial(
    name: string,
    mat: MtlMaterial,
    model: SceneModel,
    overrides: Map<string, MaterialOverride>,
  ): HTMLElement {
    const override = overrides.get(name);
    const missing = model.missingTextures.get(name);
    const isDefault = name === '__default__';

    const title = h('div', { className: 'material-title' },
      h('span', { className: 'material-name', textContent: isDefault ? '默认材质（自动生成）' : name }),
    );

    const diffuseHex = override?.diffuse ?? rgbToHex(mat.diffuse.r, mat.diffuse.g, mat.diffuse.b);
    const colorInput = h('input', { type: 'color', value: diffuseHex, className: 'material-color' }) as HTMLInputElement;
    colorInput.addEventListener('input', () => {
      this.onOverrideChange(name, {
        diffuse: colorInput.value,
        opacity: override?.opacity,
      });
    });

    const opacity = override?.opacity ?? mat.opacity;
    const opacityInput = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: String(opacity),
      className: 'material-opacity',
    }) as HTMLInputElement;
    const opacityValue = h('span', { className: 'opacity-value', textContent: opacity.toFixed(2) });
    opacityInput.addEventListener('input', () => {
      opacityValue.textContent = Number(opacityInput.value).toFixed(2);
      this.onOverrideChange(name, {
        diffuse: override?.diffuse,
        opacity: Number(opacityInput.value),
      });
    });

    const resetBtn = h('button', {
      className: 'btn btn-small',
      textContent: '重置覆盖',
    });
    resetBtn.addEventListener('click', () => this.onOverrideChange(name, null));

    const mapInfo = mat.diffuseMap
      ? h('div', { className: `texture-info ${missing ? 'texture-missing' : 'texture-ok'}` },
          h('span', { textContent: `map_Kd: ${mat.diffuseMap.path}` }),
          missing
            ? h('span', { className: 'badge badge-warn', textContent: '贴图缺失 · 棋盘格占位' })
            : h('span', { className: 'badge badge-ok', textContent: '贴图已加载' }),
        )
      : h('div', { className: 'texture-info texture-none', textContent: '无漫反射贴图，使用纯色 Kd' });

    return h('div', { className: 'material-card' },
      title,
      h('div', { className: 'material-row' },
        h('label', { textContent: '漫反射' }), colorInput),
      h('div', { className: 'material-row' },
        h('label', { textContent: '不透明度' }), opacityInput, opacityValue),
      mapInfo,
      h('div', { className: 'material-row' }, resetBtn),
    );
  }
}
