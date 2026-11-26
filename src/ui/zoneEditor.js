// 区域列表面板与单区域编辑器：触发模式、停留间隔、宽限、动作规则、启用/禁用、重置。

import { state } from './state.js';
import { POLICY_FIELDS, RULES_LENIENT, RULES_STRICT, normalizeRules } from '../engine/events.js';

const listHost = document.getElementById('zoneList');
const editorHost = document.getElementById('zoneEditor');

const POLICY_META = [
  ['walk', '步行/静止算数'],
  ['teleportLand', '瞬移落点算数'],
  ['teleportExit', '瞬移出区算数'],
  ['dash', '高速穿过算数'],
];

export function renderZonePanel(onChange) {
  listHost.innerHTML = '';
  for (const zone of state.engine.zones) {
    const row = document.createElement('div');
    row.className = 'zone-row' + (zone.id === state.selectedZoneId ? ' selected' : '') + (zone.enabled ? '' : ' disabled');
    row.innerHTML = `
      <span class="zone-swatch" style="background:${zone.color}"></span>
      <span class="zname">${zone.name}</span>
      <span class="mini-btns">
        <button class="icon-btn" data-act="toggle" title="${zone.enabled ? '禁用' : '启用'}">${zone.enabled ? '⏻' : '⏼'}</button>
        <button class="icon-btn" data-act="reset" title="重置运行态（once 标记/计时）">↺</button>
        <button class="icon-btn" data-act="del" title="删除区域">✕</button>
      </span>`;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) {
        state.selectedZoneId = zone.id;
        onChange();
        return;
      }
      e.stopPropagation();
      if (btn.dataset.act === 'toggle') state.engine.setEnabled(zone.id, !zone.enabled);
      if (btn.dataset.act === 'reset') state.engine.resetZone(zone.id);
      if (btn.dataset.act === 'del') {
        state.engine.removeZone(zone.id);
        if (state.selectedZoneId === zone.id) state.selectedZoneId = null;
      }
      onChange();
    });
    listHost.appendChild(row);
  }
  renderEditor(onChange);
}

function renderEditor(onChange) {
  const zone = state.engine.zoneById(state.selectedZoneId);
  if (!zone) {
    editorHost.classList.add('hidden');
    editorHost.innerHTML = '';
    return;
  }
  editorHost.classList.remove('hidden');
  const st = state.engine.getState(zone.id);
  editorHost.innerHTML = `
    <div class="field">
      <label>名称</label>
      <input type="text" data-k="name" value="${zone.name}" />
    </div>
    <div class="field">
      <label>颜色</label>
      <input type="color" data-k="color" value="${toHex(zone.color)}" />
    </div>
    <div class="field">
      <label>触发模式</label>
      <div class="seg" id="modeSeg">
        <button data-mode="every" class="${zone.triggerMode === 'every' ? 'on' : ''}">每次触发</button>
        <button data-mode="once" class="${zone.triggerMode === 'once' ? 'on' : ''}">一次触发</button>
      </div>
    </div>
    <div class="field">
      <label>停留间隔 ms</label>
      <input type="number" min="0" step="50" data-k="stayIntervalMs" value="${zone.stayIntervalMs}" />
    </div>
    <div class="field">
      <label>退出宽限 ms</label>
      <input type="number" min="0" step="10" data-k="graceMs" value="${zone.graceMs}" />
    </div>
    <div class="field">
      <label>规则预设</label>
      <div class="seg" id="rulesSeg">
        <button data-rules="strict" class="${matches(zone.rules, RULES_STRICT) ? 'on' : ''}">严格</button>
        <button data-rules="lenient" class="${matches(zone.rules, RULES_LENIENT) ? 'on' : ''}">宽松</button>
      </div>
    </div>
    <div class="field" style="grid-template-columns: 92px 1fr;">
      <label>动作规则</label>
      <div class="check-grid">
        ${POLICY_META.map(
          ([k, label]) =>
            `<label><input type="checkbox" data-rule="${k}" ${zone.rules[k] ? 'checked' : ''} /> ${label}</label>`
        ).join('')}
        <label><input type="number" min="2" step="1" data-rule-step value="${zone.rules.dashSampleStep}" style="width:64px" /> dash 采样步长 px</label>
      </div>
    </div>
    <div class="field">
      <label>运行态</label>
      <span class="hint" style="text-align:left">
        ${zone.enabled ? '启用中' : '已禁用'} · ${st.inside ? '在内' : '在外'} ·
        计数 进${st.counts.enter}/出${st.counts.exit}/留${st.counts.stay} ·
        dwell ${Math.round(st.dwellMs)}ms
        ${zone.triggerMode === 'once' ? `· 已发 ${Object.entries(st.fired).filter(([, v]) => v).map(([k]) => k).join('/') || '无'}` : ''}
      </span>
    </div>
    <div class="editor-actions">
      <button class="btn small" id="btnApplyRulesAll">把当前规则套用到全部区域</button>
    </div>
  `;

  editorHost.querySelector('[data-k="name"]').addEventListener('input', (e) => {
    zone.name = e.target.value;
    onChange();
  });
  editorHost.querySelector('[data-k="color"]').addEventListener('input', (e) => {
    zone.color = e.target.value;
    onChange();
  });
  for (const k of ['stayIntervalMs', 'graceMs']) {
    editorHost.querySelector(`[data-k="${k}"]`).addEventListener('input', (e) => {
      state.engine.updateZone(zone.id, { [k]: Number(e.target.value) || 0 });
      onChange();
    });
  }
  editorHost.querySelectorAll('#modeSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      state.engine.updateZone(zone.id, { triggerMode: b.dataset.mode });
      onChange();
    })
  );
  editorHost.querySelectorAll('#rulesSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      const preset = b.dataset.rules === 'strict' ? RULES_STRICT : RULES_LENIENT;
      state.engine.updateZone(zone.id, { rules: { ...preset } });
      onChange();
    });
  });
  editorHost.querySelectorAll('[data-rule]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const rules = { ...zone.rules };
      for (const [k] of POLICY_META) {
        const node = editorHost.querySelector(`[data-rule="${k}"]`);
        if (node) rules[k] = node.checked;
      }
      rules.dashSampleStep = Number(editorHost.querySelector('[data-rule-step]').value) || 12;
      state.engine.updateZone(zone.id, { rules: normalizeRules(rules) });
      onChange();
    })
  );
  editorHost.querySelector('[data-rule-step]').addEventListener('input', (e) => {
    state.engine.updateZone(zone.id, {
      rules: normalizeRules({ ...zone.rules, dashSampleStep: Number(e.target.value) || 12 }),
    });
    onChange();
  });
  editorHost.querySelector('#btnApplyRulesAll').addEventListener('click', () => {
    for (const z of state.engine.zones) {
      state.engine.updateZone(z.id, { rules: normalizeRules({ ...zone.rules }) });
    }
    onChange();
  });
}

function matches(a, b) {
  return POLICY_FIELDS.every((f) => a[f] === b[f]);
}

function toHex(c) {
  if (c.startsWith('#')) return c.length === 7 ? c : c;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = c;
  return ctx.fillStyle;
}
