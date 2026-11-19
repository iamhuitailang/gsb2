/* 撤销/重做：命令模式。每个动作拥有独立历史栈，结构编辑走全局栈，互不串扰 */
(function (global) {
  'use strict';

  const LIMIT = 100;

  class History {
    constructor(name) {
      this.name = name;
      this.undoStack = [];
      this.redoStack = [];
      this.onChange = null;
    }

    push(label, undoFn, redoFn) {
      this.undoStack.push({ label, undo: undoFn, redo: redoFn });
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
      this.redoStack.length = 0; // 新操作使重做链失效
      this._emit();
    }

    undo() {
      const cmd = this.undoStack.pop();
      if (!cmd) return null;
      cmd.undo();
      this.redoStack.push(cmd);
      this._emit();
      return cmd.label;
    }

    redo() {
      const cmd = this.redoStack.pop();
      if (!cmd) return null;
      cmd.redo();
      this.undoStack.push(cmd);
      this._emit();
      return cmd.label;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
    get nextUndoLabel() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; }
    get nextRedoLabel() { return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : ''; }

    clear() {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this._emit();
    }

    _emit() { if (this.onChange) this.onChange(); }
  }

  /** 深拷贝快照（项目为纯 JSON，图片 dataURL 也是字符串） */
  function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
  }

  global.History = { History, snapshot };
})(window);
