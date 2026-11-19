/* 撤销/重做历史栈。
 * 每个条目为 { label, undo(), redo() }。
 * 载入/新建项目时调用 clear()，撤销栈从之后的操作重新建立。 */
window.App = window.App || {};

App.History = class {
  constructor(limit) {
    this.limit = limit || 60;
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = null; // 栈变化回调（更新按钮状态）
  }

  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._notify();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this._notify();
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this._notify();
    return e.label;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._notify();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _notify() {
    if (this.onChange) this.onChange();
  }
};
