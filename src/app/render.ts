import type { DeviceSettlement, RoundRecord, TeamId, ViewModel } from '../domain/types.ts';
import { TEAM_NAMES } from '../domain/types.ts';

export interface UiState {
  /** 提交前的二次确认（确认前仍可继续修改）。 */
  confirmSubmit: TeamId | null;
  /** 正在查看的历史记录 id；null 表示不看。 */
  openHistoryId: string | null;
  /** 导入框内容。 */
  importText: string;
  /** 导入结果提示。 */
  importMessage: string | null;
  /** 历史回放结果提示。 */
  replayMessage: string | null;
  /** 展开的规则说明。 */
  showRules: boolean;
  /** 新一轮种子输入框。 */
  seedInput: string;
  presetInput: 'contested' | 'one-short' | 'random';
  /** 结算页里被展开明细的设备。 */
  openDeviceId: string | null;
}

export function initialUi(view: ViewModel): UiState {
  return {
    confirmSubmit: null,
    openHistoryId: null,
    importText: '',
    importMessage: null,
    replayMessage: null,
    showRules: true,
    seedInput: view.baseSeed,
    presetInput: view.preset,
    openDeviceId: null,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function teamName(team: TeamId): string {
  return TEAM_NAMES[team];
}

function teamClass(team: TeamId): string {
  return team === 'A' ? 'team-a' : 'team-b';
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* 通用片段                                                            */
/* ------------------------------------------------------------------ */

function header(view: ViewModel): string {
  return `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">⌁</span>
        <div>
          <h1>维修分摊试验台</h1>
          <p class="sub">同一台电脑轮流操作 · 两队密封提交 · 统一结算</p>
        </div>
      </div>
      <div class="meta">
        <span class="pill">第 ${view.round} 轮</span>
        <span class="pill phase">${escapeHtml(view.phaseLabel)}</span>
        <span class="pill" title="本轮固定种子">种子 ${escapeHtml(view.seed)}</span>
        <span class="pill">预算 ${view.budget} 工时 / 队</span>
      </div>
    </header>`;
}

function deviceSummaryCards(view: ViewModel): string {
  return `
    <section class="device-grid" aria-label="设备参数">
      ${view.devices
        .map(
          (device) => `
        <article class="device-card mini">
          <h3>${escapeHtml(device.name)}</h3>
          <dl>
            <div><dt>故障程度</dt><dd>${device.severity}</dd></div>
            <div><dt>工时上限</dt><dd>${device.cap}</dd></div>
            <div><dt>修复收益</dt><dd>${device.reward} 分</dd></div>
          </dl>
        </article>`,
        )
        .join('')}
    </section>`;
}

function banners(input: RenderInput): string {
  const parts: string[] = [];
  if (input.error) parts.push(`<div class="banner error" role="alert">${escapeHtml(input.error)}</div>`);
  if (input.notice) parts.push(`<div class="banner ok">${escapeHtml(input.notice)}</div>`);
  if (input.saveError) parts.push(`<div class="banner warn">${escapeHtml(input.saveError)}</div>`);
  return parts.join('');
}

function rulesPanel(ui: UiState): string {
  if (!ui.showRules) {
    return `<button class="link" data-action="toggle-rules">展开结算规则</button>`;
  }
  return `
    <section class="panel rules">
      <div class="panel-head">
        <h2>结算规则（可核对）</h2>
        <button class="link" data-action="toggle-rules">收起</button>
      </div>
      <ol>
        <li><strong>工时上限：</strong>两队派到同一设备的工时合计超过上限时，超出部分作废：先从投入更多的一方扣；双方相同（平手）则固定从乙队开始扣，直到降到上限。</li>
        <li><strong>计入顺序：</strong>作废后，投入较少的一方先放第 1 个单位（相同则甲队先），之后甲乙交替，直到一方用完。</li>
        <li><strong>最后一单位：</strong>前 “故障程度” 个单位计入修复，放下第 “故障程度” 个单位的一方是收官方；之后的单位属于超额维修，计入投入但不计分。</li>
        <li><strong>分配：</strong>修复后按双方有效计入工时的比例分配修复收益，先各自向下取整；取整剩下的点数（最多 1 分）给占比余数更大的一方；余数相同时（平手必然如此）给放下最后一单位的收官方。</li>
        <li><strong>公开时机：</strong>双方都密封提交后才能结算。结算后本轮投入才公开；结算前任何界面、普通历史、导出都不包含任一方的选择。</li>
        <li><strong>可重播：</strong>结算只依赖种子、设备参数和双方投入；用同一份记录重播必然得到同一分值，并可用校验值核对。</li>
      </ol>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 交接遮挡页                                                          */
/* ------------------------------------------------------------------ */

function handoffScreen(view: ViewModel): string {
  const handoff = view.handoff;
  if (!handoff) return '';
  return `
    <section class="cover" role="dialog" aria-modal="true" aria-label="交接遮挡页">
      <div class="cover-inner">
        <div class="lock" aria-hidden="true">🔒</div>
        <p class="cover-kicker">屏幕遮挡 · 请整机交接</p>
        <h2>${escapeHtml(handoff.title)}</h2>
        <p class="cover-detail">${escapeHtml(handoff.detail)}</p>
        <div class="cover-state">
          <div class="${view.submitted.A ? 'sealed' : ''}">甲队：${view.submitted.A ? '已密封提交' : '尚未提交'}</div>
          <div class="${view.submitted.B ? 'sealed' : ''}">乙队：${view.submitted.B ? '已密封提交' : '尚未提交'}</div>
        </div>
        <button class="primary big" data-action="accept-handoff" data-team="${handoff.team}">
          ${teamName(handoff.team)}接手
        </button>
        <p class="fineprint">接手前，上一方的选择不会出现在屏幕上；接手后也只显示本队自己的方案。</p>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 编辑界面                                                            */
/* ------------------------------------------------------------------ */

function editingScreen(view: ViewModel, ui: UiState): string {
  const editing = view.editing;
  if (!editing) return '';
  const team = editing.team;
  const confirmOpen = ui.confirmSubmit === team;
  const teamDraft = view.devices.map((device) => `${device.id}:${editing.allocations[device.id] ?? 0}`).join('|');
  return `
    <section class="workspace" data-team="${team}" data-draft="${escapeHtml(teamDraft)}">
      <div class="who ${teamClass(team)}">
        <strong>现在轮到 ${teamName(team)} 编辑</strong>
        <span>另一队此刻不参与，也看不到你正在填的内容。已用 <b>${editing.spent}</b> / ${view.budget} 工时。</span>
      </div>

      ${deviceSummaryCards(view)}

      <section class="device-grid" aria-label="${teamName(team)}的分工">
        ${view.devices
          .map((device) => {
            const value = editing.allocations[device.id] ?? 0;
            return `
          <article class="device-card editable" data-device="${escapeHtml(device.id)}">
            <header>
              <h3>${escapeHtml(device.name)}</h3>
              <span class="sev">故障 ${device.severity}</span>
            </header>
            <dl>
              <div><dt>修复需</dt><dd>${device.severity} 单位</dd></div>
              <div><dt>工时上限</dt><dd>${device.cap} 单位</dd></div>
              <div><dt>修复收益</dt><dd>${device.reward} 分</dd></div>
            </dl>
            <div class="stepper">
              <button data-action="dec" data-team="${team}" data-device="${escapeHtml(device.id)}" ${
                value <= 0 ? 'disabled' : ''
              } aria-label="减少 ${escapeHtml(device.name)} 工时">−</button>
              <output aria-live="polite">${value}</output>
              <button data-action="inc" data-team="${team}" data-device="${escapeHtml(device.id)}" aria-label="增加 ${escapeHtml(
                device.name,
              )} 工时">+</button>
            </div>
            <p class="hint">本队投入 ${value} 工时${value === 0 ? '（本轮不派人）' : ''}</p>
          </article>`;
          })
          .join('')}
      </section>

      ${
        editing.exampleAvailable
          ? `<div class="example-row">
              <button class="link" data-action="load-example" data-team="${team}">载入本场景示例分工</button>
              <span class="fineprint">示例用于验收，载入后仍可逐格修改；确认提交前都算草稿。</span>
            </div>`
          : ''
      }

      <footer class="actionbar">
        <div class="budget-bar">
          <span>已分配 ${editing.spent} / ${view.budget}</span>
          <div class="bar"><i style="width:${Math.min(100, (editing.spent / view.budget) * 100)}%"></i></div>
          <span class="remaining">剩余 ${view.budget - editing.spent}</span>
        </div>
        ${
          confirmOpen
            ? `<div class="confirm" role="alertdialog" aria-label="确认密封提交">
                <p>确认后 <b>${teamName(team)}</b> 的方案立即密封，进入交接流程，<b>之后不能再修改</b>。</p>
                <div class="confirm-actions">
                  <button class="primary" data-action="confirm-submit" data-team="${team}">确认密封提交</button>
                  <button class="ghost" data-action="cancel-submit">继续修改</button>
                </div>
              </div>`
            : `<button class="primary big" data-action="request-submit" data-team="${team}">密封提交本队方案</button>
               <p class="fineprint">点击后先出现确认框；确认之前可以随意修改。</p>`
        }
      </footer>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 等待结算                                                            */
/* ------------------------------------------------------------------ */

function awaitingScreen(view: ViewModel): string {
  return `
    <section class="workspace">
      <div class="sealed-pair">
        <div class="sealed-card team-a">
          <span>甲队</span><strong>已密封提交</strong><small>${formatTime(view.submittedAt.A)}</small>
        </div>
        <div class="sealed-card team-b">
          <span>乙队</span><strong>已密封提交</strong><small>${formatTime(view.submittedAt.B)}</small>
        </div>
      </div>
      <p class="center-note">${escapeHtml(view.awaiting?.detail ?? '')}</p>
      <div class="center-actions">
        <button class="primary big" data-action="settle">统一结算本轮</button>
      </div>
      <p class="fineprint center">结算按钮重复点击也不会重复入账。</p>
      ${deviceSummaryCards(view)}
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 结算结果                                                            */
/* ------------------------------------------------------------------ */

function formatSplit(settlement: DeviceSettlement): string {
  const split = settlement.rewardSplit;
  if (!split) return '未修复，无分配';
  return `按有效工时 ${settlement.used.A} : ${settlement.used.B} 分配 ${settlement.reward} 分${
    split.remainder > 0 ? `，余数 ${split.remainder} 分给${teamName(split.remainderTo as TeamId)}` : ''
  }`;
}

function settlementCard(settlement: DeviceSettlement, open: boolean): string {
  return `
    <article class="device-card result ${settlement.repaired ? 'repaired' : 'broken'}">
      <header>
        <h3>${escapeHtml(settlement.name)}</h3>
        <span class="badge ${settlement.repaired ? 'good' : 'bad'}">${
          settlement.repaired ? '已修复' : `未修复 ${settlement.progress}/${settlement.severity}`
        }</span>
      </header>
      <div class="scoreline">
        <div class="team-a"><span>甲队</span><strong>+${settlement.awarded.A}</strong></div>
        <div class="team-b"><span>乙队</span><strong>+${settlement.awarded.B}</strong></div>
      </div>
      <dl class="flow">
        <div><dt>原始投入</dt><dd>甲 ${settlement.raw.A} · 乙 ${settlement.raw.B}</dd></div>
        <div><dt>超上限作废</dt><dd class="${settlement.trimmed.A + settlement.trimmed.B > 0 ? 'warn' : ''}">甲 ${
          settlement.trimmed.A
        } · 乙 ${settlement.trimmed.B}</dd></div>
        <div><dt>有效计入</dt><dd>甲 ${settlement.used.A} · 乙 ${settlement.used.B}</dd></div>
        <div><dt>超额维修</dt><dd>甲 ${settlement.overRepair.A} · 乙 ${settlement.overRepair.B}</dd></div>
        <div><dt>最后一单位</dt><dd>${settlement.finisher ? teamName(settlement.finisher) : '未修复'}</dd></div>
        <div><dt>分配方式</dt><dd>${escapeHtml(formatSplit(settlement))}${settlement.tie ? ' · 平手' : ''}</dd></div>
      </dl>
      <button class="link" data-action="toggle-device" data-device="${escapeHtml(settlement.deviceId)}">
        ${open ? '收起核对步骤' : '逐条核对步骤'}
      </button>
      ${open ? `<ol class="steps">${settlement.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}
    </article>`;
}

function settledScreen(view: ViewModel, ui: UiState): string {
  const settled = view.settled;
  if (!settled) return '';
  const record = settled.record;
  return `
    <section class="workspace">
      <div class="scoreboard">
        <div class="team-a"><span>甲队</span><strong>${record.totals.A}</strong></div>
        <div class="colon">:</div>
        <div class="team-b"><span>乙队</span><strong>${record.totals.B}</strong></div>
      </div>
      <p class="center-note">
        本轮已结算，双方投入已公开。记录编号 <code>${escapeHtml(record.id)}</code> ·
        校验值 <code>${escapeHtml(record.checksum)}</code>
      </p>
      <div class="replay-ok ${settled.replay.matches ? 'ok' : 'bad'}">
        ${
          settled.replay.matches
            ? `重播核对通过：同一份记录重新结算仍为 甲 ${settled.replay.replayed.totals.A} : 乙 ${settled.replay.replayed.totals.B}`
            : '重播核对不一致，请检查记录'
        }
      </div>

      <h2 class="section-title">各边得到什么</h2>
      <section class="device-grid">
        ${record.settlements
          .map((settlement) => settlementCard(settlement, ui.openDeviceId === settlement.deviceId))
          .join('')}
      </section>

      <h2 class="section-title">本轮公开投入</h2>
      <table class="table">
        <thead><tr><th>设备</th><th>甲队投入</th><th>乙队投入</th><th>甲队得分</th><th>乙队得分</th></tr></thead>
        <tbody>
          ${record.devices
            .map((device) => {
              const row = record.settlements.find((item) => item.deviceId === device.id);
              return `<tr><td>${escapeHtml(device.name)}</td><td>${record.plans.A[device.id] ?? 0}</td><td>${
                record.plans.B[device.id] ?? 0
              }</td><td>${row?.awarded.A ?? 0}</td><td>${row?.awarded.B ?? 0}</td></tr>`;
            })
            .join('')}
        </tbody>
      </table>

      <div class="actionbar spread">
        <div class="row">
          <button class="primary" data-action="next-round">进入下一轮</button>
          <button class="ghost" data-action="settle">重复触发结算（验证只入账一轮）</button>
        </div>
        <div class="row">
          <button class="link" data-action="export-record">复制本轮结算记录</button>
          <button class="link" data-action="export-snapshot">复制公开快照</button>
        </div>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* 历史 / 导出 / 导入 / 侧栏                                            */
/* ------------------------------------------------------------------ */

function historyPanel(view: ViewModel, ui: UiState): string {
  const records = view.history;
  const open = records.find((entry) => entry.id === ui.openHistoryId) ?? null;
  return `
    <section class="panel history">
      <div class="panel-head">
        <h2>普通历史（仅已结算轮次）</h2>
        <span class="fineprint">共 ${records.length} 轮</span>
      </div>
      ${
        records.length === 0
          ? `<p class="empty">还没有已结算的轮次。未结算的草稿不会出现在这里。</p>`
          : `<ul class="history-list">
              ${records
                .map(
                  (entry) => `
                <li>
                  <button class="history-item ${entry.id === ui.openHistoryId ? 'active' : ''}" data-action="open-history" data-id="${escapeHtml(
                    entry.id,
                  )}">
                    <span>第 ${entry.round} 轮</span>
                    <strong>甲 ${entry.totals.A} : ${entry.totals.B} 乙</strong>
                    <small>${formatTime(entry.settledAt)}</small>
                  </button>
                </li>`,
                )
                .join('')}
            </ul>`
      }
      ${open ? historyDetail(open.record, ui) : ''}
    </section>`;
}

function historyDetail(record: RoundRecord, ui: UiState): string {
  return `
    <div class="history-detail">
      <h3>第 ${record.round} 轮回放</h3>
      <table class="table compact">
        <thead><tr><th>设备</th><th>甲投入</th><th>乙投入</th><th>甲得分</th><th>乙得分</th></tr></thead>
        <tbody>
          ${record.devices
            .map((device) => {
              const row = record.settlements.find((item) => item.deviceId === device.id);
              return `<tr><td>${escapeHtml(device.name)}</td><td>${record.plans.A[device.id] ?? 0}</td><td>${
                record.plans.B[device.id] ?? 0
              }</td><td>${row?.awarded.A ?? 0}</td><td>${row?.awarded.B ?? 0}</td></tr>`;
            })
            .join('')}
        </tbody>
      </table>
      <p class="fineprint">种子 ${escapeHtml(record.seed)} · 规则 ${escapeHtml(record.rulesVersion)} · 校验 <code>${escapeHtml(
        record.checksum,
      )}</code></p>
      <button class="link" data-action="replay-history" data-id="${escapeHtml(record.id)}">用这份记录重播</button>
      ${
        ui.replayMessage
          ? `<p class="replay-note ${ui.replayMessage.startsWith('通过') ? 'ok' : 'bad'}">${escapeHtml(ui.replayMessage)}</p>`
          : ''
      }
    </div>`;
}

function transferPanel(view: ViewModel, ui: UiState): string {
  return `
    <section class="panel">
      <div class="panel-head"><h2>导出 / 导入</h2></div>
      <p class="fineprint">
        公开快照只包含已结算轮次的投入；${
          view.phase === 'settled' ? '本轮已结算，投入已包含在内。' : '当前轮尚未结算，快照中不含任何队伍的选择。'
        }
      </p>
      <div class="row wrap">
        <button class="link" data-action="export-snapshot">复制公开快照</button>
        <button class="link" data-action="export-record" ${view.phase === 'settled' ? '' : 'disabled'}>复制本轮结算记录</button>
      </div>
      <label class="field">
        <span>粘贴已结算记录（会先重播校验）</span>
        <textarea data-field="import" rows="4" placeholder="贴入结算记录 JSON">${escapeHtml(ui.importText)}</textarea>
      </label>
      <button class="ghost" data-action="import-record">导入并重播校验</button>
      ${ui.importMessage ? `<p class="fineprint">${escapeHtml(ui.importMessage)}</p>` : ''}
    </section>`;
}

function setupPanel(view: ViewModel, ui: UiState): string {
  return `
    <section class="panel">
      <div class="panel-head"><h2>试验设置</h2></div>
      <p class="fineprint">本机存档只用于中断恢复，不是对外导出；清除后下一次操作会重新保存当前进度。</p>
      <div class="row wrap">
        <button class="link" data-action="clear-save">清除本机存档</button>
        <span class="fineprint">${view.pendingRecordCount} 条已结算记录</span>
      </div>
      <label class="field">
        <span>基础种子</span>
        <input data-field="seed" value="${escapeHtml(ui.seedInput)}" />
      </label>
      <label class="field">
        <span>设备场景</span>
        <select data-field="preset">
          <option value="contested" ${ui.presetInput === 'contested' ? 'selected' : ''}>竞争同一设备</option>
          <option value="one-short" ${ui.presetInput === 'one-short' ? 'selected' : ''}>两方都少分一单位</option>
          <option value="random" ${ui.presetInput === 'random' ? 'selected' : ''}>固定种子随机分布</option>
        </select>
      </label>
      <button class="ghost" data-action="restart">按种子重开一局</button>
      <p class="fineprint">重开会丢弃当前进度；同一种子得到同一组设备故障分布。</p>
    </section>`;
}

export interface RenderInput {
  view: ViewModel;
  ui: UiState;
  notice: string | null;
  error: string | null;
  saveError: string | null;
  savedAt: number | null;
  restored: boolean;
}

export function renderApp(input: RenderInput): string {
  const { view, ui } = input;
  const phase = view.phase;
  let main = '';
  if (phase === 'handoff-a' || phase === 'handoff-b') {
    main = handoffScreen(view);
  } else if (phase === 'editing-a' || phase === 'editing-b') {
    main = editingScreen(view, ui);
  } else if (phase === 'awaiting-settlement') {
    main = awaitingScreen(view);
  } else {
    main = settledScreen(view, ui);
  }

  const showSidebar = phase !== 'handoff-a' && phase !== 'handoff-b';
  const showSetupAside = phase === 'handoff-a';

  return `
    <div class="app">
      ${header(view)}
      ${banners(input)}
      <div class="layout ${showSidebar || showSetupAside ? '' : 'solo-layout'}">
        <main class="main">
          ${main}
          ${
            showSidebar
              ? ''
              : `<div class="behind-cover" aria-hidden="true">${deviceSummaryCards(view)}</div>
                 <p class="behind-note">交接完成后才会显示本轮编辑界面、历史与导出。</p>`
          }
        </main>
        ${
          showSidebar
            ? `<aside class="sidebar">
                ${rulesPanel(ui)}
                ${historyPanel(view, ui)}
                ${transferPanel(view, ui)}
                ${setupPanel(view, ui)}
                <p class="fineprint save-line">${
                  input.savedAt ? `本机自动保存于 ${formatTime(input.savedAt)}` : '尚未保存'
                }${input.restored ? ' · 本次由存档恢复' : ''}</p>
              </aside>`
            : showSetupAside
              ? `<aside class="sidebar sidebar-before-start">
                  <section class="panel">
                    <div class="panel-head"><h2>开始前</h2></div>
                    <p class="fineprint">交接遮挡期间不显示任何方案、普通历史或导出入口。需要换场景时可在下面重开一局。</p>
                    ${presetSummary(view, ui)}
                  </section>
                  ${setupPanel(view, ui)}
                </aside>`
              : ''
        }
      </div>
    </div>`;
}

function presetSummary(view: ViewModel, ui: UiState): string {
  return `
    <p class="fineprint">当前场景：<strong>${escapeHtml(SCENARIO_LABELS[ui.presetInput])}</strong> · 预算 ${view.budget} 工时 / 队</p>
    <p class="fineprint">${escapeHtml(SCENARIO_SUMMARIES[ui.presetInput])}</p>`;
}

const SCENARIO_LABELS: Record<'contested' | 'one-short' | 'random', string> = {
  contested: '竞争同一设备',
  'one-short': '两方都少分一单位',
  random: '固定种子随机分布',
};

const SCENARIO_SUMMARIES: Record<'contested' | 'one-short' | 'random', string> = {
  contested: '两队都压在主泵站和控制台上，覆盖平手、超上限扣减、超额维修与最后一单位分配。',
  'one-short': '每队预算 4 工时却都只派 3 个，备用泵停在 2 / 3，双方都拿不到那 9 分。',
  random: '按种子生成故障程度、上限与收益；同一存档恢复不会重新抽取。',
};
