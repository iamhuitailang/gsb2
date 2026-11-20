/* 项目文件模型：多行为树 + 黑板 + 调试场景，负责保存/导出/导入/重命名引用修复 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'bt-debug-tool.project.v1';
  const PROJECT_VERSION = 1;

  /** 按节点类型创建默认参数 */
  function defaultParams(type) {
    if (type === 'condition') return { key: '', op: '==', value: '' };
    if (type === 'loop') return { count: 3 };
    if (type === 'action') {
      const firstType = Object.keys(BTSim.ACTION_TYPES)[0];
      return Object.assign({ actionType: firstType }, BTUtils.deepClone(BTSim.ACTION_TYPES[firstType].params));
    }
    return {};
  }

  /** 创建新节点（id 稳定，所有连线与引用都基于 id，因此重命名不会丢引用） */
  function createNode(type, name, x, y, extraParams) {
    const meta = BTEngineNS.NODE_TYPES[type];
    const node = {
      id: BTUtils.uid('node'),
      type,
      name: name || meta.label,
      params: defaultParams(type),
      x: x || 0,
      y: y || 0
    };
    if (extraParams) Object.assign(node.params, extraParams);
    return node;
  }

  function createEdge(parentId, childId) {
    return { id: BTUtils.uid('edge'), from: parentId, to: childId };
  }

  function createTree(name) {
    return { id: BTUtils.uid('tree'), name: name || '新行为树', nodes: [], edges: [] };
  }

  function createProject() {
    return {
      version: PROJECT_VERSION,
      activeTreeId: null,
      trees: [],
      blackboard: BTSim.defaultBlackboard(),
      scene: BTSim.defaultScene()
    };
  }

  /* ---------------- 重命名时的引用修复 ---------------- */

  /** 重命名黑板字段：同步修改项目中所有行为树的条件节点引用 */
  function renameBlackboardKey(project, oldKey, newKey) {
    if (!newKey || oldKey === newKey) return false;
    if (Object.prototype.hasOwnProperty.call(project.blackboard, newKey)) {
      throw new Error('黑板已存在字段「' + newKey + '」');
    }
    const value = project.blackboard[oldKey];
    delete project.blackboard[oldKey];
    project.blackboard[newKey] = value;
    for (const tree of project.trees) {
      for (const node of tree.nodes) {
        if (node.type === 'condition' && node.params.key === oldKey) {
          node.params.key = newKey;
        }
        if (node.type === 'action' && node.params.actionType === 'setBlackboard' && node.params.key === oldKey) {
          node.params.key = newKey;
        }
      }
    }
    return true;
  }

  /** 切换动作类型时，把参数重置为该动作的默认参数（保留 actionType） */
  function actionParamsFor(actionType) {
    const meta = BTSim.ACTION_TYPES[actionType];
    return meta ? BTUtils.deepClone(meta.params) : {};
  }

  /* ---------------- 持久化 ---------------- */

  function saveToStorage(project) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      return true;
    } catch (e) {
      console.error('保存失败', e);
      return false;
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeProject(JSON.parse(raw));
    } catch (e) {
      console.error('读取本地项目失败', e);
      return null;
    }
  }

  function clearStorage() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /** 导入/历史数据兜底：补齐缺失字段，保证结构完整 */
  function normalizeProject(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.trees)) {
      throw new Error('项目文件格式不正确：缺少 trees 数组');
    }
    p.version = p.version || PROJECT_VERSION;
    p.trees = p.trees.map((t) => ({
      id: t.id || BTUtils.uid('tree'),
      name: t.name || '未命名行为树',
      nodes: Array.isArray(t.nodes) ? t.nodes : [],
      edges: Array.isArray(t.edges) ? t.edges : []
    }));
    if (p.trees.length === 0) {
      p.trees.push(createTree('行为树 1'));
    }
    // 清掉悬空连线
    for (const t of p.trees) {
      const ids = new Set(t.nodes.map((n) => n.id));
      t.edges = t.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      for (const n of t.nodes) {
        n.params = n.params || {};
        if (n.type === 'condition') {
          n.params.key = n.params.key || '';
          n.params.op = n.params.op || '==';
          n.params.value = n.params.value != null ? n.params.value : '';
        }
      }
    }
    if (!p.activeTreeId || !p.trees.some((t) => t.id === p.activeTreeId)) {
      p.activeTreeId = p.trees[0] ? p.trees[0].id : null;
    }
    p.blackboard = Object.assign(BTSim.defaultBlackboard(), p.blackboard || {});
    p.scene = Object.assign(BTSim.defaultScene(), p.scene || {});
    return p;
  }

  function exportFile(project) {
    const name = 'behavior-tree-project-' + new Date().toISOString().slice(0, 10) + '.json';
    BTUtils.downloadText(name, JSON.stringify(project, null, 2), 'application/json');
    return name;
  }

  function parseImport(text) {
    return normalizeProject(JSON.parse(text));
  }

  const api = {
    STORAGE_KEY, PROJECT_VERSION,
    createProject, createTree, createNode, createEdge,
    defaultParams, actionParamsFor, renameBlackboardKey,
    saveToStorage, loadFromStorage, clearStorage,
    normalizeProject, exportFile, parseImport
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTProject = api;
})(typeof window !== 'undefined' ? window : globalThis);
