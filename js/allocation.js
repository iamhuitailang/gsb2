/*
 * 预算分配器。
 * 思路：每张图先取自身质量分最高的可行候选；超预算时按优先级逐轮降级——
 * 低优先级先被牺牲，同一优先级内选“省下字节最多”的降级动作。
 * 锁定项不参与自动降级。整个过程逐步记录，方案为何这样选可以完整追溯。
 */
(function (global) {
  'use strict';

  const PRIORITY_WEIGHT = { high: 3, mid: 2, low: 1 };

  function feasible(cand) {
    return cand && cand.status === 'ok' && cand.violations.length === 0;
  }

  function okCandidates(item) {
    return item.candidates.filter((c) => c.status === 'ok');
  }
  function feasibleCandidates(item) {
    return item.candidates.filter(feasible);
  }

  function bestFeasible(item) {
    const list = feasibleCandidates(item);
    if (!list.length) return null;
    return list.slice().sort((a, b) => ImgEncoding.qualityScore(b) - ImgEncoding.qualityScore(a))[0];
  }

  function cheapestFeasible(item) {
    const list = feasibleCandidates(item);
    if (!list.length) return null;
    return list.slice().sort((a, b) => a.bytes - b.bytes)[0];
  }

  function totalOf(picks, items) {
    return items.reduce((sum, item) => {
      const c = picks.get(item.id);
      return sum + (c ? c.bytes : 0);
    }, 0);
  }

  /**
   * 不可行诊断：逐图说明是什么限制卡住了。
   */
  function diagnose(items, picks) {
    const entries = [];
    items.forEach((item) => {
      const reasons = [];
      const feas = feasibleCandidates(item);
      const fails = item.candidates.filter((c) => c.status === 'fail');
      const blocked = item.candidates.filter((c) => c.status === 'ok' && c.violations.length > 0);

      if (!feas.length) {
        if (fails.length && fails.length === item.candidates.length) {
          reasons.push('全部候选编码失败，没有可用输出（需要重新编码或更换原图）');
        } else {
          const vset = new Set();
          blocked.forEach((c) => c.violations.forEach((v) => vset.add(v)));
          vset.forEach((v) => reasons.push(v));
          if (fails.length) reasons.push(fails.length + ' 个候选编码失败，已排除');
          if (!reasons.length) reasons.push('没有满足约束的候选');
        }
        entries.push({ itemId: item.id, name: item.name, reasons,
          minBytes: null, blocked, fails });
      } else {
        const min = cheapestFeasible(item);
        const picked = picks.get(item.id);
        if (picked && picked.id !== min.id) {
          // 被锁定在较贵的候选上
          const extra = picked.bytes - min.bytes;
          reasons.push('已锁定在 ' + picked.label + '，比最低可行档多占 ' +
            Util.formatBytes(extra) + '（锁定项不参与自动降级）');
          entries.push({ itemId: item.id, name: item.name, reasons,
            minBytes: min.bytes, locked: true, extra });
        } else {
          entries.push({ itemId: item.id, name: item.name, reasons: [],
            minBytes: min.bytes });
        }
      }
    });
    return entries;
  }

  /**
   * 主入口。
   * @param items 已生成 candidates 的图片数组（含 priority/minW/minH/keepAlpha/lockedPickId）
   * @param budget 总字节上限
   */
  function allocate(items, budget) {
    const steps = [];
    const picks = new Map();
    const unlocked = [];

    /* 1. 初始化：锁定项用锁定候选，其余取各自最优可行候选；同时做硬约束检查 */
    const hardBlockers = [];
    for (const item of items) {
      if (item.lockedPickId) {
        const locked = item.candidates.find((c) => c.id === item.lockedPickId);
        if (!feasible(locked)) {
          hardBlockers.push({ item, reason: '锁定的候选已不满足约束或编码失败，请重新选择' });
          picks.set(item.id, null);
        } else {
          picks.set(item.id, locked);
        }
      } else {
        const best = bestFeasible(item);
        if (!best) hardBlockers.push({ item, reason: null });
        picks.set(item.id, best);
        if (best) unlocked.push(item);
      }
    }

    if (hardBlockers.length) {
      const diag = diagnose(items, picks);
      steps.push('存在无法满足硬约束的图片，分配终止。');
      return {
        feasible: false,
        picks,
        total: totalOf(picks, items),
        budget,
        steps,
        blockers: hardBlockers,
        diagnosis: diag
      };
    }

    let total = totalOf(picks, items);
    steps.push('初始方案：每张图取自身质量最高的可行候选，合计 ' + Util.formatBytes(total) +
      '，预算 ' + Util.formatBytes(budget) + '。');

    /* 2. 计算理论最低合计：锁定项按锁定候选，其余按最低可行档 */
    let floorTotal = 0;
    items.forEach((item) => {
      if (item.lockedPickId) floorTotal += picks.get(item.id).bytes;
      else floorTotal += cheapestFeasible(item).bytes;
    });

    /* 3. 逐轮降级：先把最低优先级的图一路压到最低可行档，
          只有该优先级榨干后才动更高优先级；同组内选节省最多的一步 */
    let round = 0;
    while (total > budget) {
      round++;
      const moves = [];
      for (const item of unlocked) {
        const cur = picks.get(item.id);
        const cheaper = feasibleCandidates(item)
          .filter((c) => c.bytes < cur.bytes)
          .sort((a, b) => b.bytes - a.bytes); // 先尝试“省得最多”的下一档
        if (!cheaper.length) continue;
        moves.push({
          item,
          from: cur,
          to: cheaper[0],
          saving: cur.bytes - cheaper[0].bytes,
          priority: PRIORITY_WEIGHT[item.priority] || 2
        });
      }
      if (!moves.length) break;

      // 只在“当前可降级的最低优先级”组内选择，保证低优先级先被榨干
      const minPriority = Math.min(...moves.map((m) => m.priority));
      const group = moves.filter((m) => m.priority === minPriority);
      group.sort((a, b) => b.saving - a.saving);
      const move = group[0];

      picks.set(move.item.id, move.to);
      total -= move.saving;
      const priText = { high: '高', mid: '中', low: '低' }[move.item.priority];
      steps.push('第 ' + round + ' 轮：' + move.item.name + '（' + priText + '优先级）' +
        '由「' + move.from.label + '」降为「' + move.to.label + '」，省 ' +
        Util.formatBytes(move.saving) + '，当前合计 ' + Util.formatBytes(total) +
        (move.to.psnr !== null ? '，PSNR ' + ImgEncoding.psnrLabel(move.to.psnr) : '') + '。');
    }

    if (total <= budget) {
      steps.push('方案进入预算：合计 ' + Util.formatBytes(total) +
        '，余量 ' + Util.formatBytes(budget - total) + '。');
      return { feasible: true, picks, total, budget, steps, floorTotal,
        diagnosis: diagnose(items, picks) };
    }

    /* 4. 全部降级到最低可行档仍超预算：给出卡住原因 */
    steps.push('所有非锁定图片都已降到最低可行档，仍超预算 ' +
      Util.formatBytes(total - budget) + '。理论最低合计 ' + Util.formatBytes(floorTotal) + '。');
    return {
      feasible: false,
      picks,
      total,
      budget,
      steps,
      floorTotal,
      overrun: total - budget,
      diagnosis: diagnose(items, picks)
    };
  }

  /** 对比某图当前选择与它的最优可行候选，返回“被牺牲”信息 */
  function sacrificeInfo(item, picked) {
    const best = bestFeasible(item);
    if (!best || !picked) return null;
    if (best.id === picked.id) return null;
    return {
      bestLabel: best.label,
      bestBytes: best.bytes,
      bytesSaved: best.bytes - picked.bytes,
      psnr: picked.psnr
    };
  }

  global.Allocator = {
    PRIORITY_WEIGHT, feasible, feasibleCandidates, okCandidates,
    bestFeasible, cheapestFeasible, allocate, sacrificeInfo, totalOf
  };
})(window);
