import type { OrbitCamera } from './camera';
import type { WebGL2Renderer } from './renderer';
import type { DrawItem, InstanceData } from './types';

/**
 * 编号标签用 DOM 覆盖层实现（随每帧投影位置更新）。
 * 标签显示“稳定编号 #id / slot”，slot 与内部绘制顺序一一对应、每帧可变化，
 * 从而可以直接观察“编号不动、slot 补位”的区别。
 */
export class LabelLayer {
  private layer: HTMLElement;
  private els = new Map<number, HTMLElement>();

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  update(
    drawList: DrawItem[],
    store: Map<number, InstanceData>,
    renderer: WebGL2Renderer,
    camera: OrbitCamera,
    selectedId: number | null,
    visible: boolean,
  ): void {
    if (!visible) {
      this.layer.innerHTML = '';
      this.els.clear();
      return;
    }

    const alive = new Set<number>();
    for (const item of drawList) {
      const inst = store.get(item.id);
      if (!inst) continue;
      alive.add(item.id);
      const projected = renderer.projectLabel(inst.position, camera);
      if (!projected.visible) {
        const old = this.els.get(item.id);
        if (old) old.style.display = 'none';
        continue;
      }

      let el = this.els.get(item.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'inst-label';
        this.layer.appendChild(el);
        this.els.set(item.id, el);
      }
      el.style.display = '';
      el.style.left = `${projected.x}px`;
      el.style.top = `${projected.y - 14}px`;
      el.classList.toggle('selected', item.id === selectedId);
      const [r, g, b] = inst.color.map((c) =>
        Math.round(c * 255).toString(16).padStart(2, '0'),
      );
      el.innerHTML =
        `#${item.id} <span style="opacity:.7">s${item.slot}</span>` +
        ` <span style="color:#${r}${g}${b}">●</span>`;
    }

    for (const [id, el] of this.els) {
      if (!alive.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
  }

  clear(): void {
    this.layer.innerHTML = '';
    this.els.clear();
  }
}
