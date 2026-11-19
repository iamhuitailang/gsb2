/* 撤销/重做。每个动作记录所属图层 id，撤销时作用于原图层而非当前图层。 */
'use strict';

const History = {
  undoStack: [],
  redoStack: [],
  LIMIT: 200,

  reset() { this.undoStack = []; this.redoStack = []; },

  push(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > this.LIMIT) this.undoStack.shift();
    this.redoStack = [];
  },

  /* action 种类：
   * {kind:'cells',  layerId, changes:[{x,y,before,after}]}  笔刷/擦除/填充/移动选区
   * {kind:'resize', before:levelSnap, after:levelSnap}      地图尺寸调整
   * {kind:'layers', before:levelSnap, after:levelSnap}      图层增删/排序/改名
   */
  undo(level) {
    const a = this.undoStack.pop();
    if (!a) return null;
    this.applyInverse(level, a, true);
    this.redoStack.push(a);
    return a;
  },

  redo(level) {
    const a = this.redoStack.pop();
    if (!a) return null;
    this.applyInverse(level, a, false);
    this.undoStack.push(a);
    return a;
  },

  applyInverse(level, a, isUndo) {
    if (a.kind === 'cells') {
      const layer = level.layers.find(l => l.id === a.layerId);
      if (!layer) return;
      for (const ch of a.changes) applyCellChange(layer, ch, isUndo);
    } else { // resize / layers：整体快照替换
      const snap = isUndo ? a.before : a.after;
      level.width = snap.width; level.height = snap.height;
      level.tileSize = snap.tileSize; level.name = snap.name;
      level.layers = snap.layers.map(l => ({ ...l, tiles: l.tiles.slice() }));
    }
  },
};

/* 变更以世界像素坐标锚定：图层扩容/平移后仍能定位到同一个世界格子。
 * （格子坐标 = 数组下标，会随扩容平移；世界坐标不会。） */
function applyCellChange(layer, ch, isUndo) {
  const cs = layer.cellSize;
  const gx = Math.round((ch.wx - layer.originX) / cs);
  const gy = Math.round((ch.wy - layer.originY) / cs);
  ensureCell(layer, gx, gy);
  setTileRaw(layer, gx, gy, isUndo ? ch.before : ch.after);
}

/* 收集一次连续编辑的格子变更，提交为单个动作。坐标以世界像素锚定。 */
function makeChangeCollector() {
  const map = new Map(); // "wx,wy" -> {wx,wy,before,after}
  return {
    /* 写入一个格子（自动扩容），返回是否实际改变 */
    set(layer, x, y, id) {
      const wx = layer.originX + x * layer.cellSize;
      const wy = layer.originY + y * layer.cellSize;
      const key = wx + ',' + wy;
      const before = layerTileAt(layer, x, y);
      const rec = map.get(key);
      if (rec) {
        if (rec.before === id) map.delete(key); // 改回原值，抵消
        else rec.after = id;
      } else {
        if (before === id) return false;
        map.set(key, { wx, wy, before, after: id });
      }
      ensureCell(layer, x, y);
      setTileRaw(layer, x, y, id);
      return true;
    },
    empty() { return map.size === 0; },
    /* 放弃所有已应用的修改（用于取消移动选区） */
    rollback(layer) {
      for (const rec of map.values()) applyCellChange(layer, rec, true);
      map.clear();
    },
    commit(layerId) {
      if (map.size === 0) return false;
      History.push({ kind: 'cells', layerId, changes: [...map.values()] });
      return true;
    },
  };
}
