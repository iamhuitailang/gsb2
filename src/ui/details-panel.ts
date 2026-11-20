// 选中项信息：节点类型、包围范围、顶点数、面数、材质分布与覆盖状态

import { bbox, type BBox } from '../core/math';
import type { SceneModel, SceneNode } from '../core/types';
import { clear, formatNumber, h } from './dom';

function row(label: string, value: string): HTMLElement {
  return h('div', { className: 'detail-row' },
    h('span', { className: 'detail-label', textContent: label }),
    h('span', { className: 'detail-value', textContent: value }),
  );
}

function bboxBlock(box: BBox): HTMLElement {
  if (bbox.isEmpty(box)) {
    return h('div', { className: 'detail-section', textContent: '该节点没有有效几何数据' });
  }
  const center = bbox.center(box);
  const size = bbox.size(box);
  return h('div', { className: 'detail-section' },
    h('h3', { textContent: '包围范围' }),
    row('min', `(${formatNumber(box.min[0])}, ${formatNumber(box.min[1])}, ${formatNumber(box.min[2])})`),
    row('max', `(${formatNumber(box.max[0])}, ${formatNumber(box.max[1])}, ${formatNumber(box.max[2])})`),
    row('中心', `(${formatNumber(center[0])}, ${formatNumber(center[1])}, ${formatNumber(center[2])})`),
    row('尺寸', `(${formatNumber(size[0])} × ${formatNumber(size[1])} × ${formatNumber(size[2])})`),
  );
}

export class DetailsPanel {
  constructor(private container: HTMLElement) {}

  update(model: SceneModel | null, node: SceneNode | null): void {
    clear(this.container);
    if (!model || !node) {
      this.container.append(
        h('div', { className: 'empty-hint', textContent: '在左侧结构树中选择一个对象或组查看详情。' }),
      );
      return;
    }

    const materialNames = [...new Set(
      node.submeshes.map((s) => s.materialName).filter((n): n is string => n !== null),
    )];

    this.container.append(
      h('div', { className: 'detail-section' },
        h('h3', { textContent: '基本信息' }),
        row('节点 ID', node.id),
        row('类型', node.kind === 'object' ? '对象 (o)' : '组 (g)'),
        row('原始名称', node.rawName ?? '(未命名)'),
        row('展示名称', node.label),
        row('可见性', node.hidden ? '已隐藏' : '可见'),
        row('颜色覆盖', node.colorOverride ?? '无（使用材质本色）'),
      ),
      bboxBlock(node.bbox),
      h('div', { className: 'detail-section' },
        h('h3', { textContent: '几何统计' }),
        row('顶点数', node.vertexCount.toLocaleString()),
        row('三角面数', node.faceCount.toLocaleString()),
        row('子节点数', String(node.children.length)),
      ),
      h('div', { className: 'detail-section' },
        h('h3', { textContent: '材质分布' }),
        materialNames.length === 0
          ? h('div', { className: 'empty-hint', textContent: node.kind === 'object' ? '（对象级汇总，展开查看各分组材质）' : '无材质引用' })
          : h('ul', { className: 'material-refs' },
              ...materialNames.map((name) =>
                h('li', { textContent: model.materials.get(name) ? name : `${name}（缺失，已用默认材质）` }),
              ),
            ),
      ),
    );
  }
}
