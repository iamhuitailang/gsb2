'use strict';

/**
 * 执行台核心：所有操作都通过浏览器页面完成 —— 打开列表页、在搜索框按编号查询、
 * 点进详情、填写改价表单、提交、再重新打开详情核对结果。
 *
 * 状态机（每个商品一行）：
 *   ready        预览通过，等待执行
 *   needs_review 预览发现页面当前价与预计旧价不符，留待人工复核
 *   not_found    后台查不到该编号
 *   saving       已提交、结果未知（进程在这一步退出时，续跑会先查后台历史）
 *   saved        已保存并重新打开详情核对通过
 *   already_saved 续跑时从后台改价历史里确认已保存，未重复提交
 *   rejected     后台按预计旧价校验后拒绝覆盖（核对后被人改过），留待处理
 *   verify_failed 保存成功，但重新打开详情核对不一致
 *   error        临时错误，可重试
 */

const journal = require('./journal');
const { formatCents, parseMoneyToCents } = require('../lib/money');

/** 把页面上读到的人读价格文本（如 "18.00" 或 "¥18.00"）转成分。 */
function textPriceToCents(text) {
  if (text === null || text === undefined) return null;
  const parsed = parseMoneyToCents(String(text).replace(/[^\d.]/g, ''));
  return parsed.ok ? parsed.cents : null;
}

const STATUS_LABEL = {
  ready: '待执行',
  needs_review: '需复核',
  not_found: '未找到商品',
  saving: '保存中',
  saved: '已保存',
  already_saved: '已保存（历史确认）',
  already_at_target: '已是目标价',
  rejected: '留待处理',
  verify_failed: '保存后核对不符',
  error: '出错，可重试',
};

const TERMINAL = new Set([
  'saved',
  'already_saved',
  'already_at_target',
  'rejected',
  'verify_failed',
  'needs_review',
  'not_found',
]);

function nowIso() {
  return new Date().toISOString();
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function label(status) {
  return STATUS_LABEL[status] || status;
}

function makeOpId(runId, index) {
  const compact = runId.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  return `OP-${compact}-${String(index + 1).padStart(3, '0')}`;
}

function createRun({ file, fileHash, items, baseUrl }) {
  const runId = journal.newRunId();
  return {
    runId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    file,
    fileHash,
    baseUrl,
    phase: 'created',
    items: items.map((item) => ({
      index: item.index,
      code: item.code,
      expectedOldCents: item.expectedOldCents,
      newCents: item.newCents,
      opId: makeOpId(runId, item.index),
      status: 'ready',
      note: '',
      preview: null,
      attempt: { count: 0 },
      result: null,
    })),
    events: [],
  };
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

async function searchByCode(page, baseUrl, code) {
  await page.goto(`${baseUrl}/`);
  await page.fill('#q', code);
  await page.submit('#search-form');
  await page.waitFor(
    `location.pathname === '/' &&
     new URLSearchParams(location.search).get('q') === ${JSON.stringify(code)} &&
     document.querySelector('#result-count') !== null`,
    `按编号 ${code} 查询`
  );
  return page.evaluate(`(() => {
    const tr = document.querySelector('tr[data-code="' + ${JSON.stringify(code)} + '"]');
    if (!tr) return null;
    const priceEl = tr.querySelector('[data-price-cents]');
    const versionEl = tr.querySelector('[data-version]');
    return {
      code: tr.getAttribute('data-code'),
      priceCents: priceEl ? Number(priceEl.getAttribute('data-price-cents')) : null,
      version: versionEl ? Number(versionEl.getAttribute('data-version')) : null,
      link: !!tr.querySelector('a'),
    };
  })()`);
}

/** 在网页里按编号搜索并点进详情，返回详情页上的当前价与版本号。 */
async function openProductViaSearch(page, baseUrl, code) {
  const row = await searchByCode(page, baseUrl, code);
  if (!row) return { found: false };
  const clicked = await page.evaluate(`(() => {
    const tr = document.querySelector('tr[data-code="' + ${JSON.stringify(code)} + '"]');
    const link = tr && tr.querySelector('a');
    if (!link) return false;
    link.click();
    return true;
  })()`);
  if (!clicked) return { found: false };
  await page.waitFor(
    `location.pathname === '/product' &&
     new URLSearchParams(location.search).get('code') === ${JSON.stringify(code)} &&
     document.querySelector('#current-price') !== null`,
    `打开 ${code} 详情`
  );
  const detail = await page.evaluate(`(() => {
    const priceEl = document.querySelector('#current-price');
    const versionEl = document.querySelector('#product-version');
    return {
      found: true,
      code: ${JSON.stringify(code)},
      priceCents: Number(priceEl.getAttribute('data-price-cents')),
      priceText: priceEl.textContent.trim(),
      version: versionEl ? Number(versionEl.getAttribute('data-version')) : null,
      url: location.href,
    };
  })()`);
  detail.visiblePriceCents = textPriceToCents(detail.priceText);
  detail.listPriceCents = row.priceCents;
  detail.listVersion = row.version;
  return detail;
}

const HISTORY_ROW_EXTRACT = `((tableSelector) => Array.from(
  document.querySelectorAll(tableSelector + ' tbody tr[data-op-id]')
).map((tr) => ({
  seq: Number(tr.getAttribute('data-seq')),
  opId: tr.getAttribute('data-op-id'),
  code: tr.getAttribute('data-code'),
  oldCents: Number(tr.getAttribute('data-old-cents')),
  newCents: Number(tr.getAttribute('data-new-cents')),
  source: tr.getAttribute('data-source'),
  at: tr.getAttribute('data-at'),
})))`;

/** 读取当前详情页上的本商品改价历史。 */
async function readProductHistory(page) {
  return page.evaluate(`(${HISTORY_ROW_EXTRACT})('#product-history')`);
}

/** 读取后台全局改价历史。 */
async function readGlobalHistory(page, baseUrl) {
  await page.goto(`${baseUrl}/history`);
  await page.waitFor(`document.querySelector('#history-table') !== null`, '打开改价历史');
  return page.evaluate(`(${HISTORY_ROW_EXTRACT})('#history-table')`);
}

/** 在详情页提交一次改价，返回后台的响应摘要。 */
async function submitChange(page, item, expectedVersion) {
  await page.fill('input[name="newPrice"]', formatCents(item.newCents));
  await page.fill('input[name="opId"]', item.opId);
  // 关键：预期旧价用导入文件里的值，而不是页面上此刻的值 —— 让后台替我们再校验一次
  await page.fill('input[name="expectedOldPrice"]', formatCents(item.expectedOldCents));
  if (Number.isFinite(expectedVersion)) {
    await page.fill('input[name="expectedVersion"]', String(expectedVersion));
  }
  await page.submit('#change-form');
  await page.waitFor(
    `location.pathname === '/change' && document.querySelector('.msg') !== null`,
    `提交 ${item.code} 改价结果`
  );
  return page.evaluate(`(() => {
    const msg = document.querySelector('.msg');
    const errEl = document.querySelector('#result-error-code');
    const opEl = document.querySelector('#result-op-id');
    const seqEl = document.querySelector('#result-seq');
    return {
      ok: msg ? msg.classList.contains('ok') : false,
      title: document.title,
      text: msg ? msg.textContent.trim() : '',
      errorCode: errEl ? errEl.textContent.trim() : null,
      opId: opEl ? opEl.textContent.trim() : null,
      seq: seqEl ? Number(seqEl.textContent.trim()) : null,
    };
  })()`);
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

async function previewRun({ run, page, baseUrl, log = () => {} }) {
  run.phase = 'previewing';
  journal.save(run);

  for (const item of run.items) {
    const detail = await openProductViaSearch(page, baseUrl, item.code);
    item.preview = { at: nowIso() };
    if (!detail.found) {
      item.status = 'not_found';
      item.preview.priceCents = null;
      item.preview.version = null;
      item.note = '后台按编号查询不到该商品';
      log(`✗ ${item.code}：后台查询不到该商品`);
    } else {
      // 以页面上渲染出来的价格文本为准（真正「用浏览器读出当前价」）
      const seenCents = detail.visiblePriceCents !== null ? detail.visiblePriceCents : detail.priceCents;
      item.preview.priceCents = seenCents;
      item.preview.version = detail.version;
      if (seenCents !== item.expectedOldCents) {
        item.status = 'needs_review';
        item.note = `页面当前价 ${formatCents(seenCents)} 元，与预计旧价 ${formatCents(
          item.expectedOldCents
        )} 元不一致，需人工复核`;
        log(
          `! ${item.code}：当前价 ${formatCents(seenCents)} ≠ 预计旧价 ${formatCents(
            item.expectedOldCents
          )}，需复核`
        );
      } else {
        item.status = 'ready';
        item.note = `页面当前价 ${formatCents(seenCents)} 元与预计旧价一致，可改至 ${formatCents(
          item.newCents
        )} 元`;
        log(`✓ ${item.code}：当前价 ${formatCents(seenCents)} 元，可改至 ${formatCents(item.newCents)} 元`);
      }
    }
    journal.appendEvent(run, 'preview', { code: item.code, status: item.status });
    journal.save(run);
  }

  run.phase = 'previewed';
  journal.save(run);
  return run;
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

function faultKillAfterSave(item) {
  const raw = process.env.GSB_FAULT_KILL_AFTER_SAVE;
  if (raw === undefined || raw === '') return;
  if (Number(raw) !== item.index) return;
  // 故障注入：后台已经保存成功，但进程在写回执行记录之前退出。
  // 默认用 process.exit 模拟（仍会走清理钩子，不遗留浏览器进程）；
  // 设置 GSB_FAULT_KILL_MODE=hard 可以模拟 SIGKILL 级别的硬退出。
  if (process.env.GSB_FAULT_KILL_MODE === 'hard') {
    process.kill(process.pid, 'SIGKILL');
  } else {
    console.error('（故障注入：保存成功但结果尚未记录，进程退出）');
    process.exit(9);
  }
}

function faultPauseAfterItem(item) {
  const raw = process.env.GSB_FAULT_PAUSE_AFTER_ITEM;
  if (raw === undefined || raw === '') return false;
  return Number(raw) === item.index;
}

function pauseRun(run, reason) {
  run.phase = 'paused';
  journal.appendEvent(run, 'pause', { reason });
  journal.save(run);
}

async function verifySaved(page, baseUrl, item) {
  // 重新打开详情页，核对页面上实际显示的价格，并确认历史里确实有本次操作编号
  const detail = await openProductViaSearch(page, baseUrl, item.code);
  const history = detail.found ? await readProductHistory(page) : [];
  const hit = history.find((h) => h.opId === item.opId) || null;
  return {
    found: detail.found,
    actualPriceCents: detail.found
      ? detail.visiblePriceCents !== null
        ? detail.visiblePriceCents
        : detail.priceCents
      : null,
    historySeq: hit ? hit.seq : null,
    historyNewCents: hit ? hit.newCents : null,
  };
}

/** 从后台改价历史里认领已经保存过的操作，避免重复保存。 */
async function adoptFromHistory({ run, item, page, baseUrl, entry, log }) {
  item.status = 'already_saved';
  item.result = {
    seq: entry.seq,
    actualPriceCents: entry.newCents,
    verifiedAt: nowIso(),
    recoveredFromHistory: true,
  };
  item.note = `后台改价历史中已有操作编号 ${item.opId}（序号 #${entry.seq}），未重复保存`;
  // 仍然重新打开详情页，把页面上此刻的实际价格也记下来
  try {
    const detail = await openProductViaSearch(page, baseUrl, item.code);
    if (detail.found) {
      const actual =
        detail.visiblePriceCents !== null ? detail.visiblePriceCents : detail.priceCents;
      item.result.actualPriceCents = actual;
      item.result.pagePriceCents = actual;
      if (actual !== item.newCents) {
        item.note += `；重新打开详情看到当前价 ${formatCents(actual)} 元，与目标 ${formatCents(
          item.newCents
        )} 元不一致，请人工确认`;
      }
    }
  } catch (err) {
    item.note += `；重新打开详情核对失败：${err.message}`;
  }
  journal.appendEvent(run, 'recovered-from-history', {
    code: item.code,
    opId: item.opId,
    seq: entry.seq,
  });
  journal.save(run);
  log(`↻ ${item.code}：历史中已存在 ${item.opId}（#${entry.seq}），跳过保存`);
}

async function processItem({ run, item, page, baseUrl, log }) {
  if (isTerminal(item.status)) return;

  // 先看后台历史里有没有这个操作编号（上一轮可能保存成功但没来得及记录）
  const history = await readGlobalHistory(page, baseUrl);
  const hit = history.find((h) => h.opId === item.opId && h.code === item.code);
  if (hit && hit.newCents === item.newCents) {
    await adoptFromHistory({ run, item, page, baseUrl, entry: hit, log });
    return;
  }
  if (hit) {
    // 操作编号被一条不同内容的记录占用：不覆盖、不重试，交给人工确认
    item.status = 'error';
    item.note = `操作编号 ${item.opId} 已存在于后台历史，但记录的新价 ${formatCents(
      hit.newCents
    )} 元与本次目标 ${formatCents(item.newCents)} 元不同，需人工确认`;
    journal.appendEvent(run, 'op-id-conflict', { code: item.code, opId: item.opId });
    journal.save(run);
    log(`✗ ${item.code}：操作编号冲突，${item.note}`);
    return;
  }

  item.status = 'saving';
  item.attempt.count += 1;
  item.attempt.lastAt = nowIso();
  journal.appendEvent(run, 'save-attempt', {
    code: item.code,
    opId: item.opId,
    attempt: item.attempt.count,
  });
  journal.save(run);

  const detail = await openProductViaSearch(page, baseUrl, item.code);
  if (!detail.found) {
    item.status = 'not_found';
    item.note = '后台按编号查询不到该商品';
    journal.save(run);
    log(`✗ ${item.code}：查询不到商品`);
    return;
  }

  // 执行台自己也读一次当前价，仅用于展示；真正的校验交给后台
  item.attempt.seenPriceCents =
    detail.visiblePriceCents !== null ? detail.visiblePriceCents : detail.priceCents;
  item.attempt.seenVersion = detail.version;

  const expectedVersion =
    item.preview && item.preview.version !== null && item.preview.version !== undefined
      ? item.preview.version
      : detail.version;
  const response = await submitChange(page, item, expectedVersion);

  if (response.ok) {
    faultKillAfterSave(item);
    const verify = await verifySaved(page, baseUrl, item);
    item.result = {
      seq: response.seq,
      actualPriceCents: verify.actualPriceCents,
      verifiedAt: nowIso(),
      historySeq: verify.historySeq,
      recoveredFromHistory: false,
    };
    if (verify.found && verify.actualPriceCents === item.newCents) {
      item.status = 'saved';
      item.note = `保存成功，重新打开详情核对：当前价 ${formatCents(verify.actualPriceCents)} 元，与目标一致`;
      log(
        `✓ ${item.code}：已改为 ${formatCents(verify.actualPriceCents)} 元并核对通过（#${response.seq}）`
      );
    } else {
      item.status = 'verify_failed';
      item.note = `后台报告保存成功，但重新打开详情看到 ${formatCents(
        verify.actualPriceCents
      )} 元，与目标 ${formatCents(item.newCents)} 元不一致`;
      log(`! ${item.code}：保存后核对不符，实际 ${formatCents(verify.actualPriceCents)} 元`);
    }
    journal.appendEvent(run, 'save-result', {
      code: item.code,
      status: item.status,
      seq: response.seq,
      actualPriceCents: verify.actualPriceCents,
    });
    journal.save(run);
    if (faultPauseAfterItem(item)) pauseRun(run, '故障注入：模拟执行中的暂停请求');
    return;
  }

  if (response.errorCode === 'PRICE_MISMATCH' || response.errorCode === 'VERSION_MISMATCH') {
    item.status = 'rejected';
    const verify = await verifySaved(page, baseUrl, item);
    item.result = {
      actualPriceCents: verify.actualPriceCents,
      verifiedAt: nowIso(),
      rejected: true,
      errorCode: response.errorCode,
    };
    item.note = `后台按预计旧价校验后拒绝覆盖：页面当前价已变为 ${formatCents(
      verify.actualPriceCents
    )} 元（预计旧价 ${formatCents(item.expectedOldCents)} 元）。留待人工处理。`;
    journal.appendEvent(run, 'rejected', {
      code: item.code,
      opId: item.opId,
      errorCode: response.errorCode,
      actualPriceCents: verify.actualPriceCents,
    });
    journal.save(run);
    log(`! ${item.code}：价格已变化（现 ${formatCents(verify.actualPriceCents)} 元），留待处理`);
    if (faultPauseAfterItem(item)) pauseRun(run, '故障注入：模拟执行中的暂停请求');
    return;
  }

  if (response.errorCode === 'SAME_PRICE') {
    // 当前价已经等于目标价：无需（也不应）重复改动
    item.status = 'already_at_target';
    const verify = await verifySaved(page, baseUrl, item);
    item.result = {
      actualPriceCents: verify.actualPriceCents,
      verifiedAt: nowIso(),
      alreadyAtTarget: true,
    };
    item.note = `页面当前价已经是目标价 ${formatCents(item.newCents)} 元，无需改动`;
    journal.appendEvent(run, 'already-at-target', { code: item.code });
    journal.save(run);
    log(`= ${item.code}：当前价已经是 ${formatCents(item.newCents)} 元，无需改动`);
    if (faultPauseAfterItem(item)) pauseRun(run, '故障注入：模拟执行中的暂停请求');
    return;
  }

  item.status = 'error';
  item.note = `后台返回错误：${response.errorCode || response.text || '未知错误'}`;
  journal.appendEvent(run, 'error', { code: item.code, message: item.note });
  journal.save(run);
  log(`✗ ${item.code}：${item.note}`);
  if (faultPauseAfterItem(item)) pauseRun(run, '故障注入：模拟执行中的暂停请求');
}

async function executeRun({ run, page, baseUrl, log = () => {}, shouldStop = () => false, onItemDone = () => {} }) {
  run.phase = 'executing';
  journal.appendEvent(run, 'execute-start', { runId: run.runId });
  journal.save(run);
  onItemDone(run);

  // 续跑第一步：先拿后台改价历史，确认哪些操作编号其实已经保存过
  const history = await readGlobalHistory(page, baseUrl);
  const byOpId = new Map(history.map((h) => [h.opId, h]));
  for (const item of run.items) {
    if (isTerminal(item.status) || !item.opId) continue;
    const hit = byOpId.get(item.opId);
    // 只有真正成功写入过的操作（同商品、旧价+新价一致）才算数
    if (hit && hit.code === item.code && hit.newCents === item.newCents) {
      await adoptFromHistory({ run, item, page, baseUrl, entry: hit, log });
    }
  }
  onItemDone(run);

  const pending = run.items.filter((item) => !isTerminal(item.status));
  for (const item of pending) {
    if (shouldStop()) {
      pauseRun(run, '收到暂停请求');
      log('⏸ 已暂停，可稍后运行 resume 从未完成处继续');
      return run;
    }
    if (journal.pauseRequested(run.runId)) {
      pauseRun(run, '检测到暂停标记');
      log('⏸ 已暂停，可稍后运行 resume 从未完成处继续');
      return run;
    }
    try {
      await processItem({ run, item, page, baseUrl, log });
    } catch (err) {
      // 单条出错（页面超时等）不拖垮整批：记录错误并暂停，等待人工续跑
      item.status = 'error';
      item.note = `执行出错：${err.message}`;
      journal.appendEvent(run, 'item-error', { code: item.code, message: err.message });
      pauseRun(run, `商品 ${item.code} 出错，已暂停`);
      log(`✗ ${item.code}：${err.message}（已暂停，可运行 resume 重试）`);
      onItemDone(run);
      return run;
    }
    onItemDone(run);
    if (run.phase === 'paused') return run;
  }

  run.phase = 'finished';
  journal.appendEvent(run, 'finished');
  journal.save(run);
  return run;
}

/* ------------------------------------------------------------------ */
/* 展示                                                                */
/* ------------------------------------------------------------------ */

function formatPrice(cents) {
  return cents === null || cents === undefined ? '—' : `${formatCents(cents)} 元`;
}

function summaryRows(run) {
  return run.items.map((item) => ({
    code: item.code,
    status: item.status,
    statusLabel: label(item.status),
    expectedOld: formatPrice(item.expectedOldCents),
    target: formatPrice(item.newCents),
    previewPrice: formatPrice(item.preview ? item.preview.priceCents : null),
    actual: formatPrice(item.result ? item.result.actualPriceCents : null),
    opId: item.opId,
    note: item.note,
  }));
}

/** 终端显示宽度：CJK 等全角字符算两格。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  }
  return width;
}

function printTable(rows) {
  const keys = ['code', 'statusLabel', 'expectedOld', 'target', 'previewPrice', 'actual', 'opId'];
  const headers = ['商品编号', '状态', '预计旧价', '目标价', '页面当前价', '实际价格', '操作编号'];
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[keys[i]])))
  );
  const pad = (value, width) => value + ' '.repeat(Math.max(0, width - displayWidth(value)));
  console.log(headers.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(keys.map((k, i) => pad(row[k], widths[i])).join('  '));
  }
  console.log('');
  for (const row of rows) {
    if (row.status !== 'saved') console.log(`· ${row.code}（${row.statusLabel}）：${row.note}`);
  }
}

module.exports = {
  STATUS_LABEL,
  isTerminal,
  label,
  createRun,
  previewRun,
  executeRun,
  openProductViaSearch,
  readGlobalHistory,
  summaryRows,
  printTable,
  formatPrice,
};
