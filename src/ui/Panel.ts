import type { BrushMode, BrushSettings } from "../core/types";
import type { TerrainModel } from "../core/TerrainModel";
import {
  computeExportInfo,
  fullRange,
  type ExportRange,
} from "../io/exporter";

export interface NewProjectOptions {
  chunkSize: number;
  chunksPerSide: number;
  spacing: number;
  seed: number;
}

export interface EditorActions {
  onNewProject: (opts: NewProjectOptions) => void;
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onLoadValley: () => void;
  onLoadSeam: () => void;
  onExport: (kind: "obj" | "height", range: ExportRange) => void;
  onBrushChange: (patch: Partial<BrushSettings>) => void;
  onSelectLayer: (id: string) => void;
  onAddLayer: () => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onLayerVisible: (id: string, visible: boolean) => void;
  onLayerOpacity: (id: string, opacity: number) => void;
  onToggleWireframe: (v: boolean) => void;
  onToggleBorders: (v: boolean) => void;
  onResetCamera: () => void;
}

const MODE_LABELS: Record<BrushMode, string> = {
  raise: "抬高",
  lower: "压低",
  smooth: "平滑",
  paint: "涂抹",
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(c: [number, number, number]): string {
  const f = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export class Panel {
  readonly root: HTMLElement;
  private actions: EditorActions;
  private getModel: () => TerrainModel;
  private brush: BrushSettings;

  private layerList!: HTMLElement;
  private modeButtons = new Map<BrushMode, HTMLButtonElement>();
  private radiusValue!: HTMLElement;
  private strengthValue!: HTMLElement;
  private colorPicker!: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private wireToggle!: HTMLElement;
  private borderToggle!: HTMLElement;
  private statusCursor!: HTMLElement;
  private statusBrush!: HTMLElement;
  private statusLayer!: HTMLElement;
  private statusProject!: HTMLElement;

  constructor(
    container: HTMLElement,
    brush: BrushSettings,
    getModel: () => TerrainModel,
    actions: EditorActions
  ) {
    this.brush = brush;
    this.getModel = getModel;
    this.actions = actions;
    this.root = el("div");
    container.appendChild(this.root);
    this.build();
  }

  // ---------------------------------------------------------------
  // 骨架
  // ---------------------------------------------------------------

  private build(): void {
    const app = el("div");
    app.id = "app";
    this.root.replaceChildren(app);

    app.appendChild(this.buildToolbar());

    const main = el("div", "main");
    main.appendChild(this.buildSidebar());

    const viewport = el("div", "viewport");
    viewport.id = "viewport";
    main.appendChild(viewport);

    app.appendChild(main);
    app.appendChild(this.buildStatusBar());
  }

  get viewport(): HTMLElement {
    return document.getElementById("viewport")!;
  }

  private buildToolbar(): HTMLElement {
    const bar = el("div", "toolbar");

    const g1 = el("div", "group");
    g1.append(
      this.btn("新建", () => this.showNewProjectModal()),
      this.btn("打开", () => this.actions.onOpen()),
      this.btn("保存", () => this.actions.onSave())
    );

    const g2 = el("div", "group");
    this.undoBtn = this.btn("撤销", () => this.actions.onUndo());
    this.redoBtn = this.btn("重做", () => this.actions.onRedo());
    g2.append(this.undoBtn, this.redoBtn);

    const g3 = el("div", "group");
    g3.append(
      this.btn("山谷样例", () => this.actions.onLoadValley()),
      this.btn("接缝检查场景", () => this.actions.onLoadSeam())
    );

    const g4 = el("div", "group");
    g4.append(
      this.btn("导出 OBJ", () => this.showExportModal("obj")),
      this.btn("导出高度", () => this.showExportModal("height"))
    );

    const g5 = el("div", "group");
    this.wireToggle = this.checkbox("线框", false, (v) => this.actions.onToggleWireframe(v));
    this.borderToggle = this.checkbox("区块边界", true, (v) => this.actions.onToggleBorders(v));
    g5.append(this.wireToggle, this.borderToggle);

    bar.append(g1, g2, g3, g4, g5);
    return bar;
  }

  private buildSidebar(): HTMLElement {
    const side = el("div", "sidebar");

    // 笔刷
    const brushSec = el("div", "section");
    brushSec.appendChild(el("h3")).textContent = "笔刷";
    const modeGrid = el("div", "mode-grid");
    (Object.keys(MODE_LABELS) as BrushMode[]).forEach((mode) => {
      const b = this.btn(MODE_LABELS[mode], () =>
        this.actions.onBrushChange({ mode })
      );
      this.modeButtons.set(mode, b);
      modeGrid.appendChild(b);
    });
    brushSec.appendChild(modeGrid);

    const radiusRow = el("div", "field");
    radiusRow.appendChild(el("label")).textContent = "半径";
    const radius = document.createElement("input");
    radius.type = "range";
    radius.min = "1";
    radius.max = "40";
    radius.step = "0.5";
    radius.value = String(this.brush.radius);
    this.radiusValue = el("span", "value");
    this.radiusValue.textContent = `${this.brush.radius}`;
    radius.oninput = () => {
      const v = Number(radius.value);
      this.radiusValue.textContent = `${v}`;
      this.actions.onBrushChange({ radius: v });
    };
    radiusRow.append(radius, this.radiusValue);
    brushSec.appendChild(radiusRow);

    const strengthRow = el("div", "field");
    strengthRow.appendChild(el("label")).textContent = "强度";
    const strength = document.createElement("input");
    strength.type = "range";
    strength.min = "0.02";
    strength.max = "1";
    strength.step = "0.02";
    strength.value = String(this.brush.strength);
    this.strengthValue = el("span", "value");
    this.strengthValue.textContent = `${this.brush.strength}`;
    strength.oninput = () => {
      const v = Number(strength.value);
      this.strengthValue.textContent = v.toFixed(2);
      this.actions.onBrushChange({ strength: v });
    };
    strengthRow.append(strength, this.strengthValue);
    brushSec.appendChild(strengthRow);

    const colorRow = el("div", "field");
    colorRow.appendChild(el("label")).textContent = "涂抹颜色";
    this.colorPicker = document.createElement("input");
    this.colorPicker.type = "color";
    this.colorPicker.value = rgbToHex(this.brush.color);
    this.colorPicker.oninput = () =>
      this.actions.onBrushChange({ color: hexToRgb(this.colorPicker.value) });
    colorRow.appendChild(this.colorPicker);
    brushSec.appendChild(colorRow);

    const hint = el("div", "hint");
    hint.innerHTML =
      "左键涂抹地形，右键/中键旋转视角，<kbd>Shift</kbd>+左键平移，滚轮缩放";
    brushSec.appendChild(hint);

    // 图层
    const layerSec = el("div", "section");
    layerSec.appendChild(el("h3")).textContent = "图层";
    this.layerList = el("div", "layer-list");
    layerSec.appendChild(this.layerList);
    const layerActions = el("div", "layer-actions");
    layerActions.append(
      this.btn("新增", () => this.actions.onAddLayer()),
      this.btn("复制", () => this.actions.onDuplicateLayer(this.getModel().selectedLayerId)),
      this.btn("删除", () => this.actions.onDeleteLayer(this.getModel().selectedLayerId))
    );
    layerSec.appendChild(layerActions);

    // 视角
    const viewSec = el("div", "section");
    viewSec.appendChild(el("h3")).textContent = "视角";
    viewSec.appendChild(this.btn("重置相机", () => this.actions.onResetCamera()));

    side.append(brushSec, layerSec, viewSec);
    return side;
  }

  private buildStatusBar(): HTMLElement {
    const bar = el("div", "statusbar");
    this.statusProject = el("span");
    this.statusCursor = el("span");
    this.statusBrush = el("span");
    this.statusLayer = el("span");
    const spacer = el("span", "spacer");
    bar.append(this.statusProject, this.statusCursor, this.statusBrush, spacer, this.statusLayer);
    return bar;
  }

  // ---------------------------------------------------------------
  // 小控件
  // ---------------------------------------------------------------

  private btn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  private checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    const wrap = el("label", "checkbox-field");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }
  // ---------------------------------------------------------------
  // 刷新
  // ---------------------------------------------------------------

  syncBrush(brush: BrushSettings): void {
    for (const [mode, b] of this.modeButtons) {
      b.classList.toggle("active", mode === brush.mode);
    }
    this.radiusValue.textContent = `${brush.radius}`;
    this.strengthValue.textContent = brush.strength.toFixed(2);
    this.colorPicker.value = rgbToHex(brush.color);
  }

  refreshLayers(): void {
    const model = this.getModel();
    this.layerList.replaceChildren();
    for (const layer of model.layers) {
      const item = el("div", "layer-item" + (layer.id === model.selectedLayerId ? " selected" : ""));

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "icon";
      eye.textContent = layer.visible ? "👁" : "—";
      eye.title = layer.visible ? "隐藏图层" : "显示图层";
      eye.onclick = (e) => {
        e.stopPropagation();
        this.actions.onLayerVisible(layer.id, !layer.visible);
      };

      const name = el("span", "name");
      name.textContent = layer.name;
      name.title = `${layer.name}（强度 ${Math.round(layer.opacity * 100)}%）`;

      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.05";
      opacity.value = String(layer.opacity);
      opacity.title = "图层强度";
      opacity.onclick = (e) => e.stopPropagation();
      opacity.oninput = () => this.actions.onLayerOpacity(layer.id, Number(opacity.value));

      item.append(eye, name, opacity);
      item.onclick = () => this.actions.onSelectLayer(layer.id);
      this.layerList.appendChild(item);
    }
    this.undoBtn.disabled = !model.canUndo(model.selectedLayerId);
    this.redoBtn.disabled = !model.canRedo(model.selectedLayerId);
    const l = model.selectedLayer;
    this.statusLayer.textContent =
      `图层：${l.name}｜历史 ${l.undoStack.length}/${l.redoStack.length}`;
  }

  setStatus(cursor: string | null): void {
    const model = this.getModel();
    this.statusProject.textContent =
      `网格 ${model.vertexCount}×${model.vertexCount}｜区块 ${model.chunksPerSide}×${model.chunksPerSide}` +
      `（每块 ${model.chunkSize} 格）｜间距 ${model.spacing}｜种子 ${model.seed}`;
    this.statusCursor.textContent = cursor ? `光标：${cursor}` : "光标：—";
    this.statusBrush.textContent =
      `笔刷：${MODE_LABELS[this.brush.mode]} r=${this.brush.radius}`;
    this.refreshLayers();
  }

  // ---------------------------------------------------------------
  // 弹窗
  // ---------------------------------------------------------------

  private modal(title: string, content: HTMLElement, buttons: HTMLElement[]): HTMLElement {
    const mask = el("div", "modal-mask");
    const box = el("div", "modal");
    box.appendChild(el("h2")).textContent = title;
    box.appendChild(content);
    const btnRow = el("div", "buttons");
    btnRow.append(...buttons);
    box.appendChild(btnRow);
    mask.appendChild(box);
    mask.onclick = (e) => {
      if (e.target === mask) mask.remove();
    };
    this.root.appendChild(mask);
    return mask;
  }

  private showNewProjectModal(): void {
    const content = el("div");
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const fields: Array<[string, HTMLElement]> = [];

    const chunkSize = document.createElement("select");
    [8, 16, 24].forEach((v) => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${v} 格/块`;
      chunkSize.appendChild(o);
    });
    chunkSize.value = "16";

    const chunks = document.createElement("select");
    [2, 3, 4, 6].forEach((v) => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${v}×${v} 块`;
      chunks.appendChild(o);
    });
    chunks.value = "4";

    const spacing = document.createElement("input");
    spacing.type = "number";
    spacing.value = "1";
    spacing.min = "0.1";
    spacing.step = "0.5";

    const seedInput = document.createElement("input");
    seedInput.type = "number";
    seedInput.value = String(seed);
    seedInput.min = "0";

    fields.push(
      ["区块精度", chunkSize],
      ["区块数量", chunks],
      ["顶点间距（米）", spacing],
      ["随机种子", seedInput]
    );
    for (const [label, input] of fields) {
      const row = el("div", "row");
      row.appendChild(el("label")).textContent = label;
      row.appendChild(input);
      content.appendChild(row);
    }
    const info = el("div", "info");
    const updateInfo = () => {
      const cs = Number(chunkSize.value);
      const cps = Number(chunks.value);
      const N = cs * cps + 1;
      info.textContent =
        `顶点网格：${N}×${N} = ${N * N} 顶点\n` +
        `世界尺寸：${((N - 1) * Number(spacing.value)).toFixed(1)} 米\n` +
        `区块总数：${cps * cps}`;
    };
    updateInfo();
    [chunkSize, chunks, spacing].forEach((n) => (n.onchange = updateInfo));
    content.appendChild(info);

    const cancel = this.btn("取消", () => mask.remove());
    const ok = this.btn("创建", () => {
      this.actions.onNewProject({
        chunkSize: Number(chunkSize.value),
        chunksPerSide: Number(chunks.value),
        spacing: Number(spacing.value),
        seed: Number(seedInput.value) >>> 0,
      });
      mask.remove();
    });
    ok.classList.add("primary");
    const mask = this.modal("新建地形工程", content, [cancel, ok]);
  }

  private showExportModal(kind: "obj" | "height"): void {
    const model = this.getModel();
    const content = el("div");
    const last = model.chunksPerSide - 1;

    const mkRange = (label: string): HTMLSelectElement => {
      const row = el("div", "row");
      row.appendChild(el("label")).textContent = label;
      const sel = document.createElement("select");
      for (let i = 0; i < model.chunksPerSide; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = String(i);
        sel.appendChild(o);
      }
      row.appendChild(sel);
      content.appendChild(row);
      return sel;
    };
    const x0 = mkRange("起始区块 X");
    const z0 = mkRange("起始区块 Z");
    const x1 = mkRange("结束区块 X");
    const z1 = mkRange("结束区块 Z");
    x1.value = String(last);
    z1.value = String(last);

    const info = el("div", "info");
    const update = () => {
      const range: ExportRange = {
        cx0: Number(x0.value),
        cy0: Number(z0.value),
        cx1: Number(x1.value),
        cy1: Number(z1.value),
      };
      if (range.cx1 < range.cx0) range.cx1 = range.cx0;
      if (range.cy1 < range.cy0) range.cy1 = range.cy0;
      const s = computeExportInfo(model, range);
      info.textContent =
        `导出范围：${s.chunkLabel}\n` +
        `顶点：${s.vertexX}×${s.vertexZ}｜三角形：${s.triangleCount}\n` +
        `世界尺寸：${s.worldWidth.toFixed(1)} × ${s.worldDepth.toFixed(1)} 米\n` +
        `高度区间：${s.heightMin.toFixed(2)} ~ ${s.heightMax.toFixed(2)} 米`;
      return range;
    };
    [x0, z0, x1, z1].forEach((s) => (s.onchange = () => update()));
    update();
    content.appendChild(info);

    const cancel = this.btn("取消", () => mask.remove());
    const ok = this.btn("导出", () => {
      const r = update();
      this.actions.onExport(kind, r);
      mask.remove();
    });
    ok.classList.add("primary");
    const mask = this.modal(
      kind === "obj" ? "导出网格 OBJ" : "导出高度数据",
      content,
      [cancel, ok]
    );
  }

  alert(message: string): void {
    const content = el("div");
    content.appendChild(el("div", "info")).textContent = message;
    const ok = this.btn("知道了", () => mask.remove());
    ok.classList.add("primary");
    const mask = this.modal("提示", content, [ok]);
  }
}
