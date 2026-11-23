/*
 * 小地图补给/占领规则引擎（纯函数、无随机、可重放）
 *
 * 每回合严格按以下顺序结算：
 *   0. 工程   —— block / unblock 路段
 *   1. 移动   —— 先 retreat（向己方基地撤一步），再 move
 *   2. 争夺   —— 同格双方单位交战：少方全灭，多方损失同等数量；相等则同归于尽
 *   3. 归属   —— 普通区域被单方驻军时自动易主；据点/基地需要 capture 指令
 *   4. 补给   —— 从己方基地出发，沿未封锁路段、穿过己方区域 BFS；
 *                据点断供则计数 +1（保留归属），达到阈值才失效（归属→中立、守军撤离）；
 *                恢复供应当轮计数清零。归属变化先于补给结算，因此同一轮内
 *                “路被换手 / 基地失守 / 重新接通” 都会在当轮补给中体现。
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Engine = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIDES = ['A', 'B'];
  const other = (s) => (s === 'A' ? 'B' : 'A');

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  // 键序稳定的序列化，用于重放一致性校验
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  // scenario: { config:{supplyThreshold}, nodes:[{id,x,y,kind,baseOf,owner,units:{A,B}}], edges:[{a,b,blocked}] }
  function createState(scenario) {
    const s = deepClone(scenario);
    const state = {
      config: Object.assign({ supplyThreshold: 2 }, s.config),
      nodes: {},
      edges: [],
    };
    for (const n of s.nodes) {
      state.nodes[n.id] = {
        id: n.id, x: n.x, y: n.y,
        kind: n.kind || 'plain',            // base | strong | plain
        baseOf: n.baseOf || null,           // 仅基地：'A' | 'B'
        owner: n.owner || 'N',              // 'A' | 'B' | 'N'
        units: { A: (n.units && n.units.A) || 0, B: (n.units && n.units.B) || 0 },
        unsupplied: 0,                      // 连续断供计数（仅据点使用）
      };
    }
    state.edges = s.edges.map(e => ({ a: e.a, b: e.b, blocked: !!e.blocked }));
    return state;
  }

  function edgeBetween(state, a, b) {
    return state.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a)) || null;
  }

  function neighbors(state, id) {
    const out = [];
    for (const e of state.edges) {
      if (e.a === id) out.push(e.b);
      else if (e.b === id) out.push(e.a);
    }
    return out;
  }

  function sortedNodes(state) {
    return Object.values(state.nodes).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  /*
   * 计算某方补给：从“仍归己方所有的己方基地”出发，沿未封锁路段、只穿过己方区域。
   * 返回 { supplied:Set, parent:{}, breaks:[{from,to,reason}], hasBase }
   * breaks 是补给区边界的断点：reason = 'blocked' | 'owner:A' | 'owner:B' | 'owner:N'
   * 两条路通同一据点时，断一条不影响 BFS 结果 —— 不会误判掉线。
   */
  function computeSupply(state) {
    const out = {};
    for (const F of SIDES) {
      const supplied = new Set();
      const parent = {};
      const breaks = [];
      const seenBreak = new Set();
      const base = sortedNodes(state).find(n => n.kind === 'base' && n.baseOf === F && n.owner === F);
      if (base) {
        supplied.add(base.id);
        parent[base.id] = null;
        const q = [base.id];
        while (q.length) {
          const cur = q.shift();
          for (const nb of neighbors(state, cur)) {
            if (supplied.has(nb)) continue;
            const e = edgeBetween(state, cur, nb);
            const nn = state.nodes[nb];
            let reason = null;
            if (e.blocked) reason = 'blocked';
            else if (nn.owner !== F) reason = 'owner:' + nn.owner;
            if (reason) {
              const key = [cur, nb].sort().join('|');
              if (!seenBreak.has(key)) { seenBreak.add(key); breaks.push({ from: cur, to: nb, reason }); }
              continue;
            }
            supplied.add(nb);
            parent[nb] = cur;
            q.push(nb);
          }
        }
      }
      out[F] = { supplied, parent, breaks, hasBase: !!base };
    }
    return out;
  }

  // 从 nodeId 沿 parent 链还原补给路径（含两端）；无路径返回 null
  function supplyPath(sup, side, nodeId) {
    const p = sup[side].parent;
    if (!(nodeId in p)) return null;
    const path = [nodeId];
    let cur = nodeId;
    while (p[cur] !== null && p[cur] !== undefined) { cur = p[cur]; path.push(cur); }
    return path.reverse();
  }

  // 撤离：从己方基地 BFS（只避开封锁路段），返回 nodeId 向基地方向的第一步
  function nextStepToBase(state, side, nodeId) {
    const base = sortedNodes(state).find(n => n.kind === 'base' && n.baseOf === side && n.owner === side);
    if (!base || base.id === nodeId) return null;
    const prev = { [base.id]: null };
    const q = [base.id];
    while (q.length) {
      const cur = q.shift();
      for (const nb of neighbors(state, cur)) {
        if (nb in prev) continue;
        const e = edgeBetween(state, cur, nb);
        if (e.blocked) continue;
        prev[nb] = cur;
        q.push(nb);
      }
    }
    return (nodeId in prev) ? prev[nodeId] : null;
  }

  // 解析一行指令文本，返回指令对象；注释/空行返回 null；非法行抛错
  function parseOrderLine(line) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return null;
    const p = t.split(/\s+/);
    const side = (p[0] || '').toUpperCase();
    if (side !== 'A' && side !== 'B') throw new Error(`未知方“${p[0]}”（应为 A 或 B）`);
    const type = (p[1] || '').toLowerCase();
    switch (type) {
      case 'move': {
        if (!p[2] || !p[3]) throw new Error('move 需要：起点 终点 [数量]');
        const count = p[4] === undefined ? 1 : parseInt(p[4], 10);
        if (!Number.isInteger(count) || count <= 0) throw new Error(`移动数量无效：“${p[4]}”`);
        return { side, type, from: p[2], to: p[3], count };
      }
      case 'retreat':
        if (!p[2]) throw new Error('retreat 需要：节点');
        return { side, type, node: p[2] };
      case 'capture':
        if (!p[2]) throw new Error('capture 需要：节点');
        return { side, type, node: p[2] };
      case 'block':
      case 'unblock':
        if (!p[2] || !p[3]) throw new Error(`${type} 需要：节点1 节点2`);
        return { side, type, a: p[2], b: p[3] };
      default:
        throw new Error(`未知指令“${p[1] || ''}”（move/retreat/capture/block/unblock）`);
    }
  }

  function parseRound(lines) {
    const orders = [];
    for (const line of lines) {
      const o = parseOrderLine(line);
      if (o) orders.push(o);
    }
    return orders;
  }

  /*
   * 推进一回合。prevState 不被修改；返回 { state, events }。
   * events: [{ phase, text, nodes:[id...] }] —— nodes 用于图上高亮“哪些格变了”。
   */
  function applyRound(prevState, orders) {
    const state = deepClone(prevState);
    const events = [];
    const ev = (phase, text, nodes) => events.push({ phase, text, nodes: nodes || [] });
    const th = state.config.supplyThreshold;

    // ---- 阶段 0：工程（封锁/修复路段）----
    for (const o of orders.filter(o => o.type === 'block' || o.type === 'unblock')) {
      const e = edgeBetween(state, o.a, o.b);
      if (!e) { ev('工程', `拒绝：路段 ${o.a}-${o.b} 不存在`, [o.a, o.b]); continue; }
      const want = o.type === 'block';
      if (e.blocked === want) { ev('工程', `路段 ${o.a}-${o.b} 已${want ? '封锁' : '畅通'}，指令无效`, [o.a, o.b]); continue; }
      e.blocked = want;
      ev('工程', `${o.side}方${want ? '封锁' : '修复'}了路段 ${o.a}-${o.b}`, [o.a, o.b]);
    }

    // ---- 阶段 1：移动（先撤离，后机动）----
    for (const o of orders.filter(o => o.type === 'retreat')) {
      const n = state.nodes[o.node];
      if (!n) { ev('移动', `拒绝：节点 ${o.node} 不存在`, []); continue; }
      const cnt = n.units[o.side];
      if (cnt <= 0) { ev('移动', `${o.side}在${o.node}没有单位，撤离无效`, [o.node]); continue; }
      const step = nextStepToBase(state, o.side, o.node);
      if (!step) { ev('移动', `${o.node} 找不到回${o.side}基地的通路，无法撤离`, [o.node]); continue; }
      n.units[o.side] -= cnt;
      state.nodes[step].units[o.side] += cnt;
      ev('移动', `${o.side}从 ${o.node} 撤离 ${cnt} 个单位到 ${step}`, [o.node, step]);
    }
    for (const o of orders.filter(o => o.type === 'move')) {
      const from = state.nodes[o.from], to = state.nodes[o.to];
      if (!from || !to) { ev('移动', `拒绝：节点 ${!from ? o.from : o.to} 不存在`, []); continue; }
      const e = edgeBetween(state, o.from, o.to);
      if (!e) { ev('移动', `拒绝：${o.from} 与 ${o.to} 不相邻`, [o.from, o.to]); continue; }
      if (e.blocked) { ev('移动', `拒绝：路段 ${o.from}-${o.to} 被封锁`, [o.from, o.to]); continue; }
      const cnt = Math.min(o.count, from.units[o.side]);
      if (cnt <= 0) { ev('移动', `拒绝：${o.side}在 ${o.from} 没有可移动单位`, [o.from]); continue; }
      from.units[o.side] -= cnt;
      to.units[o.side] += cnt;
      ev('移动', `${o.side} ${o.from} → ${o.to}：移动 ${cnt} 个单位`, [o.from, o.to]);
    }

    // ---- 阶段 2：同格争夺 ----
    for (const n of sortedNodes(state)) {
      const a = n.units.A, b = n.units.B;
      if (a > 0 && b > 0) {
        if (a === b) {
          n.units.A = 0; n.units.B = 0;
          ev('争夺', `${n.id}：A${a} 对 B${b}，势均力敌同归于尽`, [n.id]);
        } else if (a > b) {
          n.units.A = a - b; n.units.B = 0;
          ev('争夺', `${n.id}：A${a} 对 B${b}，B全灭，A剩 ${a - b}`, [n.id]);
        } else {
          n.units.B = b - a; n.units.A = 0;
          ev('争夺', `${n.id}：B${b} 对 A${a}，A全灭，B剩 ${b - a}`, [n.id]);
        }
      }
    }

    // ---- 阶段 3：归属 ----
    // 3a. 普通区域：只剩单方驻军时自动易主
    for (const n of sortedNodes(state)) {
      if (n.kind !== 'plain') continue;
      const onlyA = n.units.A > 0 && n.units.B === 0;
      const onlyB = n.units.B > 0 && n.units.A === 0;
      const want = onlyA ? 'A' : onlyB ? 'B' : null;
      if (want && n.owner !== want) {
        ev('归属', `${n.id} 仅剩${want}方驻军，普通区域自动易主（${n.owner} → ${want}）`, [n.id]);
        n.owner = want;
        n.unsupplied = 0;
      }
    }
    // 3b. 据点/基地：需要 capture 指令
    for (const o of orders.filter(o => o.type === 'capture')) {
      const n = state.nodes[o.node];
      if (!n) { ev('归属', `拒绝：节点 ${o.node} 不存在`, []); continue; }
      if (n.kind === 'plain') { ev('归属', `${o.node} 是普通区域，无需占领指令（驻军即易主）`, [o.node]); continue; }
      if (n.units[o.side] <= 0) { ev('归属', `拒绝：${o.side}在 ${o.node} 没有单位，无法占领`, [o.node]); continue; }
      if (n.units[other(o.side)] > 0) { ev('归属', `拒绝：${o.node} 仍有敌方单位，争夺未决`, [o.node]); continue; }
      if (n.owner === o.side) { ev('归属', `${o.node} 已归属${o.side}，占领指令无效`, [o.node]); continue; }
      const old = n.owner;
      n.owner = o.side;
      n.unsupplied = 0;
      ev('归属', `${o.side}占领了${n.kind === 'base' ? '基地' : '据点'} ${o.node}（${old} → ${o.side}）`, [o.node]);
      if (n.kind === 'base' && n.baseOf && n.baseOf !== o.side) {
        ev('归属', `${n.baseOf}方基地失守，其补给网将在本轮补给阶段重算`, [o.node]);
      }
    }

    // ---- 阶段 4：补给（在全部归属变化之后统一结算，同轮换手即时生效）----
    const sup = computeSupply(state);
    for (const n of sortedNodes(state)) {
      if (n.kind !== 'strong') continue;
      if (n.owner === 'N') { n.unsupplied = 0; continue; }
      if (sup[n.owner].supplied.has(n.id)) {
        if (n.unsupplied > 0) {
          ev('补给', `${n.id} 恢复补给（断供计数 ${n.unsupplied} → 0），归属保持${n.owner}`, [n.id]);
        }
        n.unsupplied = 0;
      } else {
        n.unsupplied++;
        const remain = th - n.unsupplied;
        if (remain > 0) {
          const why = sup[n.owner].hasBase ? '补给线中断' : '己方基地失守';
          ev('补给', `${n.id} 断供（${n.unsupplied}/${th}，${why}），归属仍为${n.owner}，再断 ${remain} 轮即失效`, [n.id]);
        } else {
          const old = n.owner;
          n.units[old] = 0; // 守军撤离
          n.owner = 'N';
          n.unsupplied = 0;
          ev('补给', `${n.id} 连续断供达 ${th} 轮，据点失效：守军撤离，归属 ${old} → 中立`, [n.id]);
        }
      }
    }

    return { state, events };
  }

  /*
   * 从场景 + 每轮指令文本重放全部历史。
   * 返回 [{ state, events, orders }] —— 下标即轮次（0 为初始布局）。
   * 纯函数：同样输入必然得到同样输出。
   */
  function replay(scenario, roundLines) {
    const hist = [{ state: createState(scenario), events: [], orders: [] }];
    for (const lines of roundLines) {
      let orders;
      try {
        orders = parseRound(lines);
      } catch (err) {
        const bad = { phase: '系统', text: `指令解析失败：${err.message}`, nodes: [] };
        hist.push({ state: deepClone(hist[hist.length - 1].state), events: [bad], orders: lines.slice() });
        continue;
      }
      const { state, events } = applyRound(hist[hist.length - 1].state, orders);
      hist.push({ state, events, orders: lines.slice() });
    }
    return hist;
  }

  return {
    SIDES, createState, computeSupply, supplyPath, applyRound, replay,
    parseOrderLine, parseRound, edgeBetween, neighbors, stableStringify, deepClone,
  };
});
