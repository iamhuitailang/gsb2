import { getNodeDef } from '../core/nodes.ts';
import { nodeName, type EvaluateResult } from '../core/graph.ts';
import type {
  ConnectionResult,
  Edge,
  NodeInstance,
  PortRef,
  PortType,
  Project,
  RasterImage,
  ViewState,
} from '../core/types.ts';
import { rasterToCanvas } from './rasterCanvas.ts';

const NODE_WIDTH = 210;
const HEADER_HEIGHT = 32;
const PORT_AREA_TOP = 10;
const PORT_ROW = 24;
const THUMB_SIZE = 54;
const BOTTOM_PAD = 12;
const GRID = 28;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

const TYPE_LABEL: Record<PortType, string> = { color: '颜色', mask: '遮罩' };
const TYPE_COLOR: Record<PortType, string> = { color: '#6ea8ff', mask: '#f0b64d' };

const CATEGORY_COLOR: Record<string, string> = {
  生成器: '#6ea8ff',
  处理: '#f0b64d',
  合成: '#d78cff',
  输出: '#4ed8a0',
};

interface PortLayout {
  key: string;
  label: string;
  type: PortType;
  x: number;
  y: number;
  direction: 'in' | 'out';
}

interface NodeLayout {
  node: NodeInstance;
  x: number;
  y: number;
  width: number;
  height: number;
  ports: PortLayout[];
  rows: number;
}

export type LinkEnd = { ref: PortRef; type: PortType; direction: 'in' | 'out' };

export interface GraphHost {
  getProject(): Project;
  getEvaluation(): EvaluateResult;
  getSelectedNodeId(): string | null;
  getSelectedEdgeId(): string | null;
  selectNode(id: string | null): void;
  selectEdge(id: string | null): void;
  moveNode(id: string, x: number, y: number): void;
  commitMove(): void;
  viewChanged(view: ViewState): void;
  connect(from: PortRef, to: PortRef): ConnectionResult;
  toast(message: string, kind?: 'info' | 'error' | 'success'): void;
}

interface DragState {
  kind: 'pan' | 'node' | 'link';
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  startViewX: number;
  startViewY: number;
  nodeId?: string;
  nodeStartX?: number;
  nodeStartY?: number;
  grabX?: number;
  grabY?: number;
  link?: LinkEnd;
  cursorX: number;
  cursorY: number;
  moved: boolean;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function bezierPoints(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  samples = 20,
): Array<[number, number]> {
  const dx = Math.max(48, Math.abs(toX - fromX) * 0.5);
  const c1x = fromX + dx;
  const c1y = fromY;
  const c2x = toX - dx;
  const c2y = toY;
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const mt = 1 - t;
    const x =
      mt * mt * mt * fromX +
      3 * mt * mt * t * c1x +
      3 * mt * t * t * c2x +
      t * t * t * toX;
    const y =
      mt * mt * mt * fromY +
      3 * mt * mt * t * c1y +
      3 * mt * t * t * c2y +
      t * t * t * toY;
    points.push([x, y]);
  }
  return points;
}

export class GraphCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: GraphHost;
  private readonly thumbnails = new Map<
    string,
    { source: RasterImage; canvas: HTMLCanvasElement }
  >();
  private layouts: NodeLayout[] = [];
  private drag: DragState | null = null;
  private hoverPort: LinkEnd | null = null;
  private queued = false;

  constructor(canvas: HTMLCanvasElement, host: GraphHost) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
    this.host = host;

    new ResizeObserver(() => this.requestRender()).observe(canvas);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  requestRender(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  getView(): ViewState {
    return this.host.getProject().view;
  }

  zoomBy(factor: number, origin?: { x: number; y: number }): void {
    const project = this.host.getProject();
    const view = project.view;
    const center = origin ?? {
      x: this.canvas.clientWidth / 2,
      y: this.canvas.clientHeight / 2,
    };
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
    if (nextZoom === view.zoom) return;
    const worldX = (center.x - view.x) / view.zoom;
    const worldY = (center.y - view.y) / view.zoom;
    view.zoom = nextZoom;
    view.x = center.x - worldX * nextZoom;
    view.y = center.y - worldY * nextZoom;
    this.host.viewChanged(view);
    this.requestRender();
  }

  fitView(): void {
    const project = this.host.getProject();
    if (project.nodes.length === 0) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of project.nodes) {
      const layout = this.layoutOf(node);
      minX = Math.min(minX, layout.x);
      minY = Math.min(minY, layout.y);
      maxX = Math.max(maxX, layout.x + layout.width);
      maxY = Math.max(maxY, layout.y + layout.height);
    }
    const padding = 60;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.min((width - padding * 2) / contentW, (height - padding * 2) / contentH)),
    );
    project.view.zoom = zoom;
    project.view.x = (width - contentW * zoom) / 2 - minX * zoom;
    project.view.y = (height - contentH * zoom) / 2 - minY * zoom;
    this.host.viewChanged(project.view);
    this.requestRender();
  }

  private layoutOf(node: NodeInstance): NodeLayout {
    const def = getNodeDef(node.type);
    const rows = Math.max(def.inputs.length, def.outputs.length, 1);
    const height = HEADER_HEIGHT + PORT_AREA_TOP + rows * PORT_ROW + THUMB_SIZE + BOTTOM_PAD + 6;
    const ports: PortLayout[] = [];
    def.inputs.forEach((port, index) => {
      ports.push({
        key: port.key,
        label: port.label,
        type: port.type,
        x: node.x,
        y: node.y + HEADER_HEIGHT + PORT_AREA_TOP + index * PORT_ROW + PORT_ROW / 2,
        direction: 'in',
      });
    });
    def.outputs.forEach((port, index) => {
      ports.push({
        key: port.key,
        label: port.label,
        type: port.type,
        x: node.x + NODE_WIDTH,
        y: node.y + HEADER_HEIGHT + PORT_AREA_TOP + index * PORT_ROW + PORT_ROW / 2,
        direction: 'out',
      });
    });
    return { node, x: node.x, y: node.y, width: NODE_WIDTH, height, ports, rows };
  }

  private screenToWorld(x: number, y: number): { x: number; y: number } {
    const view = this.host.getProject().view;
    return { x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom };
  }

  private eventscreen(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private ensureLayouts(): void {
    const nodes = this.host.getProject().nodes;
    const stale =
      this.layouts.length !== nodes.length ||
      this.layouts.some((layout, index) => {
        const node = nodes[index];
        return (
          !node ||
          layout.node !== node ||
          layout.x !== node.x ||
          layout.y !== node.y
        );
      });
    if (stale) {
      this.layouts = nodes.map((node) => this.layoutOf(node));
    }
  }

  private hitPort(worldX: number, worldY: number): PortLayout | null {
    this.ensureLayouts();
    const tolerance = Math.max(9, 11 / this.getView().zoom);
    for (const layout of this.layouts) {
      for (const port of layout.ports) {
        if (Math.hypot(worldX - port.x, worldY - port.y) <= tolerance) {
          return port;
        }
      }
    }
    return null;
  }

  private hitNode(worldX: number, worldY: number): NodeLayout | null {
    this.ensureLayouts();
    for (let i = this.layouts.length - 1; i >= 0; i -= 1) {
      const layout = this.layouts[i]!;
      if (
        worldX >= layout.x &&
        worldX <= layout.x + layout.width &&
        worldY >= layout.y &&
        worldY <= layout.y + layout.height
      ) {
        return layout;
      }
    }
    return null;
  }

  private edgePath(edge: Edge): { points: Array<[number, number]> } | null {
    const fromLayout = this.layouts.find((layout) => layout.node.id === edge.from.node);
    const toLayout = this.layouts.find((layout) => layout.node.id === edge.to.node);
    if (!fromLayout || !toLayout) return null;
    const fromPort = fromLayout.ports.find(
      (port) => port.direction === 'out' && port.key === edge.from.port,
    );
    const toPort = toLayout.ports.find(
      (port) => port.direction === 'in' && port.key === edge.to.port,
    );
    if (!fromPort || !toPort) return null;
    return { points: bezierPoints(fromPort.x, fromPort.y, toPort.x, toPort.y) };
  }

  private hitEdge(worldX: number, worldY: number): Edge | null {
    this.ensureLayouts();
    const project = this.host.getProject();
    const tolerance = Math.max(5, 7 / this.getView().zoom);
    for (const edge of project.edges) {
      const path = this.edgePath(edge);
      if (!path) continue;
      for (let i = 0; i < path.points.length - 1; i += 1) {
        const a = path.points[i]!;
        const b = path.points[i + 1]!;
        if (distanceToSegment(worldX, worldY, a[0], a[1], b[0], b[1]) <= tolerance) {
          return edge;
        }
      }
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) {
      event.preventDefault();
      return;
    }
    if (event.button === 1) event.preventDefault();
    const screen = this.eventscreen(event);
    const world = this.screenToWorld(screen.x, screen.y);
    this.canvas.setPointerCapture(event.pointerId);

    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      this.beginPan(event.pointerId, screen);
      return;
    }
    if (event.button !== 0) return;

    const port = this.hitPort(world.x, world.y);
    if (port) {
      this.host.selectNode(this.nodeIdAtPort(port));
      this.drag = {
        kind: 'link',
        pointerId: event.pointerId,
        startScreenX: screen.x,
        startScreenY: screen.y,
        startViewX: this.getView().x,
        startViewY: this.getView().y,
        link: {
          ref: { node: this.nodeIdAtPort(port), port: port.key },
          type: port.type,
          direction: port.direction,
        },
        cursorX: world.x,
        cursorY: world.y,
        moved: false,
      };
      this.requestRender();
      return;
    }

    const nodeLayout = this.hitNode(world.x, world.y);
    if (nodeLayout) {
      this.host.selectNode(nodeLayout.node.id);
      this.drag = {
        kind: 'node',
        pointerId: event.pointerId,
        startScreenX: screen.x,
        startScreenY: screen.y,
        startViewX: this.getView().x,
        startViewY: this.getView().y,
        nodeId: nodeLayout.node.id,
        nodeStartX: nodeLayout.node.x,
        nodeStartY: nodeLayout.node.y,
        grabX: world.x,
        grabY: world.y,
        cursorX: world.x,
        cursorY: world.y,
        moved: false,
      };
      this.requestRender();
      return;
    }

    const edge = this.hitEdge(world.x, world.y);
    if (edge) {
      this.host.selectEdge(edge.id);
      return;
    }

    this.host.selectNode(null);
    this.host.selectEdge(null);
    this.beginPan(event.pointerId, screen);
  };

  private beginPan(pointerId: number, screen: { x: number; y: number }): void {
    const view = this.getView();
    this.drag = {
      kind: 'pan',
      pointerId,
      startScreenX: screen.x,
      startScreenY: screen.y,
      startViewX: view.x,
      startViewY: view.y,
      cursorX: screen.x,
      cursorY: screen.y,
      moved: false,
    };
  }

  private nodeIdAtPort(port: PortLayout): string {
    for (const layout of this.layouts) {
      if (layout.ports.includes(port)) return layout.node.id;
    }
    return '';
  }

  private onPointerMove = (event: PointerEvent): void => {
    const screen = this.eventscreen(event);
    const world = this.screenToWorld(screen.x, screen.y);

    if (!this.drag) {
      const port = this.hitPort(world.x, world.y);
      const nextHover = port
        ? {
            ref: { node: this.nodeIdAtPort(port), port: port.key },
            type: port.type,
            direction: port.direction,
          }
        : null;
      if (JSON.stringify(nextHover) !== JSON.stringify(this.hoverPort)) {
        this.hoverPort = nextHover;
        this.canvas.style.cursor = port ? 'crosshair' : 'default';
        this.requestRender();
      }
      return;
    }

    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'pan') {
      const view = this.getView();
      view.x = drag.startViewX + (screen.x - drag.startScreenX);
      view.y = drag.startViewY + (screen.y - drag.startScreenY);
      drag.moved = true;
      this.host.viewChanged(view);
      this.requestRender();
      return;
    }

    if (drag.kind === 'node' && drag.nodeId !== undefined) {
      const node = this.host.getProject().nodes.find((candidate) => candidate.id === drag.nodeId);
      if (!node) return;
      const nextX = Math.round((drag.nodeStartX ?? 0) + (world.x - (drag.grabX ?? 0)));
      const nextY = Math.round((drag.nodeStartY ?? 0) + (world.y - (drag.grabY ?? 0)));
      if (nextX !== node.x || nextY !== node.y) {
        this.host.moveNode(node.id, nextX, nextY);
        drag.moved = true;
        this.requestRender();
      }
      return;
    }

    if (drag.kind === 'link') {
      drag.cursorX = world.x;
      drag.cursorY = world.y;
      const port = this.hitPort(world.x, world.y);
      const link = drag.link;
      if (port && link) {
        const expected: 'in' | 'out' = link.direction === 'out' ? 'in' : 'out';
        if (port.direction === expected) {
          this.hoverPort = {
            ref: { node: this.nodeIdAtPort(port), port: port.key },
            type: port.type,
            direction: port.direction,
          };
        } else {
          this.hoverPort = null;
        }
      } else {
        this.hoverPort = null;
      }
      this.requestRender();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (!this.drag) {
      this.requestRender();
      return;
    }
    const drag = this.drag;
    this.drag = null;

    if (drag.kind === 'node' && drag.moved) {
      this.host.commitMove();
    } else if (drag.kind === 'pan' && drag.moved) {
      this.host.viewChanged(this.getView());
    } else if (drag.kind === 'link') {
      const link = drag.link;
      if (!link) {
        this.hoverPort = null;
        this.requestRender();
        return;
      }
      const screen = this.eventscreen(event);
      const world = this.screenToWorld(screen.x, screen.y);
      const port = this.hitPort(world.x, world.y);
      if (port) {
        const origin = link.ref;
        const originNode = this.nodeIdAtPort(port);
        // Releasing on the port the drag started from is a no-op, not an error.
        if (originNode === origin.node && port.key === origin.port && port.direction === link.direction) {
          this.hoverPort = null;
          this.canvas.style.cursor = 'default';
          this.requestRender();
          return;
        }
        const expected: 'in' | 'out' = link.direction === 'out' ? 'in' : 'out';
        if (port.direction !== expected) {
          this.host.toast('连线方向不对：输出端口需要连接到输入端口', 'error');
        } else {
          const from = link.direction === 'out'
            ? link.ref
            : { node: this.nodeIdAtPort(port), port: port.key };
          const to = link.direction === 'out'
            ? { node: this.nodeIdAtPort(port), port: port.key }
            : link.ref;
          const result = this.host.connect(from, to);
          if (!result.ok) {
            this.host.toast(result.reason ?? '无法连接', 'error');
          }
        }
      }
    }
    this.hoverPort = null;
    this.canvas.style.cursor = 'default';
    this.requestRender();
  };

  private onPointerLeave = (): void => {
    if (this.hoverPort) {
      this.hoverPort = null;
      this.requestRender();
    }
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const screen = this.eventscreen(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoomBy(factor, screen);
  };

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    const ctx = this.ctx;
    const view = this.getView();
    this.layouts = this.host.getProject().nodes.map((node) => this.layoutOf(node));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101217';
    ctx.fillRect(0, 0, width, height);
    this.drawGrid(ctx, width, height, view);

    ctx.save();
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);

    const project = this.host.getProject();
    const selectedEdgeId = this.host.getSelectedEdgeId();
    for (const edge of project.edges) {
      this.drawEdge(ctx, edge, edge.id === selectedEdgeId);
    }
    const drag = this.drag;
    if (drag && drag.kind === 'link' && drag.link) {
      this.drawDragLink(ctx, drag.link, drag.cursorX, drag.cursorY);
    }
    for (const layout of this.layouts) {
      this.drawNode(ctx, layout);
    }
    ctx.restore();
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    view: ViewState,
  ): void {
    const spacing = view.zoom < 0.55 ? GRID * 2 : GRID;
    const step = spacing * view.zoom;
    const offsetX = ((view.x % step) + step) % step;
    const offsetY = ((view.y % step) + step) % step;
    ctx.fillStyle = 'rgba(120, 132, 158, 0.16)';
    const radius = view.zoom < 0.55 ? 1 : 1.2;
    for (let x = offsetX; x < width; x += step) {
      for (let y = offsetY; y < height; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawEdge(ctx: CanvasRenderingContext2D, edge: Edge, selected: boolean): void {
    const path = this.edgePath(edge);
    if (!path) return;
    const points = path.points;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const type = this.portTypeOf(edge.from);
    ctx.save();
    ctx.lineWidth = selected ? 3.2 : 2;
    ctx.strokeStyle = selected ? '#ffffff' : TYPE_COLOR[type];
    ctx.globalAlpha = selected ? 1 : 0.85;
    if (selected) {
      ctx.shadowColor = TYPE_COLOR[type];
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    const dx = Math.max(48, Math.abs(last[0] - first[0]) * 0.5);
    ctx.bezierCurveTo(first[0] + dx, first[1], last[0] - dx, last[1], last[0], last[1]);
    ctx.stroke();
    // Direction dot near the input end.
    ctx.shadowBlur = 0;
    ctx.fillStyle = TYPE_COLOR[type];
    ctx.beginPath();
    ctx.arc(last[0] - 5, last[1], 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private portTypeOf(ref: PortRef): PortType {
    const layout = this.layouts.find((candidate) => candidate.node.id === ref.node);
    return layout?.ports.find((port) => port.key === ref.port && port.direction === 'out')?.type ?? 'color';
  }

  private drawDragLink(
    ctx: CanvasRenderingContext2D,
    link: LinkEnd,
    cursorX: number,
    cursorY: number,
  ): void {
    const layout = this.layouts.find((candidate) => candidate.node.id === link.ref.node);
    const port = layout?.ports.find(
      (candidate) => candidate.key === link.ref.port && candidate.direction === link.direction,
    );
    if (!port) return;
    const fromX = link.direction === 'out' ? port.x : cursorX;
    const fromY = link.direction === 'out' ? port.y : cursorY;
    const toX = link.direction === 'out' ? cursorX : port.x;
    const toY = link.direction === 'out' ? cursorY : port.y;
    ctx.save();
    ctx.strokeStyle = TYPE_COLOR[link.type];
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.globalAlpha = 0.9;
    const dx = Math.max(48, Math.abs(toX - fromX) * 0.5);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.bezierCurveTo(fromX + dx, fromY, toX - dx, toY, toX, toY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(toX, toY, 4, 0, Math.PI * 2);
    ctx.fillStyle = TYPE_COLOR[link.type];
    ctx.fill();
    ctx.restore();
  }

  private thumbnailFor(nodeId: string): HTMLCanvasElement | null {
    const image = this.host.getEvaluation().images.get(nodeId);
    if (!image) return null;
    const cached = this.thumbnails.get(nodeId);
    if (cached && cached.source === image) return cached.canvas;
    const resolution = 64;
    const canvas = cached?.canvas ?? document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, resolution, resolution);
      ctx.drawImage(rasterToCanvas(image), 0, 0, resolution, resolution);
    }
    this.thumbnails.set(nodeId, { source: image, canvas });
    return canvas;
  }

  private drawNode(ctx: CanvasRenderingContext2D, layout: NodeLayout): void {
    const { node, x, y, width, height, ports } = layout;
    const def = getNodeDef(node.type);
    const selected = this.host.getSelectedNodeId() === node.id;
    const evaluation = this.host.getEvaluation();
    const error = evaluation.errors.get(node.id);
    const categoryColor = CATEGORY_COLOR[def.category] ?? '#6ea8ff';

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = selected ? 20 : 12;
    ctx.shadowOffsetY = 4;
    roundRect(ctx, x, y, width, height, 10);
    ctx.fillStyle = '#1c2029';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Header
    ctx.save();
    roundRect(ctx, x, y, width, HEADER_HEIGHT, 10);
    ctx.clip();
    ctx.fillStyle = '#242a35';
    ctx.fillRect(x, y, width, HEADER_HEIGHT);
    ctx.fillStyle = categoryColor;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x, y, width, HEADER_HEIGHT);
    ctx.globalAlpha = 1;
    ctx.fillStyle = categoryColor;
    ctx.fillRect(x, y, 3, HEADER_HEIGHT);
    ctx.restore();

    ctx.fillStyle = '#eef2f8';
    ctx.font = '600 12px "Inter", "PingFang SC", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, nodeName(node), width - 52), x + 12, y + HEADER_HEIGHT / 2 + 1);
    ctx.fillStyle = '#8d97a9';
    ctx.font = '9.5px "Inter", "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      error ? '' : def.category,
      x + width - 10,
      y + HEADER_HEIGHT / 2 + 1,
    );
    ctx.textAlign = 'left';

    // Port rows
    const connectedInputs = new Set(
      this.host
        .getProject()
        .edges.filter((edge) => edge.to.node === node.id)
        .map((edge) => edge.to.port),
    );
    for (const port of ports) {
      const isInput = port.direction === 'in';
      const linked = isInput && connectedInputs.has(port.key);
      this.drawPort(ctx, port, linked);
    }

    // Thumbnail
    const thumbX = x + 12;
    const thumbY = y + HEADER_HEIGHT + PORT_AREA_TOP + layout.rows * PORT_ROW + 6;
    roundRect(ctx, thumbX - 1, thumbY - 1, THUMB_SIZE + 2, THUMB_SIZE + 2, 6);
    ctx.fillStyle = '#11141a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const thumbnail = this.thumbnailFor(node.id);
    if (thumbnail) {
      ctx.save();
      roundRect(ctx, thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, 5);
      ctx.clip();
      ctx.drawImage(thumbnail, thumbX, thumbY, THUMB_SIZE, THUMB_SIZE);
      ctx.restore();
    } else {
      ctx.fillStyle = '#5c6577';
      ctx.font = '9.5px "Inter", "PingFang SC", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(error ? '无预览' : '等待', thumbX + THUMB_SIZE / 2, thumbY + THUMB_SIZE / 2);
      ctx.textAlign = 'left';
    }

    // Node status text beside thumbnail
    const infoX = thumbX + THUMB_SIZE + 10;
    const infoWidth = width - (infoX - x) - 12;
    const infoTop = thumbY + 9;
    ctx.font = '9.5px "Inter", "PingFang SC", system-ui, sans-serif';
    if (error) {
      ctx.fillStyle = '#ff8e8e';
      ctx.fillText('⚠ 渲染失败', infoX, infoTop);
      ctx.fillStyle = '#b9a3a3';
      wrapText(ctx, error, infoX, infoTop + 15, infoWidth, 12, 3);
    } else {
      ctx.fillStyle = '#7f8899';
      const outCount = def.outputs.length;
      const inCount = def.inputs.length;
      ctx.fillText(`${inCount} 输入 · ${outCount} 输出`, infoX, infoTop);
      ctx.fillStyle = '#626b7c';
      ctx.fillText(def.category, infoX, infoTop + 15);
    }

    // Borders
    roundRect(ctx, x, y, width, height, 10);
    if (error) {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = selected ? 2.2 : 1.6;
    } else if (selected) {
      ctx.strokeStyle = '#9cc2ff';
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = 1;
    }
    ctx.stroke();

    if (error) {
      ctx.beginPath();
      ctx.arc(x + width - 11, y + 11, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ff6b6b';
      ctx.fill();
      ctx.fillStyle = '#1a0c0c';
      ctx.font = '700 11px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', x + width - 11, y + 11.5);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  }

  private drawPort(ctx: CanvasRenderingContext2D, port: PortLayout, linked: boolean): void {
    const color = TYPE_COLOR[port.type];
    const isInput = port.direction === 'in';
    const hover = this.hoverPort;
    const hovered =
      hover !== null &&
      hover.direction === port.direction &&
      hover.ref.port === port.key &&
      hover.ref.node === this.nodeIdAtPort(port);

    ctx.beginPath();
    ctx.arc(port.x, port.y, hovered ? 6 : 5, 0, Math.PI * 2);
    if (isInput) {
      ctx.fillStyle = linked ? color : '#171b23';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const typeText = TYPE_LABEL[port.type];
    ctx.font = '10.5px "Inter", "PingFang SC", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const chipWidth = ctx.measureText(typeText).width + 10;
    const chipHeight = 13;
    if (isInput) {
      const labelX = port.x + 12;
      ctx.fillStyle = '#c5cddb';
      ctx.fillText(port.label, labelX, port.y);
      const labelWidth = ctx.measureText(port.label).width;
      this.drawTypeChip(ctx, labelX + labelWidth + 6, port.y, chipWidth, chipHeight, port.type);
    } else {
      const labelX = port.x - 12;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#c5cddb';
      ctx.fillText(port.label, labelX, port.y);
      const labelWidth = ctx.measureText(port.label).width;
      this.drawTypeChip(
        ctx,
        labelX - labelWidth - 6 - chipWidth,
        port.y,
        chipWidth,
        chipHeight,
        port.type,
      );
      ctx.textAlign = 'left';
    }
  }

  private drawTypeChip(
    ctx: CanvasRenderingContext2D,
    x: number,
    centerY: number,
    width: number,
    height: number,
    type: PortType,
  ): void {
    const color = TYPE_COLOR[type];
    roundRect(ctx, x, centerY - height / 2, width, height, 4);
    ctx.fillStyle = `${color}22`;
    ctx.fill();
    ctx.fillStyle = color;
    const previousFont = ctx.font;
    const previousAlign = ctx.textAlign;
    ctx.font = '9px "Inter", "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(TYPE_LABEL[type], x + width / 2, centerY + 0.5);
    ctx.font = previousFont;
    ctx.textAlign = previousAlign;
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const characters = Array.from(text);
  let line = '';
  let lineIndex = 0;
  for (let i = 0; i < characters.length; i += 1) {
    const test = line + characters[i];
    if (ctx.measureText(test).width > maxWidth && line.length > 0) {
      if (lineIndex >= maxLines - 1) {
        ctx.fillText(`${line.slice(0, Math.max(0, line.length - 1))}…`, x, y + lineIndex * lineHeight);
        return;
      }
      ctx.fillText(line, x, y + lineIndex * lineHeight);
      lineIndex += 1;
      line = characters[i] ?? '';
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lineIndex * lineHeight);
}
