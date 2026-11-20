import type { SceneDocument } from '../core/document';
import type { History } from '../core/history';
import { ReparentCommand } from '../core/history';

interface DragTarget {
  nodeId: string | null;
  position: 'inside' | 'before' | 'after';
}

/**
 * 场景树面板：展示层级、选择、可见性切换，以及拖拽调整父子关系/排序。
 *
 * 拖拽落点三种语义：
 * - inside：作为目标节点的最后一个子节点
 * - before / after：作为目标节点的兄弟，插到其前/后
 * 循环父子由文档层拒绝，这里捕获错误并通过状态条说明原因。
 */
export class TreePanel {
  private root: HTMLElement;
  private dragTarget: DragTarget | null = null;
  private draggedId: string | null = null;

  constructor(
    container: HTMLElement,
    private doc: SceneDocument,
    private history: History,
    private onStatus: (message: string, kind?: 'info' | 'error') => void,
  ) {
    this.root = container;
    this.bindRootDropZone();
    this.doc.subscribe((change) => {
      if (change.type === 'structure' || change.type === 'load' || change.type === 'selection') {
        this.render();
      } else if (change.type === 'visibility' || change.type === 'rename') {
        this.render();
      }
    });
    this.render();
  }

  render(): void {
    this.root.innerHTML = '';
    const ul = this.buildLevel(null, 0);
    if (ul) this.root.appendChild(ul);

    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = this.doc.getAllNodes().length === 0 ? '（空场景，可从检查器旁的菜单新建对象）' : '';
    if (empty.textContent) this.root.appendChild(empty);
  }

  private buildLevel(parentId: string | null, depth: number): HTMLUListElement | null {
    const ids = this.doc.getChildren(parentId);
    if (ids.length === 0) return null;
    const ul = document.createElement('ul');
    ul.className = 'tree-list';

    for (const id of ids) {
      const node = this.doc.getNode(id);
      if (!node) continue;
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.nodeId = id;
      li.classList.toggle('selected', this.doc.selection === id);
      li.style.setProperty('--depth', String(depth));

      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = `${8 + depth * 16}px`;

      const hasChildren = this.doc.getChildren(id).length > 0;
      const typeIcon = document.createElement('span');
      typeIcon.className = 'tree-icon';
      typeIcon.textContent = hasChildren ? '🗂' : node.geometry ? '🧊' : '📦';
      row.appendChild(typeIcon);

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      if (!node.visible) label.classList.add('dimmed');
      label.title = '单击选择；双击重命名';
      row.appendChild(label);

      const visBtn = document.createElement('button');
      visBtn.className = 'tree-visibility';
      visBtn.textContent = node.visible ? '👁' : '🚫';
      visBtn.title = node.visible ? '隐藏（不参与点选）' : '显示';
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.doc.setVisible(id, !node.visible);
      });
      row.appendChild(visBtn);

      li.appendChild(row);

      li.addEventListener('click', () => this.doc.select(id));
      label.addEventListener('dblclick', () => this.renameInline(id, label));

      this.attachDragEvents(li, id);

      ul.appendChild(li);
      const childUl = this.buildLevel(id, depth + 1);
      if (childUl) ul.appendChild(childUl);
    }
    return ul;
  }

  private renameInline(id: string, label: HTMLElement): void {
    const node = this.doc.getNode(id);
    if (!node) return;
    const input = document.createElement('input');
    input.value = node.name;
    input.className = 'tree-rename-input';
    label.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => {
      const name = input.value.trim();
      if (name && name !== node.name) this.doc.setName(id, name);
      this.render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') this.render();
    });
  }

  // ---------- 拖拽 ----------

  private attachDragEvents(li: HTMLElement, id: string): void {
    li.addEventListener('dragstart', (e) => {
      this.draggedId = id;
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      this.clearDropMarkers();
      this.draggedId = null;
      this.dragTarget = null;
    });

    li.addEventListener('dragover', (e) => {
      if (!this.draggedId) return;
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到根容器，避免落点被根处理器抢先判定
      e.dataTransfer!.dropEffect = 'move';
      const target = this.computeDropTarget(e, li, id);
      this.dragTarget = target;
      this.paintDropMarker(target);
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.draggedId || !this.dragTarget) return;
      this.executeDrop(this.draggedId, this.dragTarget);
      this.clearDropMarkers();
    });
  }

  /** 根空白区域的拖放监听只注册一次（构造时调用） */
  bindRootDropZone(): void {
    this.root.addEventListener('dragover', (e) => {
      if (!this.draggedId) return;
      // 只有事件目标确实是根容器本身（空白处）才算挂到根
      if (e.target !== this.root) return;
      e.preventDefault();
      this.dragTarget = { nodeId: null, position: 'inside' };
      this.paintDropMarker(this.dragTarget);
    });
    this.root.addEventListener('drop', (e) => {
      if (!this.draggedId || e.target !== this.root) return;
      e.preventDefault();
      this.executeDrop(this.draggedId, { nodeId: null, position: 'inside' });
    });
  }

  private computeDropTarget(
    e: DragEvent,
    li: HTMLElement,
    targetId: string,
  ): DragTarget {
    const rect = li.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < rect.height * 0.25) return { nodeId: targetId, position: 'before' };
    if (y > rect.height * 0.75) return { nodeId: targetId, position: 'after' };
    return { nodeId: targetId, position: 'inside' };
  }

  private paintDropMarker(target: DragTarget): void {
    this.clearDropMarkers();
    if (target.nodeId === null) {
      this.root.classList.add('drop-root');
      return;
    }
    const li = this.root.querySelector(`li[data-node-id="${cssEscape(target.nodeId)}"]`);
    li?.classList.add(`drop-${target.position}`);
  }

  private clearDropMarkers(): void {
    this.root.classList.remove('drop-root');
    this.root
      .querySelectorAll('.drop-inside,.drop-before,.drop-after')
      .forEach((el) => el.classList.remove('drop-inside', 'drop-before', 'drop-after'));
  }

  private executeDrop(draggedId: string, target: DragTarget): void {
    if (target.nodeId === draggedId && target.position === 'inside') {
      this.onStatus('拖放目标与源对象相同，已忽略', 'info');
      return;
    }
    try {
      if (target.position === 'inside') {
        this.history.execute(
          new ReparentCommand(this.doc, '调整层级', draggedId, target.nodeId, null, true),
        );
        this.onStatus(`已将「${this.doc.getNode(draggedId)?.name}」挂到新父级，世界变换尽量保持`);
        return;
      }
      // before/after：先挂到目标的父级，再排序
      const targetNode = this.doc.getNode(target.nodeId!);
      if (!targetNode) return;
      const siblings = this.doc.getChildren(targetNode.parentId);
      const targetIndex = siblings.indexOf(target.nodeId!);
      const insertIndex = target.position === 'before' ? targetIndex : targetIndex + 1;
      this.history.execute(
        new ReparentCommand(
          this.doc,
          '调整排序',
          draggedId,
          targetNode.parentId,
          insertIndex,
          true,
        ),
      );
      this.onStatus('层级顺序已更新');
    } catch (err) {
      this.onStatus((err as Error).message, 'error');
    }
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
