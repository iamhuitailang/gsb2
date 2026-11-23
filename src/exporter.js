/*
 * Export bundle: audio (WAV), decision log (CSV + JSON), config/sheet snapshot
 * and a README carrying the outcome digest. Everything is derived from the
 * same plan object the page renders, so the files can be checked against the
 * on-screen kept / delayed / preempted / dropped result.
 */

import { STATUSES, REASONS, POLICIES } from './scheduler.js';
import { zipStore } from './zip.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function timestampSlug(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function decisionsCsv(plan, compare) {
  const changed = new Map((compare?.affected || []).map((a) => [a.eventId, a]));
  const cats = new Map(plan.config.categories.map((c) => [c.id, c]));
  const header = [
    'event_id',
    'sheet_order',
    'category_id',
    'category_name',
    'priority',
    'planned_ms',
    'natural_duration_ms',
    'status',
    'status_label',
    'reason_code',
    'reason',
    'actual_start_ms',
    'actual_end_ms',
    'delay_ms',
    'channel',
    'victims',
    'preempted_by',
    'note',
    'muted_compare_status',
    'muted_compare_start_ms',
  ];
  const rows = plan.decisions.map((d) => {
    const cat = cats.get(d.categoryId);
    const delta = changed.get(d.eventId);
    return [
      d.eventId,
      d.sheetIndex + 1,
      d.categoryId,
      cat?.name ?? '',
      d.priority,
      d.plannedMs,
      d.naturalDurationMs,
      d.status,
      STATUSES[d.status]?.label ?? d.status,
      d.reasonCode,
      REASONS[d.reasonCode] ?? '',
      d.startMs == null ? '' : d.startMs,
      d.endMs == null ? '' : d.endMs,
      d.delayMs,
      d.channel ?? '',
      d.victims.join(' '),
      d.preemptedBy ?? '',
      plan.events.find((e) => e.id === d.eventId)?.note ?? '',
      delta ? delta.before.status : '',
      delta && delta.before.startMs != null ? delta.before.startMs : '',
    ];
  });
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export function playbacksCsv(plan) {
  const cats = new Map(plan.config.categories.map((c) => [c.id, c]));
  const header = [
    'channel',
    'event_id',
    'category_id',
    'category_name',
    'priority',
    'planned_ms',
    'start_ms',
    'end_ms',
    'delay_ms',
    'audible_ms',
    'cut',
    'cut_by',
  ];
  const rows = [...plan.playbacks]
    .sort((a, b) => a.channel - b.channel || a.start - b.start)
    .map((p) => {
      const cat = cats.get(p.categoryId);
      return [
        p.channel,
        p.eventId,
        p.categoryId,
        cat?.name ?? '',
        p.priority,
        p.plannedMs,
        p.start,
        p.end,
        Math.round((p.start - p.plannedMs) * 10) / 10,
        Math.round((p.end - p.start) * 10) / 10,
        p.cutBy ? 1 : 0,
        p.cutBy ?? '',
      ];
    });
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export function configJson(plan, events, extra = {}) {
  return {
    schema: 'voicebox/session@1',
    exportedAt: new Date().toISOString(),
    outcomeDigest: plan.outcomeDigest,
    configDigest: plan.configDigest,
    summary: plan.summary,
    settings: {
      maxVoices: plan.config.maxVoices,
      maxDelayMs: plan.config.maxDelayMs,
      policy: plan.config.policy,
      masterGain: plan.config.masterGain,
      categories: plan.config.categories.map((c) => ({ ...c })),
    },
    events: events.map((e) => ({
      id: e.id,
      categoryId: e.categoryId,
      timeMs: e.timeMs,
      note: e.note,
    })),
    ...extra,
  };
}

export function readmeText(plan, events, compare) {
  const s = plan.summary;
  const lines = [];
  lines.push('Voicebox 导出包');
  lines.push('================');
  lines.push('');
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push(`结果指纹: ${plan.outcomeDigest}`);
  lines.push(`配置指纹: ${plan.configDigest}`);
  lines.push('');
  lines.push('本包内容');
  lines.push('--------');
  lines.push('  mix.wav           本次调度结果离线渲染的音频（48 kHz / 16-bit 立体声）');
  lines.push('  decisions.csv     每个事件的决策：保留 / 延后 / 顶掉 / 舍弃、通道、实际时间');
  lines.push('  playbacks.csv     按通道列出的实际发声段（含截断点）');
  lines.push('  session.json      完整设置 + 事件表 + 摘要，可重新载入页面');
  lines.push('  README.txt        本说明');
  lines.push('');
  lines.push('结果摘要');
  lines.push('--------');
  lines.push(`  事件总数: ${s.total}`);
  lines.push(`  保留:     ${s.kept}`);
  lines.push(`  延后:     ${s.delayed}`);
  lines.push(`  顶掉:     ${s.preempted}`);
  lines.push(`  舍弃:     ${s.dropped}`);
  if (s.muted) lines.push(`  静音:     ${s.muted}`);
  lines.push(`  发声事件: ${s.sounded}`);
  lines.push(`  完整播完: ${s.fullLength}`);
  lines.push(`  通道峰值: ${s.peakVoices} / ${plan.config.maxVoices}`);
  lines.push(`  通道占用: ${s.utilizationPct}%`);
  lines.push(`  平均延迟: ${s.avgDelayMs} ms，最大延迟 ${s.maxDelayObservedMs} ms`);
  lines.push('');
  lines.push(
    `设置: ${plan.config.maxVoices} 通道 · 最大延迟 ${plan.config.maxDelayMs} ms · 策略 ${
      POLICIES[plan.config.policy]?.name || plan.config.policy
    }（${plan.config.policy}）`
  );
  lines.push('');
  if (compare && compare.mutedCategoryIds.length) {
    lines.push('静音对比');
    lines.push('--------');
    lines.push(`  静音类别: ${compare.mutedCategoryIds.join(', ')}`);
    lines.push(
      `  变化事件: ${compare.affected.length}（状态变化 ${compare.changedStatus}，开始时间变化 ${compare.changedStart}）`
    );
    lines.push(
      `  发声事件: ${compare.countsBefore.sounded} → ${compare.countsAfter.sounded}；完整播完 ${compare.countsBefore.fullLength} → ${compare.countsAfter.fullLength}`
    );
    lines.push('');
    lines.push('  受影响事件明细见 decisions.csv 的 muted_compare_* 两列。');
    lines.push('');
  }
  lines.push('如何核对');
  lines.push('--------');
  lines.push('  1. 用表格软件打开 decisions.csv，按 status 列筛选，计数应与页面「本次结果」四个数字一致。');
  lines.push('  2. playbacks.csv 的 start_ms / end_ms 与页面时间线、决策日志的「实际开始 / 结束」逐行相同。');
  lines.push('  3. 把 session.json 拖回页面（载入），结果指纹应与本文件一致；指纹相同即代表决策完全相同。');
  lines.push('  4. mix.wav 由同一份 plan 离线渲染：只有 status 为 kept / delayed / preempted（且未被静音）的事件会发声，preempted 的声音在截断点停止。');
  lines.push('');
  lines.push('调度规则');
  lines.push('--------');
  lines.push('  · 事件按计划时间处理；同一时刻优先级高者先处理，同优先级按事件表顺序，结果稳定可复现。');
  lines.push('  · 每个事件需要一条通道占满整段时长，并满足同类并发上限。');
  lines.push('  · 抢占优先：到达瞬间资源不足时，顶替正在播放的低优先级声音；同优先级永不顶替。');
  lines.push('  · 延迟优先：只排队不顶替；直接舍弃：不排队不顶替。');
  lines.push('  · 超出最大延迟仍无位置 → 舍弃。被顶替的声音在顶替时刻停止。');
  lines.push('  · 因为触发间隔或排队而错过的时刻不会补抢。');
  lines.push('');
  return lines.join('\n');
}

export function buildExportBundleSync(plan, events, compare, options = {}) {
  const { wavBuffer = null, extras = {} } = options;
  const entries = [];
  if (wavBuffer) {
    entries.push({ name: 'mix.wav', data: wavBuffer });
  }
  entries.push({ name: 'decisions.csv', data: decisionsCsv(plan, compare) });
  entries.push({ name: 'playbacks.csv', data: playbacksCsv(plan) });
  entries.push({
    name: 'session.json',
    data: JSON.stringify(configJson(plan, events, extras), null, 2),
  });
  entries.push({ name: 'README.txt', data: readmeText(plan, events, compare) });
  return zipStore(entries);
}

export async function buildExportBundle(plan, events, compare, options = {}) {
  return buildExportBundleSync(plan, events, compare, options);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
