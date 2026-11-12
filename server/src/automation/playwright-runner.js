// Playwright RPA 引擎：只操作本机模拟业务网站（http://127.0.0.1:<port>/mock）
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config, mockBaseUrl } from '../config.js';
import { maskField, maskText } from '../masking.js';
import { findApplication } from '../mock-store.js';

// 表单字段 -> 页面 data-testid，与模拟网站保持一致
const FIELD_TESTIDS = {
  applicationNo: 'input-applicationNo',
  businessType: 'input-businessType',
  applicantName: 'input-applicantName',
  phone: 'input-phone',
  idCard: 'input-idCard',
  email: 'input-email',
  amount: 'input-amount',
  city: 'input-city',
  address: 'input-address',
  bankAccount: 'input-bankAccount',
  remark: 'input-remark',
};

async function launchBrowser() {
  const launchOptions = {
    headless: config.headless,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    // 没装 Playwright 自带 chromium 时回退系统 Chrome（仍是本机浏览器）
    if (fs.existsSync(config.fallbackChromePath)) {
      return chromium.launch({ ...launchOptions, executablePath: config.fallbackChromePath });
    }
    throw new Error(
      `无法启动浏览器：${maskText(err.message)}。请执行 npm run install:browser 或安装 Google Chrome`
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 执行单条记录。返回 { outcome: 'success'|'skipped', ... }；失败直接抛错
async function processRecord(page, record, helpers) {
  const { log, screenshotPath } = helpers;
  const { payload, applicationNo } = record;

  // —— 幂等第一道防线：提交前查询模拟后台，已存在则跳过，绝不重复填表提交 ——
  const existing = findApplication(applicationNo);
  if (existing) {
    log('warn', 'idempotent_skip', `申请编号 ${applicationNo} 在模拟后台已存在（受理号 ${existing.refNo}），跳过提交`);
    return { outcome: 'skipped', reason: `模拟后台已存在受理号 ${existing.refNo}`, mockRef: existing.refNo };
  }

  await page.goto(`${mockBaseUrl()}/`, { waitUntil: 'networkidle' });
  log('info', 'page_open', `打开录入页面，开始填写申请编号 ${applicationNo}`);

  for (const [field, testId] of Object.entries(FIELD_TESTIDS)) {
    const value = payload[field] ?? '';
    if (value === '' && field !== 'remark') continue;
    const locator = page.getByTestId(testId);
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click();
    // 下拉框用 selectOption，其余输入框用 fill
    if (field === 'businessType') {
      await locator.selectOption(String(value));
    } else {
      await locator.fill(String(value));
    }
    if (config.stepDelay) await sleep(config.stepDelay / 4);
  }
  log('info', 'form_filled', `申请表单填写完成（手机号 ${maskField('phone', payload.phone)}）`);

  // 模拟业务系统要求勾选确认框
  await page.getByTestId('checkbox-confirm').check();
  await sleep(config.stepDelay);

  // 监听提交响应，拿到受理号 / 识别 409 重复
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/mock/api/applications') && r.request().method() === 'POST',
      { timeout: 15000 }
    ),
    page.getByTestId('submit-button').click(),
  ]);

  const body = await response.json().catch(() => ({}));

  // —— 幂等第二道防线：即便前置查询漏过，模拟后台返回 409 也按跳过处理 ——
  if (response.status() === 409) {
    log('warn', 'duplicate_rejected', `模拟后台拒绝重复提交：${applicationNo}`);
    const again = findApplication(applicationNo);
    return {
      outcome: 'skipped',
      reason: '模拟后台返回重复申请（409）',
      mockRef: again?.refNo ?? null,
    };
  }
  if (!response.ok()) {
    throw new Error(`模拟后台返回 ${response.status()}：${maskText(body.error || '未知错误')}`);
  }

  // 确认页面上出现成功提示
  await page.locator('#result.ok').waitFor({ timeout: 5000 });
  await page.screenshot({ path: screenshotPath(record.id), fullPage: false });
  log('info', 'submitted', `申请编号 ${applicationNo} 录入成功，受理号 ${body.refNo}`);
  return { outcome: 'success', mockRef: body.refNo };
}

// 执行整个任务。onProgress 在每条记录状态变化时回调（由 runner 负责落库/SSE）
export async function runJob(jobId, records, callbacks) {
  const { onStart, onRecordUpdate, onLog, shouldStop, onFinish } = callbacks;
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const log = (level, event, message) => onLog({ level, event, message: maskText(message) });
  const screenshotPath = (recordId) =>
    path.join(config.screenshotDir, `job-${jobId}-record-${recordId}.png`);

  onStart();
  let fatal = null;

  try {
    for (const raw of records) {
      // 数据库记录为下划线字段，统一映射为引擎内部使用的驼峰字段
      const record = {
        ...raw,
        rowNo: raw.rowNo ?? raw.row_no,
        applicationNo: raw.applicationNo ?? raw.application_no,
      };
      if (shouldStop()) {
        log('warn', 'job_paused', '收到停止指令，剩余记录标记为中断');
        break;
      }
      // 原子认领；返回 false 说明该记录已被别的流程处理（幂等保护），跳过
      const claimed = onRecordUpdate(record, { status: 'running' });
      if (claimed === false) {
        log('warn', 'record_claim_skipped', `记录 ${record.applicationNo} 已被处理，跳过`);
        continue;
      }
      log('info', 'record_start', `开始处理第 ${record.rowNo} 行，申请编号 ${record.applicationNo}`);
      try {
        const result = await processRecord(page, record, { log, screenshotPath });
        if (result.outcome === 'success') {
          onRecordUpdate(record, {
            status: 'success',
            mockRef: result.mockRef,
            screenshot: screenshotPath(record.id),
          });
        } else {
          onRecordUpdate(record, {
            status: 'skipped',
            mockRef: result.mockRef,
            error: result.reason,
          });
        }
      } catch (err) {
        const msg = maskText(err.message || String(err));
        let shot = null;
        try {
          shot = screenshotPath(record.id);
          await page.screenshot({ path: shot, fullPage: false });
        } catch {
          shot = null;
        }
        log('error', 'record_failed', `第 ${record.rowNo} 行处理失败：${msg}`);
        onRecordUpdate(record, { status: 'failed', error: msg, screenshot: shot });
      }
    }
  } catch (err) {
    fatal = maskText(err.message || String(err));
    log('error', 'job_fatal', `浏览器/任务致命错误：${fatal}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    onFinish(fatal);
  }
}
