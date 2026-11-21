<script setup>
import { computed } from 'vue'

const props = defineProps({
  result: { type: Object, default: null },
  meta: { type: Object, default: null },
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['open-record'])

const verdict = computed(() => props.result?.verdict || null)
const fields = computed(() => props.result?.fields || [])
const crossCheck = computed(() => props.result?.cross_check || null)

const statusClass = computed(() => {
  if (!verdict.value) return 'info'
  if (verdict.value.status === 'determined') {
    return verdict.value.risk === 'high' ? 'warn' : 'ok'
  }
  return 'unknown'
})

const riskClass = computed(() => {
  const risk = verdict.value?.risk
  if (risk === 'low') return 'ok'
  if (risk === 'high') return 'danger'
  if (risk === 'info') return 'info'
  return 'unknown'
})

const decisionClass = (decision) => {
  if (decision === 'client') return 'ok'
  if (decision === 'proxy') return 'accent'
  return 'info'
}

const trustClass = (trust) => {
  if (trust === 'trusted_proxy') return 'accent'
  if (trust === 'untrusted') return 'info'
  return 'warn'
}

const kindClass = (kind) => {
  if (kind === 'address') return 'ok'
  if (kind === 'unknown') return 'unknown'
  if (kind === 'empty') return 'warn'
  return 'danger'
}

const kindLabel = (kind) =>
  ({ address: '已识别', unknown: '未知值', empty: '空项', malformed: '格式错误' })[kind] || kind

const crossClass = computed(() => {
  const status = crossCheck.value?.status
  if (status === 'consistent') return 'ok'
  if (status === 'order_conflict' || status === 'mismatch') return 'danger'
  if (status === 'not_applicable') return 'info'
  return 'info'
})

const hopRows = computed(() => {
  const rows = []
  fields.value.forEach((field) => {
    if (!field.present) return
    field.hops.forEach((hop) => {
      rows.push({ field, hop })
    })
  })
  return rows
})

const unparsedPeerNote = computed(() => props.result?.peer?.kind !== 'address')
</script>

<template>
  <div>
    <div class="card-head">
      <h2>判定结果</h2>
      <div v-if="meta?.analysis_id" class="button-row">
        <span class="muted small">记录 #{{ meta.analysis_id }}</span>
        <button class="ghost small" @click="emit('open-record', meta.analysis_id)">
          查看记录
        </button>
      </div>
    </div>

    <div v-if="!result" class="empty">
      填写左侧内容后点击「开始判定」，这里会逐跳展示每个地址是如何被采用或排除的。
    </div>

    <template v-else>
      <div class="verdict" :class="verdict.status">
        <div class="button-row" style="justify-content: space-between">
          <span class="label">最终判定</span>
          <span class="badge" :class="riskClass">风险：{{ verdict.risk_label }}</span>
        </div>
        <div class="final">
          {{ verdict.final_client || '无法判定' }}
        </div>
        <p class="summary">
          <span class="badge" :class="statusClass" style="margin-right: 8px">
            {{ verdict.status_label }}
          </span>
          <span class="badge info">{{ verdict.outcome_label }}</span>
        </p>
        <p class="summary" style="margin-top: 8px">{{ verdict.summary }}</p>
      </div>

      <div class="grid" style="gap: 10px; margin-top: 14px">
        <div class="notice info">
          <strong>连接对端：</strong>
          <span class="mono">{{ result.peer.raw || '（未填写）' }}</span>
          →
          <span class="mono">{{ result.peer.normalized || '无法解析' }}</span>
          <span
            class="badge"
            :class="result.peer.trusted ? 'accent' : 'info'"
            style="margin-left: 8px"
          >
            {{ result.peer.trusted ? '可信代理' : '不可信来源' }}
          </span>
          <span v-if="result.peer.matched_entry" class="small muted">
            命中 {{ result.peer.matched_entry.value }}
            <template v-if="result.peer.matched_entry.label">
              （{{ result.peer.matched_entry.label }}）
            </template>
          </span>
          <span v-if="result.peer.problem" class="small">
            · {{ result.peer.problem }}
          </span>
        </div>
      </div>

      <div v-if="crossCheck" class="notice" :class="crossClass" style="margin-top: 12px">
        <strong>两种字段核对：</strong>{{ crossCheck.status_label }}
        <div class="small" style="margin-top: 4px">{{ crossCheck.message }}</div>
        <div v-if="crossCheck.applicable && Object.keys(crossCheck.sequences || {}).length" class="small mono" style="margin-top: 6px">
          <div v-for="(seq, key) in crossCheck.sequences" :key="key">
            {{ key }}: {{ seq.length ? seq.join(' → ') : '（空）' }}
          </div>
        </div>
      </div>

      <h3 style="margin: 18px 0 10px; font-size: 14px">判定步骤</h3>
      <ol class="timeline">
        <li v-for="(step, index) in result.steps" :key="index" :class="step.level">
          <div class="step-title">{{ step.title }}</div>
          <div class="step-detail">{{ step.detail }}</div>
        </li>
      </ol>

      <h3 style="margin: 18px 0 10px; font-size: 14px">逐跳明细</h3>
      <div v-if="!hopRows.length" class="empty">本次请求没有携带任何转发字段。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>字段</th>
              <th>位置</th>
              <th>原始内容</th>
              <th>规范化地址</th>
              <th>可信状态</th>
              <th>采用 / 排除</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="({ field, hop }, index) in hopRows" :key="`${field.key}-${hop.position}-${index}`">
              <td>
                <div>{{ field.label }}</div>
                <span class="badge" :class="field.used ? 'ok' : 'info'">
                  {{ field.status_label }}
                </span>
              </td>
              <td class="nowrap">
                第 {{ hop.position }} 项
                <div class="small muted">距对端 {{ hop.position_from_peer }}</div>
              </td>
              <td class="break mono">{{ hop.raw === '' ? '（空）' : hop.raw }}</td>
              <td class="break">
                <span class="mono">{{ hop.address || '—' }}</span>
                <template v-if="hop.port">:{{ hop.port }}</template>
                <div>
                  <span class="badge" :class="kindClass(hop.kind)" style="margin-top: 4px">
                    {{ kindLabel(hop.kind) }}
                  </span>
                </div>
                <div v-if="hop.note" class="small muted">{{ hop.note }}</div>
              </td>
              <td>
                <span class="badge" :class="trustClass(hop.trust)">{{ hop.trust_label }}</span>
                <div v-if="hop.matched_entry" class="small muted mono">
                  {{ hop.matched_entry.value }}
                </div>
              </td>
              <td>
                <span class="badge" :class="decisionClass(hop.decision)">
                  {{ hop.decision_label || '—' }}
                </span>
              </td>
              <td class="small">{{ hop.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!compact" style="margin-top: 18px">
        <h3 style="margin-bottom: 8px; font-size: 14px">判定依据与说明</h3>
        <div
          v-for="(reason, index) in result.reasons"
          :key="index"
          class="notice"
          :class="reason.severity === 'error' ? 'error' : reason.severity === 'warn' ? 'warn' : 'info'"
        >
          {{ reason.message }}
        </div>
        <details style="margin-top: 10px">
          <summary class="muted small" style="cursor: pointer">判定所依据的假设</summary>
          <ul class="small muted" style="margin: 8px 0 0; padding-left: 18px">
            <li v-for="(item, index) in result.assumptions" :key="index">{{ item }}</li>
          </ul>
        </details>
      </div>

      <div v-if="unparsedPeerNote" class="notice warn" style="margin-top: 12px">
        连接对端本身无法解析，本次判定没有可信起点。
      </div>

      <div v-if="result.config_name" class="notice info small" style="margin-top: 12px">
        使用配置：{{ result.config_name }}
      </div>
    </template>
  </div>
</template>
