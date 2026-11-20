/* 行为树引擎：节点语义、树结构校验、逐 tick 调度（纯逻辑，无 DOM 依赖） */
(function (global) {
  'use strict';

  const STATUS = { IDLE: 'idle', SUCCESS: 'success', FAILURE: 'failure', RUNNING: 'running' };

  /** 节点类型目录：label 中文名，leaf 是否叶子，color 用于 UI 配色 */
  const NODE_TYPES = {
    sequence:  { label: '顺序',   leaf: false, color: '#7db3ff', desc: '依次执行子节点；一个失败即失败，全部成功才成功' },
    selector:  { label: '选择',   leaf: false, color: '#b58cff', desc: '依次尝试子节点；一个成功即成功，全部失败才失败' },
    condition: { label: '条件',   leaf: true,  color: '#4dd0c0', desc: '读取黑板字段做比较，成立返回成功，否则失败' },
    action:    { label: '动作',   leaf: true,  color: '#ffb454', desc: '执行模拟动作，可返回成功 / 失败 / 运行中' },
    loop:      { label: '循环',   leaf: false, color: '#f078b8', desc: '重复执行唯一子节点 N 次（0 表示无限循环）' }
  };

  const OPS = ['==', '!=', '>', '>=', '<', '<='];

  /* ---------------- 树结构工具函数 ---------------- */

  function buildParentMap(tree) {
    const map = {};
    for (const e of tree.edges) map[e.to] = e.from;
    return map;
  }

  function getChildren(tree, nodeId) {
    return tree.edges
      .filter((e) => e.from === nodeId)
      .map((e) => tree.nodes.find((n) => n.id === e.to))
      .filter(Boolean);
  }

  function getParentEdge(tree, nodeId) {
    return tree.edges.find((e) => e.to === nodeId) || null;
  }

  function findRoots(tree) {
    const parentMap = buildParentMap(tree);
    return tree.nodes.filter((n) => !parentMap[n.id]);
  }

  /** 连线合法性校验：parentId -> childId，返回 { ok, reason } */
  function validateConnection(tree, parentId, childId) {
    const parent = tree.nodes.find((n) => n.id === parentId);
    const child = tree.nodes.find((n) => n.id === childId);
    if (!parent || !child) return { ok: false, reason: '节点不存在，无法连接' };
    if (parentId === childId) return { ok: false, reason: '不能把节点连接到自身' };

    if (NODE_TYPES[parent.type] && NODE_TYPES[parent.type].leaf) {
      return { ok: false, reason: `「${parent.name}」是${NODE_TYPES[parent.type].label}叶子节点，不能再挂子节点` };
    }
    if (parent.type === 'loop') {
      const hasChild = tree.edges.some((e) => e.from === parentId);
      if (hasChild) return { ok: false, reason: '循环节点只允许一个子节点，请先删除原有连线' };
    }
    const oldEdge = getParentEdge(tree, childId);
    if (oldEdge && oldEdge.from !== parentId) {
      return { ok: false, reason: `「${child.name}」已经有父节点了；树中每个节点只能有一个父节点，请先删除它的旧连线` };
    }
    if (oldEdge) return { ok: false, reason: '这两个节点之间已经存在连线' };

    // 环检测：若 childId 是 parentId 的祖先，连上就成环
    const parentMap = buildParentMap(tree);
    let cur = parentId;
    const guard = new Set();
    while (cur) {
      if (cur === childId) {
        return { ok: false, reason: '不能连接：该连线会让树出现环，行为树必须保持树结构' };
      }
      if (guard.has(cur)) return { ok: false, reason: '当前树中已存在环，结构已损坏' };
      guard.add(cur);
      cur = parentMap[cur];
    }
    return { ok: true, reason: '' };
  }

  /** 整棵树的运行前校验，返回 { valid, errors:[{nodeId,message}], warnings:[...] } */
  function validateTree(tree) {
    const errors = [];
    const warnings = [];
    if (tree.nodes.length === 0) {
      errors.push({ nodeId: null, message: '当前行为树没有任何节点' });
      return { valid: false, errors, warnings };
    }
    const roots = findRoots(tree);
    if (roots.length === 0) {
      errors.push({ nodeId: null, message: '找不到根节点：所有节点都被连成了环' });
    } else if (roots.length > 1) {
      errors.push({
        nodeId: null,
        message: `存在 ${roots.length} 个没有父节点的根节点（${roots.map((r) => `「${r.name}」`).join('、')}），一棵树只能有一个根`
      });
    }
    const parentMap = buildParentMap(tree);
    for (const node of tree.nodes) {
      const children = getChildren(tree, node.id);
      if (node.type === 'sequence' || node.type === 'selector') {
        if (children.length === 0) {
          errors.push({ nodeId: node.id, message: `「${node.name}」是${NODE_TYPES[node.type].label}节点，至少需要一个子节点` });
        }
      } else if (node.type === 'loop') {
        if (children.length === 0) {
          errors.push({ nodeId: node.id, message: `「${node.name}」是循环节点，需要一个子节点` });
        } else if (children.length > 1) {
          errors.push({ nodeId: node.id, message: `「${node.name}」是循环节点，只能有一个子节点` });
        }
        const count = Number(node.params.count);
        if (node.params.count !== '' && (Number.isNaN(count) || count < 0)) {
          errors.push({ nodeId: node.id, message: `「${node.name}」的循环次数必须是 >=0 的整数（0 为无限循环）` });
        }
      } else if (NODE_TYPES[node.type].leaf) {
        if (children.length > 0) {
          errors.push({ nodeId: node.id, message: `「${node.name}」是叶子节点，不能连接子节点` });
        }
      }
      if (node.type === 'condition') {
        if (!node.params.key) {
          errors.push({ nodeId: node.id, message: `条件节点「${node.name}」没有选择黑板字段` });
        }
      }
      if (node.type === 'action' && !node.params.actionType) {
        errors.push({ nodeId: node.id, message: `动作节点「${node.name}」没有选择动作类型` });
      }
      if (!parentMap[node.id] && roots.length > 1) {
        // 多根情况已在上面汇总报错
      }
    }
    if (roots.length === 1) {
      const reachable = new Set();
      const walk = (id) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        getChildren(tree, id).forEach((c) => walk(c.id));
      };
      walk(roots[0].id);
      const orphans = tree.nodes.filter((n) => !reachable.has(n.id));
      for (const o of orphans) {
        warnings.push({ nodeId: o.id, message: `「${o.name}」没有挂到根节点上，运行时不会执行` });
      }
    } else if (roots.length > 1) {
      // 多根时，除第一个根外的整棵子树都不会被执行
      for (const extra of roots.slice(1)) {
        warnings.push({ nodeId: extra.id, message: `「${extra.name}」及其子树没有挂到主根节点上，运行时不会执行` });
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /* ---------------- 引擎 ---------------- */

  class BTEngine {
    /**
     * @param tree 行为树数据 { id, name, nodes, edges }
     * @param blackboard Blackboard 实例
     * @param actionHandlers 动作类型 -> handler 函数映射
     * @param logger { log(level, msg) }
     */
    constructor(tree, blackboard, actionHandlers, logger) {
      this.tree = tree;
      this.bb = blackboard;
      this.handlers = actionHandlers || {};
      this.logger = logger || { log() {} };
      this.tickCount = 0;
      this.states = {};       // nodeId -> { status, data:{} }
      this.edgeStates = {};   // edgeId -> status
      this.activePath = new Set();
      this.lastRootStatus = STATUS.IDLE;
      this._resetAllStates();
    }

    setTree(tree) {
      this.tree = tree;
      this.reset();
    }

    _resetAllStates() {
      this.states = {};
      for (const n of this.tree.nodes) {
        this.states[n.id] = { status: STATUS.IDLE, data: {} };
      }
      this.edgeStates = {};
      this.activePath = new Set();
    }

    reset() {
      this.tickCount = 0;
      this.lastRootStatus = STATUS.IDLE;
      this._resetAllStates();
    }

    getState(nodeId) {
      if (!this.states[nodeId]) this.states[nodeId] = { status: STATUS.IDLE, data: {} };
      return this.states[nodeId];
    }

    resetSubtree(nodeId) {
      const state = this.getState(nodeId);
      state.status = STATUS.IDLE;
      state.data = {};
      for (const child of getChildren(this.tree, nodeId)) {
        this.resetSubtree(child.id);
      }
    }

    /** 推进一个 tick，dt 为距上一 tick 的毫秒数 */
    tick(dt, ctx) {
      const roots = findRoots(this.tree);
      this.visited = new Set();
      if (roots.length !== 1) {
        this.logger.log('warn', '行为树结构不合法，无法运行，请先修复红色报错');
        return STATUS.FAILURE;
      }
      const rootStatus = this._visit(roots[0], dt, ctx || {});
      this.lastRootStatus = rootStatus;

      // 本 tick 没走到的节点（被选择/顺序节点短路掉的分支）复位，保证下次重新进入
      for (const node of this.tree.nodes) {
        if (!this.visited.has(node.id) && this.states[node.id] && this.states[node.id].status !== STATUS.IDLE) {
          this.resetSubtree(node.id);
        }
      }
      // 连线状态跟随子节点
      for (const e of this.tree.edges) {
        const childState = this.states[e.to];
        this.edgeStates[e.id] = this.visited.has(e.to) && childState ? childState.status : STATUS.IDLE;
      }
      // 高亮运行中节点及其祖先链
      this.activePath = new Set();
      const parentMap = buildParentMap(this.tree);
      for (const node of this.tree.nodes) {
        if (this.states[node.id] && this.states[node.id].status === STATUS.RUNNING) {
          let cur = node.id;
          while (cur) {
            this.activePath.add(cur);
            cur = parentMap[cur];
          }
        }
      }
      this.tickCount++;
      return rootStatus;
    }

    _visit(node, dt, ctx) {
      this.visited.add(node.id);
      const state = this.getState(node.id);
      let result;
      switch (node.type) {
        case 'sequence': result = this._visitSequence(node, dt, ctx); break;
        case 'selector': result = this._visitSelector(node, dt, ctx); break;
        case 'loop': result = this._visitLoop(node, dt, ctx); break;
        case 'condition': result = this._visitCondition(node); break;
        case 'action': result = this._visitAction(node, dt, ctx); break;
        default:
          this.logger.log('warn', `未知节点类型：${node.type}`);
          result = STATUS.FAILURE;
      }
      state.status = result;
      return result;
    }

    _visitSequence(node, dt, ctx) {
      for (const child of getChildren(this.tree, node.id)) {
        const s = this._visit(child, dt, ctx);
        if (s === STATUS.RUNNING || s === STATUS.FAILURE) return s;
      }
      return STATUS.SUCCESS;
    }

    _visitSelector(node, dt, ctx) {
      for (const child of getChildren(this.tree, node.id)) {
        const s = this._visit(child, dt, ctx);
        if (s === STATUS.RUNNING || s === STATUS.SUCCESS) return s;
      }
      return STATUS.FAILURE;
    }

    _visitLoop(node, dt, ctx) {
      const state = this.getState(node.id);
      if (state.data.iterations == null) state.data.iterations = 0;
      const target = node.params.count === '' || node.params.count == null
        ? 0 : Math.max(0, Math.floor(Number(node.params.count)));
      const child = getChildren(this.tree, node.id)[0];
      if (!child) return STATUS.FAILURE;

      const s = this._visit(child, dt, ctx);
      if (s === STATUS.RUNNING) return STATUS.RUNNING;
      if (s === STATUS.FAILURE) {
        this.logger.log('warn', `循环「${node.name}」的子节点返回失败，循环中止`);
        return STATUS.FAILURE;
      }
      // 子节点成功：完成一轮，复位子树，下一轮重新进入
      state.data.iterations++;
      this.resetSubtree(child.id);
      if (target > 0 && state.data.iterations >= target) {
        this.logger.log('success', `循环「${node.name}」完成全部 ${target} 次`);
        state.data.iterations = 0;
        return STATUS.SUCCESS;
      }
      return STATUS.RUNNING;
    }

    _visitCondition(node) {
      const { key, op, value } = node.params;
      if (!this.bb.has(key)) {
        this.logger.log('warn', `条件「${node.name}」引用的黑板字段「${key}」不存在，按失败处理`);
        return STATUS.FAILURE;
      }
      const raw = this.bb.get(key);
      const expected = BTUtils.coerceValue(value == null ? '' : value);
      const ok = BTUtils.compare(op || '==', raw, expected);
      return ok ? STATUS.SUCCESS : STATUS.FAILURE;
    }

    _visitAction(node, dt, ctx) {
      const type = node.params.actionType;
      const handler = this.handlers[type];
      if (!handler) {
        this.logger.log('warn', `动作「${node.name}」的动作类型「${type}」没有注册处理器`);
        return STATUS.FAILURE;
      }
      const state = this.getState(node.id);
      const s = handler({
        node,
        params: node.params,
        bb: this.bb,
        ctx,
        data: state.data,
        dt,
        logger: this.logger,
        engine: this
      });
      if (s !== STATUS.SUCCESS && s !== STATUS.FAILURE && s !== STATUS.RUNNING) {
        this.logger.log('warn', `动作「${node.name}」返回了非法状态「${s}」，按失败处理`);
        return STATUS.FAILURE;
      }
      return s;
    }
  }

  const api = {
    STATUS, NODE_TYPES, OPS, BTEngine,
    validateConnection, validateTree,
    buildParentMap, getChildren, getParentEdge, findRoots
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTEngineNS = api;
})(typeof window !== 'undefined' ? window : globalThis);
