/*
 * history.js — 撤销/重做
 *
 * 文字修改与时间修改分别维护独立的撤销/重做栈，互不干扰：
 * 改文字不会清空时间栈，反之亦然。一次复合操作（如全部替换、拖动、
 * 增删条目）打包成一个历史条目，撤销时整体回退。
 */
(function (root) {
  'use strict';

  class HistoryStack {
    constructor(name) {
      this.name = name;
      this.undoStack = [];
      this.redoStack = [];
      this.onChange = null; // 状态变化回调（用于刷新按钮可用性）
    }

    // changes: [{ cueId, prop, old, new, index? }]，label 用于展示
    push(label, changes) {
      if (!changes || changes.length === 0) return;
      this.undoStack.push({ label, changes });
      this.redoStack = [];
      this._notify();
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    nextUndoLabel() {
      const e = this.undoStack[this.undoStack.length - 1];
      return e ? e.label : '';
    }
    nextRedoLabel() {
      const e = this.redoStack[this.redoStack.length - 1];
      return e ? e.label : '';
    }

    // apply(change, value) 由应用层提供，value 为要恢复到的值
    undo(apply) {
      const entry = this.undoStack.pop();
      if (!entry) return null;
      entry.changes.forEach((c) => apply(c, c.old));
      this.redoStack.push(entry);
      this._notify();
      return entry;
    }

    redo(apply) {
      const entry = this.redoStack.pop();
      if (!entry) return null;
      entry.changes.forEach((c) => apply(c, c.new));
      this.undoStack.push(entry);
      this._notify();
      return entry;
    }

    clear() {
      this.undoStack = [];
      this.redoStack = [];
      this._notify();
    }

    _notify() {
      if (this.onChange) this.onChange(this);
    }
  }

  const api = { HistoryStack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.History = api;
})(typeof window !== 'undefined' ? window : globalThis);
