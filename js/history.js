/* 基于工程 JSON 快照的撤销/重做；连续拖拽只在开始时入栈一次 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  function createHistory(limit) {
    return {
      undoStack: [],
      redoStack: [],
      gesturing: false,
      lazy: false,
      pushed: false,
      limit: limit || 60,
      onChange: null,

      _emit() { if (this.onChange) this.onChange(); },

      /** 离散操作：修改前调用，记录当前状态 */
      push(project) {
        if (this.gesturing) return; // 手势中已在 beginGesture 记录
        this.undoStack.push(JSON.stringify(project));
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
        this._emit();
      },

      /** 连续手势开始（拖拽/连续输入），立即记录初始状态一次 */
      beginGesture(project) {
        if (this.gesturing) return;
        this.gesturing = true;
        this.lazy = false;
        this.undoStack.push(JSON.stringify(project));
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
        this._emit();
      },

      /** 懒手势：先不压栈，等第一次真实修改时再记录修改前状态 */
      arm() {
        if (this.gesturing) return;
        this.gesturing = true;
        this.lazy = true;
        this.pushed = false;
      },

      /** 懒手势期间的第一次修改前调用，压入修改前快照（仅一次） */
      pushLazy(project) {
        if (this.gesturing && this.lazy && !this.pushed) {
          this.undoStack.push(JSON.stringify(project));
          if (this.undoStack.length > this.limit) this.undoStack.shift();
          this.redoStack.length = 0;
          this.pushed = true;
          this._emit();
        }
      },

      endGesture() {
        this.gesturing = false;
        this.lazy = false;
        this.pushed = false;
      },

      canUndo() { return this.undoStack.length > 0; },
      canRedo() { return this.redoStack.length > 0; },

      undo(project) {
        if (!this.canUndo()) return null;
        this.redoStack.push(JSON.stringify(project));
        const text = this.undoStack.pop();
        this._emit();
        return JSON.parse(text);
      },

      redo(project) {
        if (!this.canRedo()) return null;
        this.undoStack.push(JSON.stringify(project));
        const text = this.redoStack.pop();
        this._emit();
        return JSON.parse(text);
      },

      reset() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.gesturing = false;
        this.lazy = false;
        this.pushed = false;
        this._emit();
      },
    };
  }

  G.createHistory = createHistory;
})();
