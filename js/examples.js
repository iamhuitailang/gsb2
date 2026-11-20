/* 示例工程：巡逻、发现目标、返回路线三个可切换的行为树 */
(function (global) {
  'use strict';

  function node(type, name, x, y, params) {
    const n = BTProject.createNode(type, name, x, y);
    if (params) Object.assign(n.params, params);
    return n;
  }

  function link(tree, parentId, childId) {
    const e = BTProject.createEdge(parentId, childId);
    tree.edges.push(e);
    return e;
  }

  /** 示例 1：巡逻——循环执行「走向下一个巡逻点 → 停留观察 → 记录日志」 */
  function buildPatrolTree() {
    const tree = BTProject.createTree('示例-巡逻');
    const root = node('loop', '无限巡逻', 360, 40, { count: 0 });
    const seq = node('sequence', '巡逻一轮', 360, 130);
    const move = node('action', '巡逻下一点', 160, 230,
      { actionType: 'patrol', speed: 50 });
    const wait = node('action', '原地观察', 360, 230,
      { actionType: 'wait', duration: 800 });
    const log = node('action', '记录巡逻日志', 560, 230,
      { actionType: 'log', text: '巡逻点巡查完毕' });
    tree.nodes.push(root, seq, move, wait, log);
    link(tree, root.id, seq.id);
    link(tree, seq.id, move.id);
    link(tree, seq.id, wait.id);
    link(tree, seq.id, log.id);
    return tree;
  }

  /** 示例 2：发现目标——看见玩家就追击并更新黑板，否则继续巡逻 */
  function buildDiscoverTree() {
    const tree = BTProject.createTree('示例-发现目标');
    const root = node('selector', '发现目标决策', 380, 40);

    const chaseSeq = node('sequence', '追击分支', 220, 130);
    const canSee = node('condition', '玩家在视野内', 40, 230,
      { key: 'playerVisible', op: '==', value: 'true' });
    const markState = node('action', '标记战斗状态', 200, 230,
      { actionType: 'setBlackboard', key: 'state', value: 'combat', mode: 'assign', modulo: '' });
    const chase = node('action', '追击玩家', 360, 230,
      { actionType: 'goto', target: 'player', speed: 90 });

    const patrolSeq = node('sequence', '巡逻分支', 620, 130);
    const cantSee = node('condition', '玩家不在视野', 490, 230,
      { key: 'playerVisible', op: '==', value: 'false' });
    const markPatrol = node('action', '标记巡逻状态', 650, 230,
      { actionType: 'setBlackboard', key: 'state', value: 'patrol', mode: 'assign', modulo: '' });
    const patrol = node('action', '继续巡逻', 810, 230,
      { actionType: 'patrol', speed: 50 });

    tree.nodes.push(root, chaseSeq, canSee, markState, chase, patrolSeq, cantSee, markPatrol, patrol);
    link(tree, root.id, chaseSeq.id);
    link(tree, chaseSeq.id, canSee.id);
    link(tree, chaseSeq.id, markState.id);
    link(tree, chaseSeq.id, chase.id);
    link(tree, root.id, patrolSeq.id);
    link(tree, patrolSeq.id, cantSee.id);
    link(tree, patrolSeq.id, markPatrol.id);
    link(tree, patrolSeq.id, patrol.id);
    return tree;
  }

  /** 示例 3：返回路线——丢失目标后回家，复位状态，再重新巡逻 */
  function buildReturnTree() {
    const tree = BTProject.createTree('示例-返回路线');
    const root = node('selector', '返回路线决策', 380, 40);

    const returnSeq = node('sequence', '回家分支', 200, 130);
    const lost = node('condition', '目标已丢失', 40, 230,
      { key: 'playerVisible', op: '==', value: 'false' });
    const goHome = node('action', '返回家', 200, 230,
      { actionType: 'goto', target: 'home', speed: 70 });
    const resetState = node('action', '复位状态', 360, 230,
      { actionType: 'setBlackboard', key: 'state', value: 'idle', mode: 'assign', modulo: '' });
    const resetIndex = node('action', '巡逻索引归零', 520, 230,
      { actionType: 'setBlackboard', key: 'patrolIndex', value: '0', mode: 'assign', modulo: '' });
    const homeLog = node('action', '到家日志', 680, 230,
      { actionType: 'log', text: '已安全返回家，重新开始巡逻' });

    const guardSeq = node('sequence', '警戒分支', 820, 130);
    const see = node('condition', '仍能看见玩家', 760, 230,
      { key: 'playerVisible', op: '==', value: 'true' });
    const keepWatch = node('action', '原地警戒', 920, 230,
      { actionType: 'wait', duration: 500 });

    tree.nodes.push(root, returnSeq, lost, goHome, resetState, resetIndex, homeLog, guardSeq, see, keepWatch);
    link(tree, root.id, returnSeq.id);
    link(tree, returnSeq.id, lost.id);
    link(tree, returnSeq.id, goHome.id);
    link(tree, returnSeq.id, resetState.id);
    link(tree, returnSeq.id, resetIndex.id);
    link(tree, returnSeq.id, homeLog.id);
    link(tree, root.id, guardSeq.id);
    link(tree, guardSeq.id, see.id);
    link(tree, guardSeq.id, keepWatch.id);
    return tree;
  }

  function buildExampleProject() {
    const project = BTProject.createProject();
    project.trees = [buildPatrolTree(), buildDiscoverTree(), buildReturnTree()];
    project.activeTreeId = project.trees[0].id;
    project.blackboard = BTSim.defaultBlackboard();
    project.scene = BTSim.defaultScene();
    return project;
  }

  const api = { buildExampleProject, buildPatrolTree, buildDiscoverTree, buildReturnTree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BTExamples = api;
})(typeof window !== 'undefined' ? window : globalThis);
