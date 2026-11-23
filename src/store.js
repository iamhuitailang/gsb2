// 全局状态 + 撤销重做。文档为纯数据，历史栈存 JSON 快照，任何结构/样式/锚点操作天然可回滚
import { createDoc, deserializeDoc, pruneSelection } from './model.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const HISTORY_LIMIT = 100;

export class Store {
  constructor() {
    this.doc = createDoc();
    this.view = { zoom: 1, panX: 0, panY: 0 };          // 视图变换（不进历史）
    this.tool = 'select';                                // select | pen | line | rect
    this.selection = { paths: [], anchor: null, handle: null }; // anchor: {pathId,si,ai}; handle 同构 + side
    this.penDraft = null;                                // 钢笔工具正在绘制的子路径
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.gestureBase = null;
    this.dirty = false;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = 'change') { for (const fn of this.listeners) fn(kind); }

  loadDoc(doc) {
    this.doc = doc;
    this.undoStack = []; this.redoStack = [];
    this.selection = { paths: [], anchor: null, handle: null };
    this.penDraft = null;
    this.dirty = false;
    this.emit('doc');
  }

  // ---------- 历史 ----------
  // 离散操作：调用前拍快照，操作失败自动回滚
  run(label, fn) {
    const snap = clone(this.doc);
    const result = fn();
    if (result === false) {
      this.doc = clone(snap);
      return result;
    }
    this._push(snap, label);
    this._afterStructural();
    this.emit('history');
    return result;
  }

  // 连续手势（拖拽锚点/控制柄/路径、画笔绘制）：开始时拍一次，结束时入栈
  beginGesture(label) {
    this.gestureBase = { snap: clone(this.doc), label };
  }
  updateGesture(fn) {
    fn();
    this.emit('gesture');
  }
  commitGesture() {
    if (!this.gestureBase) return;
    // 入栈前再克隆一次，避免后续原地修改污染历史快照
    this._push(clone(this.gestureBase.snap), this.gestureBase.label);
    this.gestureBase = null;
    this._afterStructural();
    this.emit('history');
  }
  cancelGesture() {
    if (!this.gestureBase) return;
    this.doc = clone(this.gestureBase.snap);
    this.gestureBase = null;
    this._afterStructural();
    this.emit('history');
  }

  _push(snap, label) {
    this.undoStack.push({ snap, label });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  undo() {
    const item = this.undoStack.pop();
    if (!item) return;
    this.redoStack.push({ snap: clone(this.doc), label: item.label });
    this.doc = clone(item.snap);
    this._afterStructural();
    this.emit('history');
  }

  redo() {
    const item = this.redoStack.pop();
    if (!item) return;
    this.undoStack.push({ snap: clone(this.doc), label: item.label });
    this.doc = clone(item.snap);
    this._afterStructural();
    this.emit('history');
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastLabel() { return this.undoStack.at(-1)?.label || ''; }

  // 文档结构变化后清理失效选择
  _afterStructural() {
    const before = this.selection.paths.length;
    this.selection.paths = pruneSelection(this.doc, this.selection.paths);
    const alive = (ref) => ref && this._findPath(ref.pathId);
    if (this.selection.anchor && !alive(this.selection.anchor)) this.selection.anchor = null;
    if (this.selection.handle && !alive(this.selection.handle)) this.selection.handle = null;
    if (before !== this.selection.paths.length) this.emit('selection');
  }

  _findPath(id) {
    let hit = null;
    const walk = (list) => {
      for (const n of list) {
        if (n.id === id && n.type === 'path') { hit = n; return; }
        if (n.type === 'group') walk(n.children);
      }
    };
    walk(this.doc.layers);
    return hit;
  }

  // ---------- 视图 / 工具 / 选择（不进历史） ----------
  setView(patch) { Object.assign(this.view, patch); this.emit('view'); }
  setTool(tool) {
    this.tool = tool;
    if (tool !== 'pen') this.penDraft = null;
    if (tool !== 'select') { this.selection.anchor = null; this.selection.handle = null; }
    this.emit('tool');
  }
  select(paths, anchor = null, handle = null) {
    this.selection = { paths: [...new Set(paths)], anchor, handle };
    this.emit('selection');
  }
  toggleSelection(id) {
    const set = new Set(this.selection.paths);
    if (set.has(id)) set.delete(id); else set.add(id);
    this.select([...set]);
  }
  clearSelection() { this.select([]); }

  // ---------- 持久化 ----------
  toJSON() { return JSON.stringify(this.doc, null, 2); }
  loadJSON(text) { this.loadDoc(deserializeDoc(text)); }
}
