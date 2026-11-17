/**
 * 端到端演示脚本：不需要启动 HTTP 服务，直接驱动导出核心逻辑。
 * 运行：node scripts/demo.js
 *
 * 场景：
 * 1. 客服小林有甲站权限，并额外获准导出联系人字段。
 * 2. 小林排队并生成一份包含联系人的 CSV。
 * 3. 管理员撤销联系人导出权限。
 * 4. 旧文件的下载地址返回 410，不能取回内容。
 * 5. 小林按当前范围重新申请，仍可导出甲站的订单号和状态。
 */

import { createStore } from '../src/store.js';

const line = (title) => console.log(`\n=== ${title} ===`);

const store = createStore({ autoRun: false });
const agent = () => store.getUser('agent-lin');
const admin = () => store.getUser('admin');

function queuedAndRecorded(input) {
  const result = store.enqueueExport(agent(), input);
  if (!result.ok) throw new Error(`排队失败：${result.code} ${result.message}`);
  store.executeJob(result.job.id);
  return result.job.id;
}

line('0. 账号与数据');
console.log('站点：', store._sites.map((site) => `${site.name}(${site.id})`).join('、'));
console.log('订单：', store.filterOrders({ siteIds: ['site-a', 'site-b'], statuses: [], q: '' }, admin()).length, '条虚构订单');
console.log(
  '客服小林：',
  `站点 ${agent().sites.join(',')}`,
  `额外权限 ${agent().permissions.join(',') || '无'}`,
  `权限版本 v${agent().permissionVersion}`,
);

line('1. 生成包含联系人的 CSV');
const firstJobId = queuedAndRecorded({
  siteIds: ['site-a'],
  columns: ['order_no', 'status', 'contact_name', 'contact_phone'],
});
const first = store.getDownload(agent(), firstJobId);
console.log(`下载状态：${first.status}`);
console.log(first.download.content.replaceAll('\r\n', '\n').trim());

line('2. 管理员撤销联系人导出权限');
const revoked = store.updateUserAccess(admin(), 'agent-lin', {
  sites: ['site-a'],
  permissions: [],
});
console.log(`权限变更：${revoked.changed}，作废的旧文件数：${revoked.invalidatedJobs}`);
console.log('客服小林当前额外权限：', revoked.user.permissions.join(',') || '无', `（v${revoked.user.permissionVersion}）`);

line('3. 从原地址取回旧文件');
const oldDownload = store.getDownload(agent(), firstJobId);
console.log(`原地址 HTTP ${oldDownload.status}：${oldDownload.error.code} - ${oldDownload.error.message}`);
const oldJob = store.getJob(agent(), firstJobId);
console.log(`任务状态：${oldJob.statusLabel}（${oldJob.status}），needsReapply=${oldJob.needsReapply}`);
console.log(`文件可下载：${oldJob.file?.downloadable ?? false}，失效原因：${oldJob.file?.invalidReason ?? '无'}`);

line('4. 按当前范围重新申请（订单号 + 状态）');
const secondJobId = queuedAndRecorded({
  siteIds: ['site-a'],
  columns: ['order_no', 'status'],
});
const second = store.getDownload(agent(), secondJobId);
console.log(`下载状态：${second.status}`);
console.log(second.download.content.replaceAll('\r\n', '\n').trim());

line('5. 校验');
const rows = second.download.content.replace(/^﻿/, '').trim().split('\r\n');
const header = rows[0];
const containsContact = second.download.content.includes('联系人') || /13[89]-0000-/.test(second.download.content);
console.log(`新文件表头：${header}`);
console.log(`新文件包含联系人内容：${containsContact ? '是（不符合预期）' : '否'}`);
console.log(`旧文件仍可下载：${store.getDownload(agent(), firstJobId).status === 200 ? '是（不符合预期）' : '否'}`);

if (containsContact || oldDownload.status !== 410) {
  process.exitCode = 1;
}
