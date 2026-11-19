import { getNodeDef } from '../core/nodes.ts';
import { nodeName, findNode } from '../core/graph.ts';
import { randomSeed } from '../core/noise.ts';
import type { Edge, NodeInstance, ParamDef, ParamValue, Project, RasterImage } from '../core/types.ts';
import { rasterToCanvas } from './rasterCanvas.ts';

export interface InspectorHost {
  getProject(): Project;
  getSelectedNodeId(): string | null;
  getSelectedEdgeId(): string | null;
  setNodeLabel(id: string, label: string): void;
  setParam(id: string, key: string, value: ParamValue): void;
  setActiveOutput(id: string): void;
  deleteNode(id: string): void;
  duplicateNode(id: string): void;
  deleteEdge(id: string): void;
  getNodeImage(id: string): RasterImage | undefined;
  exportNodePng(id: string): void;
}

function typeLabel(type: 'color' | 'mask'): string {
  return type === 'color' ? '颜色' : '遮罩';
}

function typeChip(type: 'color' | 'mask'): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `type-chip ${type}`;
  chip.textContent = typeLabel(type);
  return chip;
}

export function createInspector(host: InspectorHost): { root: HTMLElement; refresh(): void } {
  const root = document.createElement('div');
  root.className = 'inspector';

  let lastSignature = '';
  let thumbnailSlot: { canvas: HTMLCanvasElement; nodeId: string } | null = null;
  let refresh: () => void = () => {};

  const hasImage = (nodeId: string): boolean => host.getNodeImage(nodeId) !== undefined;

  const updateThumbnail = (): void => {
    if (!thumbnailSlot) return;
    const image = host.getNodeImage(thumbnailSlot.nodeId);
    if (!image) return;
    const ctx = thumbnailSlot.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, thumbnailSlot.canvas.width, thumbnailSlot.canvas.height);
    ctx.drawImage(
      rasterToCanvas(image),
      0,
      0,
      thumbnailSlot.canvas.width,
      thumbnailSlot.canvas.height,
    );
  };

  const renderEmpty = (): void => {
    root.replaceChildren();
    const hint = document.createElement('div');
    hint.className = 'inspector-empty';
    hint.innerHTML =
      '选中一个节点即可编辑参数并查看输入来源。<br />' +
      '拖动画布空白处平移，滚轮缩放；点击连线后按 <kbd>Delete</kbd> 删除。';
    root.append(hint);
  };

  const renderNode = (node: NodeInstance): void => {
    const project = host.getProject();
    const def = getNodeDef(node.type);
    root.replaceChildren();

    const header = document.createElement('div');
    header.className = 'inspector-section';
    const titleRow = document.createElement('div');
    titleRow.className = 'node-title-row';
    const titleInput = document.createElement('input');
    titleInput.className = 'input';
    titleInput.value = node.label;
    titleInput.setAttribute('aria-label', '节点名称');
    titleInput.addEventListener('change', () => {
      const next = titleInput.value.trim() || def.title;
      titleInput.value = next;
      host.setNodeLabel(node.id, next);
    });
    titleRow.append(titleInput);

    const typeRow = document.createElement('div');
    typeRow.className = 'section-label';
    typeRow.textContent = `${def.category} · ${def.title}`;
    const description = document.createElement('p');
    description.className = 'node-description';
    description.textContent = def.description;
    header.append(titleRow, typeRow, description);
    root.append(header);

    // Inputs and their current sources
    if (def.inputs.length > 0) {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = '输入来源';
      section.append(label);
      for (const port of def.inputs) {
        const edge = project.edges.find(
          (candidate) => candidate.to.node === node.id && candidate.to.port === port.key,
        );
        const row = document.createElement('div');
        row.className = 'input-source';
        const main = document.createElement('div');
        main.className = 'input-source-main';
        main.append(typeChip(port.type));
        const name = document.createElement('span');
        if (edge) {
          const source = findNode(project, edge.from.node);
          name.className = 'source-name';
          name.textContent = source ? `${nodeName(source)} · ${edge.from.port}` : '（已断开）';
        } else {
          name.className = 'unconnected';
          name.textContent = '未连接';
        }
        main.append(name);
        row.append(main);
        const portName = document.createElement('span');
        portName.className = 'unconnected';
        portName.textContent = port.label;
        if (edge) {
          const detach = document.createElement('button');
          detach.className = 'btn small';
          detach.textContent = '断开';
          detach.addEventListener('click', () => host.deleteEdge(edge.id));
          row.append(portName, detach);
        } else {
          if (port.required) portName.classList.add('required-mark');
          row.append(portName);
        }
        section.append(row);
      }
      root.append(section);
    }

    // Outputs
    if (def.outputs.length > 0) {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = '输出';
      section.append(label);
      for (const port of def.outputs) {
        const row = document.createElement('div');
        row.className = 'input-source';
        const main = document.createElement('div');
        main.className = 'input-source-main';
        main.append(typeChip(port.type));
        const name = document.createElement('span');
        name.className = 'source-name';
        name.textContent = port.label;
        main.append(name);
        row.append(main);
        const count = project.edges.filter(
          (edge) => edge.from.node === node.id && edge.from.port === port.key,
        ).length;
        const stat = document.createElement('span');
        stat.className = 'unconnected';
        stat.textContent = count > 0 ? `→ ${count} 处连接` : '未使用';
        row.append(stat);
        section.append(row);
      }
      root.append(section);
    }

    // Params
    if (def.params.length > 0) {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = '参数';
      section.append(label);
      for (const param of def.params) {
        if (param.visible && !param.visible(node.params)) continue;
        section.append(renderParam(node.id, param, node.params[param.key]));
      }
      root.append(section);
    }

    if (node.type === 'output') {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const isActive = project.activeOutputId === node.id;
      const button = document.createElement('button');
      button.className = `btn ${isActive ? '' : 'primary'}`;
      button.textContent = isActive ? '当前活动输出' : '设为活动输出';
      button.disabled = isActive;
      button.addEventListener('click', () => host.setActiveOutput(node.id));
      const exportButton = document.createElement('button');
      exportButton.className = 'btn';
      exportButton.textContent = '导出此输出 PNG';
      exportButton.addEventListener('click', () => host.exportNodePng(node.id));
      const actions = document.createElement('div');
      actions.className = 'inspector-actions';
      actions.append(button, exportButton);
      section.append(actions);
      root.append(section);
    }

    // Current result thumbnail (only when the node has produced an image)
    if (host.getNodeImage(node.id)) {
      const section = document.createElement('div');
      section.className = 'inspector-section';
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = '当前结果';
      const preview = document.createElement('canvas');
      preview.width = 320;
      preview.height = 320;
      preview.style.width = '100%';
      preview.style.borderRadius = '8px';
      preview.style.border = '1px solid var(--line)';
      section.append(label, preview);
      root.append(section);
      thumbnailSlot = { canvas: preview, nodeId: node.id };
    } else {
      thumbnailSlot = null;
    }

    const actions = document.createElement('div');
    actions.className = 'inspector-actions';
    const duplicate = document.createElement('button');
    duplicate.className = 'btn small';
    duplicate.textContent = '复制节点';
    duplicate.addEventListener('click', () => host.duplicateNode(node.id));
    const remove = document.createElement('button');
    remove.className = 'btn small danger';
    remove.textContent = '删除节点';
    remove.addEventListener('click', () => host.deleteNode(node.id));
    actions.append(duplicate, remove);
    root.append(actions);
  };

  const renderParam = (nodeId: string, param: ParamDef, value: ParamValue | undefined): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'param';
    const labelRow = document.createElement('div');
    labelRow.className = 'param-label-row';
    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = param.label;
    const valueText = document.createElement('span');
    valueText.className = 'param-value';
    labelRow.append(label, valueText);

    if (param.kind === 'seed') {
      // Seeds span a huge range; a slider would be useless. Use a number input
      // plus a dice button that produces a new fixed seed.
      const current = typeof value === 'number' ? Math.round(value) : Number(param.default);
      valueText.textContent = String(current);
      const control = document.createElement('div');
      control.className = 'param-control';
      const numberInput = document.createElement('input');
      numberInput.type = 'number';
      numberInput.min = '0';
      numberInput.max = String(param.max ?? 2147483646);
      numberInput.step = '1';
      numberInput.value = String(current);
      const commit = (next: number): void => {
        if (!Number.isFinite(next)) return;
        const normalized = Math.max(0, Math.min(param.max ?? 2147483646, Math.round(next)));
        host.setParam(nodeId, param.key, normalized);
        numberInput.value = String(normalized);
        valueText.textContent = String(normalized);
      };
      numberInput.addEventListener('change', () => commit(Number(numberInput.value)));
      const dice = document.createElement('button');
      dice.className = 'btn small';
      dice.textContent = '随机';
      dice.title = '生成一个新的固定种子';
      dice.addEventListener('click', () => commit(randomSeed() % 1000000000));
      control.append(numberInput, dice);
      wrap.append(labelRow, control);
      if (param.help) {
        const help = document.createElement('div');
        help.className = 'param-help';
        help.textContent = param.help;
        wrap.append(help);
      }
      return wrap;
    }

    if (param.kind === 'number') {
      const current = typeof value === 'number' ? value : Number(param.default);
      valueText.textContent = formatNumber(current);
      const control = document.createElement('div');
      control.className = 'param-control';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(param.min ?? 0);
      slider.max = String(param.max ?? 100);
      slider.step = String(param.step ?? 1);
      slider.value = String(current);
      const numberInput = document.createElement('input');
      numberInput.type = 'number';
      numberInput.min = String(param.min ?? 0);
      numberInput.max = String(param.max ?? 100);
      numberInput.step = String(param.step ?? 1);
      numberInput.value = String(current);
      const commit = (next: number): void => {
        if (!Number.isFinite(next)) return;
        const clamped = Math.min(
          param.max ?? Number.POSITIVE_INFINITY,
          Math.max(param.min ?? Number.NEGATIVE_INFINITY, next),
        );
        host.setParam(nodeId, param.key, clamped);
        // Update in place instead of rebuilding the panel, otherwise an
        // in-progress slider drag would lose its DOM node.
        slider.value = String(clamped);
        numberInput.value = String(clamped);
        valueText.textContent = formatNumber(clamped);
      };
      slider.addEventListener('input', () => commit(Number(slider.value)));
      numberInput.addEventListener('change', () => commit(Number(numberInput.value)));
      control.append(slider, numberInput);
      wrap.append(labelRow, control);
      if (param.help) {
        const help = document.createElement('div');
        help.className = 'param-help';
        help.textContent = param.help;
        wrap.append(help);
      }
      return wrap;
    }

    if (param.kind === 'color') {
      const current = typeof value === 'string' ? value : String(param.default);
      valueText.textContent = current;
      const control = document.createElement('div');
      control.className = 'param-control';
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = current;
      const text = document.createElement('input');
      text.type = 'text';
      text.value = current;
      const commit = (next: string): void => {
        if (!/^#[0-9a-fA-F]{6}$/.test(next)) {
          const stored = host
            .getProject()
            .nodes.find((candidate) => candidate.id === nodeId)?.params[param.key];
          text.value = typeof stored === 'string' ? stored : current;
          return;
        }
        const normalized = next.toLowerCase();
        host.setParam(nodeId, param.key, normalized);
        picker.value = normalized;
        text.value = normalized;
        valueText.textContent = normalized;
      };
      picker.addEventListener('input', () => commit(picker.value));
      text.addEventListener('change', () => commit(text.value.trim()));
      control.append(picker, text);
      wrap.append(labelRow, control);
      return wrap;
    }

    if (param.kind === 'select') {
      const current = typeof value === 'string' ? value : String(param.default);
      const select = document.createElement('select');
      select.className = 'select';
      for (const option of param.options ?? []) {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label;
        select.append(item);
      }
      select.value = current;
      select.addEventListener('change', () => {
        host.setParam(nodeId, param.key, select.value);
        lastSignature = '';
        refresh();
      });
      valueText.textContent = '';
      const control = document.createElement('div');
      control.className = 'param-control';
      control.append(select);
      wrap.append(labelRow, control);
      if (param.help) {
        const help = document.createElement('div');
        help.className = 'param-help';
        help.textContent = param.help;
        wrap.append(help);
      }
      return wrap;
    }

    // boolean
    const current = value === true;
    const control = document.createElement('div');
    control.className = 'param-control';
    const row = document.createElement('label');
    row.className = 'checkbox-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = current;
    box.addEventListener('change', () => {
      host.setParam(nodeId, param.key, box.checked);
      lastSignature = '';
      refresh();
    });
    const text = document.createElement('span');
    text.textContent = param.label;
    row.append(box, text);
    control.append(row);
    wrap.append(control);
    if (param.help) {
      const help = document.createElement('div');
      help.className = 'param-help';
      help.textContent = param.help;
      wrap.append(help);
    }
    return wrap;
  };

  const renderEdge = (edge: Edge): void => {
    const project = host.getProject();
    root.replaceChildren();
    const section = document.createElement('div');
    section.className = 'inspector-section';
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = '连线';
    const summary = document.createElement('div');
    summary.className = 'edge-summary';
    const source = findNode(project, edge.from.node);
    const target = findNode(project, edge.to.node);
    const from = document.createElement('div');
    from.className = 'from';
    from.textContent = `从：${source ? nodeName(source) : '?'} · ${edge.from.port}`;
    const arrow = document.createElement('div');
    arrow.textContent = '↓';
    const to = document.createElement('div');
    to.className = 'to';
    to.textContent = `到：${target ? nodeName(target) : '?'} · ${edge.to.port}`;
    summary.append(from, arrow, to);
    const actions = document.createElement('div');
    actions.className = 'inspector-actions';
    const remove = document.createElement('button');
    remove.className = 'btn small danger';
    remove.textContent = '删除连线';
    remove.addEventListener('click', () => host.deleteEdge(edge.id));
    actions.append(remove);
    section.append(label, summary, actions);
    root.append(section);
  };

  /**
   * Signature of the structural parts of the panel. Param values are left out
   * on purpose: the controls update themselves, and rebuilding mid-drag would
   * drop the slider the user is holding.
   */
  const panelSignature = (): string => {
    const nodeId = host.getSelectedNodeId();
    const edgeId = host.getSelectedEdgeId();
    if (edgeId) return `edge:${edgeId}`;
    if (!nodeId) return 'none';
    const project = host.getProject();
    const node = findNode(project, nodeId);
    if (!node) return 'none';
    const edges = project.edges
      .filter((edge) => edge.to.node === nodeId)
      .map((edge) => `${edge.id}>${edge.from.node}.${edge.from.port}:${edge.to.port}`)
      .join(',');
    const outputs = project.edges.filter((edge) => edge.from.node === nodeId).length;
    const def = getNodeDef(node.type);
    // Which params are currently visible changes with select/boolean values.
    const visibleKeys = def.params
      .filter((param) => !param.visible || param.visible(node.params))
      .map((param) => param.key)
      .join(',');
    return [
      nodeId,
      node.label,
      edges,
      outputs,
      project.activeOutputId === nodeId,
      hasImage(nodeId),
      visibleKeys,
    ].join('|');
  };

  refresh = (): void => {
    const signature = panelSignature();
    // Skip rebuilding while identical: slider drags update their own DOM and
    // would otherwise lose focus on every evaluated frame.
    if (signature === lastSignature) {
      updateThumbnail();
      return;
    }
    lastSignature = signature;

    const edgeId = host.getSelectedEdgeId();
    if (edgeId) {
      const edge = host.getProject().edges.find((candidate) => candidate.id === edgeId);
      if (edge) {
        thumbnailSlot = null;
        renderEdge(edge);
        return;
      }
    }
    const nodeId = host.getSelectedNodeId();
    if (nodeId) {
      const node = host.getProject().nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        renderNode(node);
        updateThumbnail();
        return;
      }
    }
    thumbnailSlot = null;
    renderEmpty();
  };

  return { root, refresh };
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
