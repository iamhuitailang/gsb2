// 模型结构树：对象/组两级，稳定 ID 驱动选择，重名展示名已在构建阶段消歧

import type { SceneNode } from '../core/types';
import { clear, h } from './dom';

export interface TreeCallbacks {
  onSelect: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onFocus: (id: string) => void;
  onPickColor: (id: string, color: string) => void;
  onClearColor: (id: string) => void;
}

export class TreeView {
  private selectedId: string | null = null;
  private expanded = new Set<string>(['root']);
  private currentRoot: SceneNode | null = null;

  constructor(
    private container: HTMLElement,
    private callbacks: TreeCallbacks,
  ) {}

  update(root: SceneNode): void {
    this.currentRoot = root;
    this.render(root);
    this.syncSelection();
  }

  private render(root: SceneNode): void {
    clear(this.container);
    this.container.append(this.renderNode(root, 0));
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    if (id) this.expandTo(id);
    this.syncSelection();
  }

  private expandTo(id: string): void {
    // id 形如 o:0/g:1，逐级展开
    const parts = id.split('/');
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      this.expanded.add(acc);
    }
    this.expanded.add('root');
  }

  private syncSelection(): void {
    this.container.querySelectorAll('.tree-row').forEach((row) => {
      row.classList.toggle('selected', row.getAttribute('data-id') === this.selectedId);
    });
    this.container.querySelectorAll('.tree-row').forEach((row) => {
      row.classList.toggle(
        'hidden-node',
        row.getAttribute('data-hidden') === 'true',
      );
    });
  }

  private renderNode(node: SceneNode, depth: number): HTMLElement {
    const hasChildren = node.children.length > 0;
    const isExpanded = this.expanded.has(node.id);
    const isGroup = node.kind === 'group';
    const caret = h(
      'span',
      {
        className: `tree-caret ${hasChildren ? '' : 'tree-caret-empty'}`,
        textContent: hasChildren ? (isExpanded ? '▾' : '▸') : '',
      },
    );
    if (hasChildren) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.expanded.has(node.id)) this.expanded.delete(node.id);
        else this.expanded.add(node.id);
        if (this.currentRoot) this.update(this.currentRoot);
        this.setSelected(this.selectedId);
      });
    }

    const icon = h('span', {
      className: `tree-icon ${isGroup ? 'icon-group' : 'icon-object'}`,
      textContent: isGroup ? '▦' : '◆',
    });

    const label = h('span', { className: 'tree-label', textContent: node.label });
    const meta = h('span', {
      className: 'tree-meta',
      textContent: `${node.faceCount} 面`,
    });

    const hiddenBtn = h('button', {
      className: 'tree-btn',
      title: node.hidden ? '显示该节点' : '隐藏该节点',
      textContent: node.hidden ? '🚫' : '👁',
    });
    hiddenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onToggleHidden(node.id);
    });

    const focusBtn = h('button', {
      className: 'tree-btn',
      title: '聚焦（镜头适配该节点包围范围）',
      textContent: '🎯',
    });
    focusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onFocus(node.id);
    });

    // 颜色覆盖：color input + 清除按钮
    const colorInput = h('input', {
      className: 'tree-color',
      type: 'color',
      value: node.colorOverride ?? '#cccccc',
      title: '修改显示颜色（仅影响查看器显示）',
    }) as HTMLInputElement;
    colorInput.addEventListener('click', (e) => e.stopPropagation());
    colorInput.addEventListener('input', (e) => {
      this.callbacks.onPickColor(node.id, (e.target as HTMLInputElement).value);
    });

    const clearColorBtn = h('button', {
      className: `tree-btn ${node.colorOverride ? '' : 'tree-btn-disabled'}`,
      title: '清除颜色覆盖，恢复材质本色',
      textContent: '↺',
    });
    clearColorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onClearColor(node.id);
    });

    const actions = h('span', { className: 'tree-actions' },
      hiddenBtn, focusBtn, colorInput, clearColorBtn);

    const row = h('div', {
      className: 'tree-row',
      'data-id': node.id,
      'data-hidden': node.hidden,
    }, caret, icon, label, meta, actions);
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.addEventListener('click', () => this.callbacks.onSelect(node.id));

    const wrap = h('div', { className: 'tree-node' }, row);
    if (hasChildren && isExpanded) {
      const childWrap = h('div', { className: 'tree-children' });
      for (const child of node.children) childWrap.append(this.renderNode(child, depth + 1));
      wrap.append(childWrap);
    }
    return wrap;
  }
}
