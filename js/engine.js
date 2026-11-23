/* 掉落表校验 + 蒙特卡洛模拟引擎 + 版本对比。
 * 纯函数，不依赖 DOM，便于测试与复现。 */
(function (global) {
  'use strict';

  /* ---------------- 配置规范化 ---------------- */

  function defaultConfig() {
    return {
      name: '新方案',
      rules: { expectedWeightTotal: 100 },
      items: [],
    };
  }

  function normalizeItem(raw) {
    const it = {
      id: String(raw.id || '').trim(),
      name: String(raw.name || raw.id || '').trim(),
      weight: Number(raw.weight),
      rare: !!raw.rare,
      pity: raw.pity == null || raw.pity === '' ? null : Number(raw.pity),
      mutexGroup: raw.mutexGroup ? String(raw.mutexGroup).trim() : null,
      maxOwn: raw.maxOwn == null || raw.maxOwn === '' ? null : Number(raw.maxOwn),
      requires: Array.isArray(raw.requires)
        ? raw.requires.map(String).map((s) => s.trim()).filter(Boolean)
        : [],
      convertTo: null,
    };
    if (raw.convertTo && raw.convertTo.item) {
      it.convertTo = {
        item: String(raw.convertTo.item).trim(),
        count: Number(raw.convertTo.count) || 1,
      };
    }
    return it;
  }

  function normalizeConfig(raw) {
    const cfg = defaultConfig();
    if (!raw || typeof raw !== 'object') return cfg;
    cfg.name = String(raw.name || cfg.name);
    cfg.rules = Object.assign({}, cfg.rules, raw.rules || {});
    cfg.rules.expectedWeightTotal = Number(cfg.rules.expectedWeightTotal);
    if (!Number.isFinite(cfg.rules.expectedWeightTotal) || cfg.rules.expectedWeightTotal <= 0) {
      cfg.rules.expectedWeightTotal = 100;
    }
    cfg.items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem);
    return cfg;
  }

  /* 持有上限缺省值：设置了重复转化的物品默认上限 1，其余不限 */
  function effectiveMaxOwn(item) {
    if (item.maxOwn != null && Number.isFinite(item.maxOwn)) return item.maxOwn;
    return item.convertTo ? 1 : Infinity;
  }

  /* ---------------- 校验 ----------------
   * 返回 [{ level: 'error' | 'warn', msg }] ，msg 说明具体原因。 */
  function validateConfig(cfg) {
    const problems = [];
    const err = (msg) => problems.push({ level: 'error', msg });
    const warn = (msg) => problems.push({ level: 'warn', msg });

    if (!cfg.items.length) {
      err('掉落表为空：至少需要 1 个物品。');
      return problems;
    }

    // id 唯一性
    const seen = new Map();
    cfg.items.forEach((it, i) => {
      const label = it.id || `(第 ${i + 1} 行)`;
      if (!it.id) err(`第 ${i + 1} 行物品缺少 id。`);
      else if (seen.has(it.id)) err(`物品 id "${it.id}" 重复（第 ${seen.get(it.id) + 1} 行与第 ${i + 1} 行）。`);
      else seen.set(it.id, i);
      if (!Number.isFinite(it.weight)) err(`物品 "${label}" 的权重不是有效数字。`);
      else if (it.weight < 0) err(`物品 "${label}" 的权重为负数（${it.weight}），权重必须 ≥ 0。`);
      if (it.pity != null && (!Number.isInteger(it.pity) || it.pity < 1)) {
        err(`物品 "${label}" 的保底次数 "${it.pity}" 无效：必须是 ≥ 1 的整数。`);
      }
      if (it.maxOwn != null && (!Number.isInteger(it.maxOwn) || it.maxOwn < 1)) {
        err(`物品 "${label}" 的持有上限 "${it.maxOwn}" 无效：必须是 ≥ 1 的整数。`);
      }
    });

    const ids = new Set(cfg.items.map((i) => i.id));

    // 引用完整性
    cfg.items.forEach((it) => {
      const label = it.id || '(未命名)';
      (it.requires || []).forEach((req) => {
        if (!ids.has(req)) err(`物品 "${label}" 的前置 "${req}" 不存在于掉落表中。`);
        else if (req === it.id) err(`物品 "${label}" 的前置不能是它自己。`);
      });
      if (it.convertTo) {
        if (!ids.has(it.convertTo.item)) err(`物品 "${label}" 的重复转化目标 "${it.convertTo.item}" 不存在。`);
        else if (it.convertTo.item === it.id) err(`物品 "${label}" 的重复转化目标不能是它自己。`);
        if (!(it.convertTo.count > 0)) err(`物品 "${label}" 的转化数量必须 > 0。`);
      }
    });

    // 前置依赖环检测
    const state = {}; // 0=未访问 1=访问中 2=完成
    function dfs(id, path) {
      if (state[id] === 1) {
        err(`前置解锁存在循环依赖：${path.concat(id).join(' → ')}。`);
        return;
      }
      if (state[id] === 2) return;
      state[id] = 1;
      const item = cfg.items.find((i) => i.id === id);
      (item.requires || []).forEach((r) => { if (ids.has(r)) dfs(r, path.concat(id)); });
      state[id] = 2;
    }
    cfg.items.forEach((it) => { if (it.id) dfs(it.id, []); });

    // 权重合计
    const total = cfg.items.reduce((s, i) => s + (Number.isFinite(i.weight) ? i.weight : 0), 0);
    const expected = cfg.rules.expectedWeightTotal;
    if (total <= 0) {
      err('权重合计为 0：没有任何可抽取的物品。');
    } else if (Math.abs(total - expected) > 1e-6) {
      const diff = total - expected;
      err(`权重合计 ${round2(total)} 不符合规则：应为 ${round2(expected)}（${diff > 0 ? '超出' : '缺少'} ${round2(Math.abs(diff))}）。`);
    }

    // 互斥组
    const groups = new Map();
    cfg.items.forEach((it) => {
      if (it.mutexGroup) {
        if (!groups.has(it.mutexGroup)) groups.set(it.mutexGroup, []);
        groups.get(it.mutexGroup).push(it);
      }
    });
    groups.forEach((members, g) => {
      if (members.length < 2) warn(`互斥组 "${g}" 只有 1 个成员（"${members[0].id}"），互斥不会生效。`);
      const drawable = members.filter((m) => m.weight > 0);
      if (drawable.length < 2) warn(`互斥组 "${g}" 中可抽取成员不足 2 个。`);
    });

    // 永不可获得的物品提示
    cfg.items.forEach((it) => {
      if (it.weight === 0 && !it.pity && !cfg.items.some((o) => o.convertTo && o.convertTo.item === it.id)) {
        warn(`物品 "${it.id}" 权重为 0、无保底、也不是任何转化目标，模拟中永远不会出现。`);
      }
    });

    return problems;
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /* ---------------- 模拟 ----------------
   * 规则（每局 1 次抽取）：
   *  - 候选池 = 权重>0 且前置已解锁 且未被互斥组排除 的物品；
   *  - 保底：某物品连续未抽中次数达到 pity 时，下一次抽取强制命中（多个同时到期取最久未中的）；
   *  - 互斥组：已拥有组内任一物品（达到其持有上限的拥有）时，组内其他物品从候选池排除；
   *  - 重复：获得数达到持有上限后，再次抽中按 convertTo 转化为其他物品，无转化则丢弃。
   * 返回结果含每个物品的获得分布、首次获得局数、按局累计概率，以及稀有覆盖率曲线。 */
  function simulate(cfg, params) {
    const players = Math.max(1, Math.floor(params.players || 10000));
    const rounds = Math.max(1, Math.floor(params.rounds || 100));
    const rng = RNG.mulberry32(RNG.normalizeSeed(params.seed == null ? 1 : params.seed));

    const items = cfg.items;
    const drawable = items.filter((i) => i.weight > 0 || i.pity);
    const pityItems = drawable.filter((i) => i.pity != null && i.pity >= 1);
    const rareIds = new Set(items.filter((i) => i.rare).map((i) => i.id));
    const groupOf = new Map();
    items.forEach((i) => { if (i.mutexGroup) groupOf.set(i.id, i.mutexGroup); });
    const groupMembers = new Map();
    items.forEach((i) => {
      if (i.mutexGroup) {
        if (!groupMembers.has(i.mutexGroup)) groupMembers.set(i.mutexGroup, []);
        groupMembers.get(i.mutexGroup).push(i.id);
      }
    });

    // 每个物品的统计
    const stat = new Map(); // id -> { drops:[perPlayer], firstRounds:[], obtainedPlayers, totalDrops, convertedOut, wasted }
    items.forEach((i) => stat.set(i.id, {
      dropsPerPlayer: new Uint32Array(players),
      firstRounds: [],
      totalDrops: 0,
      convertedOut: 0, // 该物品被抽中但因重复被转化的次数
      wasted: 0,       // 被抽中但已达上限且无转化的次数
    }));
    const convertedIn = new Map(); // 转化目标 id -> 总量
    const firstOwnRound = new Map(); // id -> Uint32Array(players), 0 表示未获得
    items.forEach((i) => firstOwnRound.set(i.id, new Uint32Array(players)));
    const firstRareRound = new Uint32Array(players); // 0 = 从未获得稀有

    for (let p = 0; p < players; p++) {
      const owned = new Map();      // id -> 当前持有数
      const pityCounter = new Map(); // id -> 连续未中次数
      pityItems.forEach((i) => pityCounter.set(i.id, 0));

      const ownsItem = (id) => (owned.get(id) || 0) > 0;
      const requiresMet = (it) => (it.requires || []).every(ownsItem);
      const mutexBlocked = (it) => {
        const g = groupOf.get(it.id);
        if (!g) return false;
        return groupMembers.get(g).some((mid) => mid !== it.id && ownsItem(mid));
      };
      const obtainable = (it) => requiresMet(it) && !mutexBlocked(it);

      for (let r = 1; r <= rounds; r++) {
        // 1) 保底判定
        let forced = null;
        for (const it of pityItems) {
          const c = pityCounter.get(it.id) + 1;
          if (c >= it.pity && it.weight >= 0 && obtainable(it) && (it.weight > 0 || it.pity)) {
            if (!forced || c > pityCounter.get(forced.id) + 1) forced = it;
          }
        }

        let picked = forced;
        // 2) 加权抽取
        if (!picked) {
          const pool = drawable.filter((i) => i.weight > 0 && obtainable(i));
          let total = 0;
          for (const i of pool) total += i.weight;
          if (total > 0) {
            let x = rng() * total;
            for (const i of pool) {
              x -= i.weight;
              if (x <= 0) { picked = i; break; }
            }
            if (!picked) picked = pool[pool.length - 1];
          }
        }

        // 3) 保底计数器更新
        for (const it of pityItems) {
          if (picked && it.id === picked.id) pityCounter.set(it.id, 0);
          else pityCounter.set(it.id, pityCounter.get(it.id) + 1);
        }
        if (!picked) continue;

        // 4) 发放：持有上限 / 重复转化
        const st = stat.get(picked.id);
        const cap = effectiveMaxOwn(picked);
        const cur = owned.get(picked.id) || 0;
        st.totalDrops++;
        st.dropsPerPlayer[p]++;
        if (cur < cap) {
          owned.set(picked.id, cur + 1);
          if (cur === 0) {
            firstOwnRound.get(picked.id)[p] = r;
            st.firstRounds.push(r);
            if (rareIds.has(picked.id) && !firstRareRound[p]) firstRareRound[p] = r;
          }
        } else if (picked.convertTo) {
          st.convertedOut++;
          const t = picked.convertTo;
          convertedIn.set(t.item, (convertedIn.get(t.item) || 0) + t.count);
          const tgt = items.find((i) => i.id === t.item);
          if (tgt && (owned.get(t.item) || 0) < effectiveMaxOwn(tgt)) {
            owned.set(t.item, (owned.get(t.item) || 0) + t.count);
          }
        } else {
          st.wasted++;
        }
      }
    }

    // 汇总
    const perItem = items.map((it) => {
      const st = stat.get(it.id);
      const firsts = firstOwnRound.get(it.id);
      let obtainedPlayers = 0;
      for (let p = 0; p < players; p++) if (firsts[p] > 0) obtainedPlayers++;
      // 获得次数分布（直方图），上限 10+ 桶
      const maxBucket = 10;
      const hist = new Array(maxBucket + 1).fill(0);
      for (let p = 0; p < players; p++) {
        const d = st.dropsPerPlayer[p];
        hist[d > maxBucket ? maxBucket : d]++;
      }
      // 按局累计获得概率曲线
      const probByRound = new Array(rounds + 1).fill(0);
      let cum = 0;
      for (let r = 1; r <= rounds; r++) {
        for (let p = 0; p < players; p++) if (firsts[p] === r) cum++;
        probByRound[r] = cum / players;
      }
      const sortedFirsts = Array.from(firsts).filter((x) => x > 0).sort((a, b) => a - b);
      const meanFirst = sortedFirsts.length
        ? sortedFirsts.reduce((a, b) => a + b, 0) / sortedFirsts.length : null;
      const medianFirst = sortedFirsts.length
        ? sortedFirsts[Math.floor((sortedFirsts.length - 1) / 2)] : null;
      return {
        id: it.id,
        name: it.name,
        rare: it.rare,
        obtainedPlayers,
        obtainProb: obtainedPlayers / players,
        totalDrops: st.totalDrops,
        convertedOut: st.convertedOut,
        wasted: st.wasted,
        hist,
        probByRound,
        meanFirstRound: meanFirst,
        medianFirstRound: medianFirst,
      };
    });

    // 稀有覆盖率：第 r 局结束时已拥有 ≥1 个稀有物品的玩家比例
    const rareCoverage = new Array(rounds + 1).fill(0);
    for (let r = 1; r <= rounds; r++) {
      let c = 0;
      for (let p = 0; p < players; p++) if (firstRareRound[p] > 0 && firstRareRound[p] <= r) c++;
      rareCoverage[r] = c / players;
    }

    const converted = {};
    convertedIn.forEach((v, k) => { converted[k] = v; });

    return {
      params: { players, rounds, seed: params.seed == null ? 1 : params.seed },
      perItem,
      rareCoverage,
      converted,
    };
  }

  /* ---------------- 版本对比 ----------------
   * 对比两个配置（各自用相同种子与参数模拟），输出每个物品的变化量并排序。 */
  function compareConfigs(cfgA, cfgB, params) {
    const resA = simulate(cfgA, params);
    const resB = simulate(cfgB, params);
    const mapA = new Map(resA.perItem.map((i) => [i.id, i]));
    const mapB = new Map(resB.perItem.map((i) => [i.id, i]));
    const cfgMapA = new Map(cfgA.items.map((i) => [i.id, i]));
    const cfgMapB = new Map(cfgB.items.map((i) => [i.id, i]));
    const ids = new Set([...mapA.keys(), ...mapB.keys()]);

    const rows = [];
    ids.forEach((id) => {
      const a = mapA.get(id);
      const b = mapB.get(id);
      const ca = cfgMapA.get(id);
      const cb = cfgMapB.get(id);
      const probA = a ? a.obtainProb : null;
      const probB = b ? b.obtainProb : null;
      const meanA = a ? a.meanFirstRound : null;
      const meanB = b ? b.meanFirstRound : null;
      const pityA = ca ? ca.pity : null;
      const pityB = cb ? cb.pity : null;
      const dProb = probA != null && probB != null ? probB - probA : null;
      const dMean = meanA != null && meanB != null ? meanB - meanA : null;
      const pityChanged = (pityA == null ? null : Number(pityA)) !== (pityB == null ? null : Number(pityB));
      const impact = Math.abs(dProb == null ? (probA == null || probB == null ? 1 : 0) : dProb);
      rows.push({
        id,
        name: (b && b.name) || (a && a.name) || id,
        onlyIn: a == null ? 'B' : b == null ? 'A' : null,
        probA, probB, dProb,
        meanA, meanB, dMean,
        pityA, pityB, pityChanged,
        impact,
      });
    });
    rows.sort((x, y) => y.impact - x.impact);
    return { rows, resA, resB };
  }

  global.Engine = {
    defaultConfig,
    normalizeConfig,
    effectiveMaxOwn,
    validateConfig,
    simulate,
    compareConfigs,
  };
})(window);
