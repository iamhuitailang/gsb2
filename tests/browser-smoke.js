// browser-smoke.js —— 在浏览器环境跑的交互冒烟测试（通过 page.evaluate 注入）
// 断言关键 DOM 状态与核心计算一致
const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

try {
  // 1. 初始批量试跑渲染
  const cells = document.querySelectorAll('#sweep-strip .cell');
  check('批量试跑生成样本格（>100）', cells.length > 100, `实际 ${cells.length} 格`);
  const okCells = document.querySelectorAll('#sweep-strip .cell.ok').length;
  check('存在可出发样本', okCells > 0, `${okCells} 个`);
  const badCells = document.querySelectorAll('#sweep-strip .cell.bad').length;
  check('存在失败样本（硬闸门）', badCells > 0, `${badCells} 个`);

  // 2. 实体列表面板齐全
  check('渲染 2 个平台', document.querySelectorAll('#entity-list .tag.platform').length === 2);
  check('渲染 2 扇门', document.querySelectorAll('#entity-list .tag.door').length === 2);
  check('渲染等待点/路径点', document.querySelectorAll('#entity-list .tag.point').length >= 5);

  // 3. 路线动作列表
  const routeItems = document.querySelectorAll('#route-list li');
  check('路线含 5 个动作', routeItems.length === 5, `实际 ${routeItems.length}`);

  // 4. 点一个失败样本 -> 结论面板显示中断
  const firstBad = [...cells].find((c) => c.classList.contains('bad'));
  firstBad.click();
  const verdictFail = document.querySelector('#verdict.fail');
  check('点击失败样本显示中断结论', !!verdictFail, verdictFail?.textContent?.slice(0, 40));

  // 5. 点一个成功样本 -> 结论面板显示走通
  const firstOk = [...cells].find((c) => c.classList.contains('ok'));
  firstOk.click();
  const verdictGood = document.querySelector('#verdict.good');
  check('点击成功样本显示走通结论', !!verdictGood);

  // 6. 逐步播放：下一步按钮推进步骤
  document.getElementById('btn-step-next').click();
  check('下一步高亮步骤 0', document.querySelectorAll('#route-list li.active').length === 1);
  document.getElementById('btn-step-next').click();
  const detailText = document.getElementById('step-detail').textContent;
  check('步骤详情有时间信息', /步骤/.test(detailText) && /s/.test(detailText));

  // 7. 时间轴拖动：改 slider 后画面时间更新
  const slider = document.getElementById('time-scrub');
  slider.value = 25;
  slider.dispatchEvent(new Event('input'));
  check('拖动时间轴更新画面时间', document.getElementById('clock-t').textContent.startsWith('25'));

  // 8. 确定性自检
  document.getElementById('btn-consistency').click();
  const toast1 = document.getElementById('toast').textContent;
  check('确定性自检通过', /自检通过/.test(toast1), toast1);

  // 8.5 基线下的最早失败点（必须在锁定/改相位之前检查，那时仍是部分失败的基线）
  const failPanel = document.getElementById('failures').textContent;
  check('展示最早失败点与步骤', /最早 t0=/.test(failPanel) && /步骤\s*\d/.test(failPanel) && /中断/.test(failPanel), failPanel.slice(0, 60));

  // 9. 锁路线 -> diff 面板出现，路线按钮禁用
  document.getElementById('btn-lock').click();
  check('锁定后出现基线对比面板', !document.getElementById('diff-block').hidden);
  check('锁定后路线区带 locked 样式', document.body.classList.contains('locked'));

  // 10. 锁状态下改一个平台相位 -> 触发差异重算
  // 选中上层平台并拖动 phase
  const p2Entity = [...document.querySelectorAll('#entity-list .entity')].find((e) => e.textContent.includes('上层平移平台'));
  p2Entity.click();
  const phaseInput = document.querySelector('#editor input[data-key="phase"]');
  phaseInput.value = 1;
  phaseInput.dispatchEvent(new Event('input'));
  const diffSegs = document.querySelectorAll('#diff-segments .seg-row').length;
  check('改相位后产生差异时段', diffSegs > 0, `${diffSegs} 段`);
  const gainSegs = document.querySelectorAll('#diff-segments .seg-row.gained').length;
  check('存在救回（gained）时段', gainSegs > 0, `${gainSegs} 段`);

  // 11. 解锁（解锁后场景保留救回相位，故为 100% 成功，无失败点属正常）
  document.getElementById('btn-lock').click();
  check('解锁后 diff 面板隐藏', document.getElementById('diff-block').hidden);

  // 12. 半开边界：成功窗口右端点应判失败
  const winRanges = [...document.querySelectorAll('#windows .win .range')].map((e) => e.textContent);
  check('成功窗口以半开 [start, end) 展示', winRanges.every((t) => t.includes('[') && t.includes(')')));

  // 13. 一键救回
  document.getElementById('btn-rescue').click();
  const afterRescue = document.querySelectorAll('#sweep-strip .cell.ok').length;
  check('救回后全部样本可出发', afterRescue === cells.length, `${afterRescue}/${cells.length}`);
} catch (e) {
  results.push({ name: '冒烟测试异常', ok: false, extra: e.message + '\n' + e.stack });
}

return results;
