import { CHUNK_CAPACITY } from './renderer';
import type {
  DrawItem,
  InstanceData,
  PickNeighborCell,
  PickResult,
} from './types';
import type { RenderStats } from './renderer';

interface StatsView {
  total: number;
  visibleCount: number;
  render: RenderStats;
  frozen: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const fmt3 = (v: number | null | undefined): string =>
  v == null ? '—' : v.toFixed(3);

const fmtVec = (v: number[] | null): string =>
  v ? v.map((x) => x.toFixed(2)).join(', ') : '—';

export class Panel {
  // 场景
  btnSparse = $<HTMLButtonElement>('btn-sparse');
  btnDense = $<HTMLButtonElement>('btn-dense');
  btnAddBatch = $<HTMLButtonElement>('btn-add-batch');
  btnResetCam = $<HTMLButtonElement>('btn-reset-cam');
  chkLabels = $<HTMLInputElement>('chk-labels');
  chkFrustum = $<HTMLInputElement>('chk-frustum');

  // 统计
  private stTotal = $('st-total');
  private stVisible = $('st-visible');
  private stDrawn = $('st-drawn');
  private stBatches = $('st-batches');
  private stCalls = $('st-calls');
  private stCap = $('st-cap');
  private stCapacity = $('st-capacity');
  private stFrozen = $('st-frozen');

  // 批量操作
  btnHideSelected = $<HTMLButtonElement>('btn-hide-selected');
  btnShowAll = $<HTMLButtonElement>('btn-show-all');
  btnDeleteSelected = $<HTMLButtonElement>('btn-delete-selected');
  btnShuffle = $<HTMLButtonElement>('btn-shuffle');
  btnMirrorBatch = $<HTMLButtonElement>('btn-mirror-batch');
  btnRandomBatch = $<HTMLButtonElement>('btn-random-batch');

  // 选中详情
  private selEmpty = $('selection-empty');
  private selBody = $<HTMLDivElement>('selection-body');
  private selId = $('sel-id');
  private selBatch = $('sel-batch');
  private selSlot = $('sel-slot');
  private selColor = $('sel-color');
  private selMirror = $('sel-mirror');
  inTx = $<HTMLInputElement>('in-tx');
  inTy = $<HTMLInputElement>('in-ty');
  inTz = $<HTMLInputElement>('in-tz');
  inRx = $<HTMLInputElement>('in-rx');
  inRy = $<HTMLInputElement>('in-ry');
  inRz = $<HTMLInputElement>('in-rz');
  inSx = $<HTMLInputElement>('in-sx');
  inSy = $<HTMLInputElement>('in-sy');
  inSz = $<HTMLInputElement>('in-sz');
  btnSelHide = $<HTMLButtonElement>('btn-sel-hide');
  btnSelDelete = $<HTMLButtonElement>('btn-sel-delete');

  // 点选
  chkNeighbor = $<HTMLInputElement>('chk-neighbor');
  private neighborGrid = $('neighbor-grid');
  private pickTable = $<HTMLTableElement>('pick-table');
  private pkId = $('pk-id');
  private pkFace = $('pk-face');
  private pkWorld = $('pk-world');
  private pkLocal = $('pk-local');
  private pkDepth = $('pk-depth');
  private pkPx = $('pk-px');
  btnRepick = $<HTMLButtonElement>('btn-repick');
  btnClearPick = $<HTMLButtonElement>('btn-clear-pick');
  private pickLog = $<HTMLOListElement>('pick-log');

  // 布局与结果
  btnFreeze = $<HTMLButtonElement>('btn-freeze');
  btnRestore = $<HTMLButtonElement>('btn-restore');
  btnSave = $<HTMLButtonElement>('btn-save');
  btnLoad = $<HTMLButtonElement>('btn-load');
  btnExportLayout = $<HTMLButtonElement>('btn-export-layout');
  btnImportLayout = $<HTMLButtonElement>('btn-import-layout');
  btnExportPicks = $<HTMLButtonElement>('btn-export-picks');
  btnClearLog = $<HTMLButtonElement>('btn-clear-log');
  fileImport = $<HTMLInputElement>('file-import');
  private saveStatus = $('save-status');

  // HUD
  private hudMode = $('hud-mode');
  private hudDpr = $('hud-dpr');
  private hudCoord = $('hud-coord');

  /** 抑制 transform 输入框回写触发 change 事件 */
  private syncingInputs = false;

  updateStats(view: StatsView): void {
    this.stTotal.textContent = String(view.total);
    this.stVisible.textContent = String(view.visibleCount);
    this.stDrawn.textContent = String(view.render.drawnCount);
    this.stBatches.textContent = String(view.render.logicalBatches);
    this.stCalls.textContent = String(view.render.instancedCalls);
    this.stCap.textContent = String(CHUNK_CAPACITY);
    this.stCapacity.textContent =
      `${view.render.bufferCapacity} / ${view.render.reallocCount}`;
    this.stFrozen.textContent = view.frozen ? '冻结（重测用固定视角）' : '实时';
    this.btnFreeze.textContent = view.frozen ? '解除冻结' : '冻结布局';
    this.hudMode.textContent = view.frozen ? 'FROZEN' : 'LIVE';
  }

  updateHud(dpr: number, css: { x: number; y: number } | null): void {
    this.hudDpr.textContent = `DPR ${dpr.toFixed(2)}`;
    this.hudCoord.textContent = css
      ? `x:${css.x.toFixed(0)} y:${css.y.toFixed(0)}`
      : 'x:— y:—';
  }

  updateSelection(
    inst: InstanceData | null,
    drawList: DrawItem[],
  ): void {
    if (!inst) {
      this.selEmpty.hidden = false;
      this.selBody.hidden = true;
      return;
    }
    this.selEmpty.hidden = true;
    this.selBody.hidden = false;
    const slot = drawList.find((d) => d.id === inst.id)?.slot ?? -1;
    this.selId.textContent = `#${inst.id}（稳定，删除不复用）`;
    this.selBatch.textContent = `批次 B${inst.batchId}`;
    this.selSlot.textContent =
      slot >= 0 ? `slot ${slot}（本帧绘制顺序，可能变化）` : '未参与绘制';
    const hex = inst.color
      .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
      .join('');
    this.selColor.innerHTML =
      `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;` +
      `background:#${hex};vertical-align:middle;margin-right:6px"></span>#${hex}`;
    const mirrored = inst.scale.some((s) => s < 0);
    this.selMirror.textContent = mirrored
      ? `是（${inst.scale.map((s) => (s < 0 ? '负' : '正')).join('/')}）`
      : '否';

    this.syncingInputs = true;
    const [tx, ty, tz] = inst.position;
    const [rx, ry, rz] = inst.rotationDeg;
    const [sx, sy, sz] = inst.scale;
    this.inTx.value = tx.toFixed(2);
    this.inTy.value = ty.toFixed(2);
    this.inTz.value = tz.toFixed(2);
    this.inRx.value = rx.toFixed(1);
    this.inRy.value = ry.toFixed(1);
    this.inRz.value = rz.toFixed(1);
    this.inSx.value = sx.toFixed(2);
    this.inSy.value = sy.toFixed(2);
    this.inSz.value = sz.toFixed(2);
    this.syncingInputs = false;
  }

  /** 读取 transform 输入框的当前值 */
  readTransformInputs(): {
    position: [number, number, number];
    rotationDeg: [number, number, number];
    scale: [number, number, number];
  } {
    const num = (el: HTMLInputElement) => Number(el.value);
    return {
      position: [num(this.inTx), num(this.inTy), num(this.inTz)],
      rotationDeg: [num(this.inRx), num(this.inRy), num(this.inRz)],
      scale: [num(this.inSx), num(this.inSy), num(this.inSz)],
    };
  }

  get isSyncingInputs(): boolean {
    return this.syncingInputs;
  }

  showPickResult(result: PickResult): void {
    this.pickTable.hidden = false;
    this.neighborGrid.hidden =
      result.neighborhood.length === 0;
    if (result.hitId === 0) {
      this.pkId.textContent = '背景（未命中任何实例）';
      this.pkFace.textContent = '—';
      this.pkWorld.textContent = '—';
      this.pkLocal.textContent = '—';
      this.pkDepth.textContent = '—';
    } else {
      this.pkId.textContent =
        `#${result.hitId}${result.frozen ? '（冻结视角下测得）' : ''}`;
      this.pkFace.textContent = result.face;
      this.pkWorld.textContent = fmtVec(result.world);
      this.pkLocal.textContent = fmtVec(result.local);
      this.pkDepth.textContent = fmt3(result.depth);
    }
    this.pkPx.textContent =
      `${result.cssX.toFixed(1)}, ${result.cssY.toFixed(1)} / ` +
      `${result.physX}, ${result.physY}`;
    this.renderNeighborhood(result.neighborhood, result.hitId);
  }

  clearPickResult(): void {
    this.pickTable.hidden = true;
    this.neighborGrid.hidden = true;
  }

  private renderNeighborhood(
    cells: PickNeighborCell[],
    centerId: number,
  ): void {
    this.neighborGrid.innerHTML = '';
    for (const cell of cells) {
      const div = document.createElement('div');
      div.className = 'cell';
      if (cell.id !== 0) div.classList.add('hit');
      if (cell.dx === 0 && cell.dy === 0) div.classList.add('center');
      div.textContent = cell.id === 0 ? '·' : `#${cell.id}`;
      div.title = `dx=${cell.dx} dy=${cell.dy} id=${cell.id}`;
      this.neighborGrid.appendChild(div);
    }
    void centerId;
  }

  appendPickLog(result: PickResult): void {
    const li = document.createElement('li');
    const t = new Date(result.time).toLocaleTimeString();
    li.innerHTML =
      `${t} 点 <b>${result.hitId === 0 ? '背景' : '#' + result.hitId}</b>` +
      ` 面 ${result.face} @(${result.cssX.toFixed(0)},${result.cssY.toFixed(0)})` +
      (result.frozen ? ' [冻结]' : '');
    this.pickLog.prepend(li);
    while (this.pickLog.children.length > 30) {
      this.pickLog.lastElementChild?.remove();
    }
  }

  clearPickLog(): void {
    this.pickLog.innerHTML = '';
  }

  setSaveStatus(text: string): void {
    this.saveStatus.textContent = text;
    if (text) {
      setTimeout(() => {
        if (this.saveStatus.textContent === text) {
          this.saveStatus.textContent = '';
        }
      }, 3000);
    }
  }
}
