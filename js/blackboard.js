/* 黑板：行为树运行期共享变量容器（纯数据，无 DOM 依赖） */
(function (global) {
  'use strict';

  class Blackboard {
    /** @param entries 初始键值对对象；onChange 变更回调（供 UI 刷新） */
    constructor(entries, onChange) {
      this.data = entries ? BTUtils.deepClone(entries) : {};
      this.onChange = onChange || null;
    }

    get(key) {
      if (!Object.prototype.hasOwnProperty.call(this.data, key)) return undefined;
      return this.data[key];
    }

    has(key) { return Object.prototype.hasOwnProperty.call(this.data, key); }

    set(key, value) {
      this.data[key] = value;
      if (this.onChange) this.onChange(key, value);
    }

    /** 重命名字段，返回是否真的发生了变化 */
    renameKey(oldKey, newKey) {
      if (oldKey === newKey || !this.has(oldKey)) return false;
      if (this.has(newKey)) throw new Error('黑板已存在字段：' + newKey);
      const value = this.data[oldKey];
      delete this.data[oldKey];
      this.data[newKey] = value;
      if (this.onChange) this.onChange(newKey, value);
      return true;
    }

    remove(key) {
      if (this.has(key)) {
        delete this.data[key];
        if (this.onChange) this.onChange(key, undefined);
        return true;
      }
      return false;
    }

    entries() { return Object.entries(this.data); }

    snapshot() { return BTUtils.deepClone(this.data); }

    load(entries) {
      this.data = entries ? BTUtils.deepClone(entries) : {};
      if (this.onChange) this.onChange(null, null);
    }
  }

  const api = { Blackboard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTBlackboard = api;
})(typeof window !== 'undefined' ? window : globalThis);
