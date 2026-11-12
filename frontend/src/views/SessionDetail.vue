<template>
  <section>
    <div class="toolbar" style="margin-bottom: 14px">
      <router-link to="/">← 返回对局列表</router-link>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="!detail" class="empty">加载中…</div>

    <template v-else>
      <div class="panel">
        <div class="toolbar" style="justify-content: space-between">
          <div>
            <h2 style="margin: 0 0 4px">{{ detail.session_id }}</h2>
            <span class="muted mono">
              result_hash: {{ detail.result_hash.slice(0, 16) }}… ·
              规则版本 {{ detail.rules_version }} · 事件格式 {{ detail.schema_version || '混合' }}
            </span>
          </div>
          <div class="toolbar">
            <span class="chip" :class="statusChipClass(detail.status)">{{ statusText(detail.status) }}</span>
            <span class="chip" :class="outcomeChipClass(detail.outcome)">
              {{ outcomeText(detail.outcome) }}
            </span>
            <button :disabled="reprocessing" @click="reprocess">
              {{ reprocessing ? '处理中…' : '按当前规则重新处理' }}
            </button>
          </div>
        </div>
      </div>

      <div class="panel">
        <h3 style="margin: 0 0 12px">统计结果（服务端计算，不采信客户端上报）</h3>
        <div class="stat-grid">
          <div class="stat">
            <div class="label">局时长</div>
            <div class="value">{{ formatDuration(detail.duration_seconds) }}</div>
          </div>
          <div class="stat">
            <div class="label">事件总数</div>
            <div class="value">{{ detail.total_events }}</div>
          </div>
          <div class="stat">
            <div class="label">关键行为次数</div>
            <div class="value">{{ detail.key_action_count }}</div>
          </div>
          <div class="stat">
            <div class="label">事件完整率</div>
            <div class="value" :style="detail.completeness_rate < 1 ? 'color: var(--warn)' : ''">
              {{ formatPercent(detail.completeness_rate) }}
            </div>
          </div>
          <div class="stat">
            <div class="label">异常总数</div>
            <div class="value" :style="detail.anomaly_total ? 'color: var(--danger)' : ''">
              {{ detail.anomaly_total }}
            </div>
          </div>
          <div class="stat">
            <div class="label">时间范围 (UTC)</div>
            <div class="value" style="font-size: 13px">
              {{ formatDateTime(detail.started_at) }}<br />→ {{ formatDateTime(detail.ended_at) }}
            </div>
          </div>
        </div>

        <h4 style="margin: 18px 0 8px">异常分类</h4>
        <div class="anomaly-grid">
          <div
            v-for="(count, key) in detail.anomaly_counts"
            :key="key"
            class="item"
            :class="{ zero: count === 0 }"
          >
            <span>{{ ANOMALY_LABELS[key] || key }}</span>
            <strong>{{ count }}</strong>
          </div>
        </div>

        <div v-if="detail.metrics.missing_sequences?.length" style="margin-top: 12px">
          <span class="chip danger">缺失序号：{{ detail.metrics.missing_sequences.join(', ') }}</span>
        </div>
        <div v-if="detail.metrics.key_action_breakdown && Object.keys(detail.metrics.key_action_breakdown).length"
             style="margin-top: 8px">
          <span class="chip gray" v-for="(n, action) in detail.metrics.key_action_breakdown" :key="action">
            {{ action }} × {{ n }}
          </span>
        </div>
      </div>

      <div class="panel">
        <div class="tabs">
          <button :class="{ active: tab === 'timeline' }" @click="tab = 'timeline'">
            重建时间线（{{ detail.timeline.length }}）
          </button>
          <button :class="{ active: tab === 'raw' }" @click="switchRaw">
            原始事件/接收顺序（{{ rawCount }}）
          </button>
        </div>

        <div v-if="tab === 'timeline'">
          <p class="muted" style="margin-top: 0">
            按 sequence → occurred_at → event_id 确定性排序；同一原始事件与规则版本永远得到相同顺序。
          </p>
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>事件类型</th>
                <th>发生时间 (UTC)</th>
                <th>接收时间 (UTC)</th>
                <th class="wrap">payload</th>
                <th class="wrap">标记</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in detail.timeline" :key="item.event_id">
                <td>{{ item.sequence }}</td>
                <td>
                  {{ item.event_type }}
                  <span v-if="item.is_key_action" class="chip ok" style="margin-left: 4px">关键</span>
                </td>
                <td>{{ formatDateTime(item.occurred_at) }}</td>
                <td class="muted">{{ formatDateTime(item.received_at) }}</td>
                <td class="wrap"><pre class="payload">{{ JSON.stringify(item.payload, null, 2) }}</pre></td>
                <td class="wrap">
                  <span v-if="item.flags.length === 0" class="muted">—</span>
                  <span v-for="flag in item.flags" :key="flag" class="chip danger" style="margin: 2px">
                    {{ ANOMALY_LABELS[flag] || flag }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else>
          <p class="muted" style="margin-top: 0">
            原始事件按服务端实际接收顺序排列，用于核对乱序、重试与迟到；被拒收的事件不会入库。
          </p>
          <div v-if="rawError" class="error-banner">{{ rawError }}</div>
          <div v-else-if="!raw" class="empty">加载中…</div>
          <table v-else>
            <thead>
              <tr>
                <th>event_id</th>
                <th>序号</th>
                <th>事件类型</th>
                <th>发生时间 (UTC)</th>
                <th>接收时间 (UTC)</th>
                <th class="wrap">payload</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ev in raw.events" :key="ev.event_id">
                <td class="mono">{{ ev.event_id }}</td>
                <td>{{ ev.sequence }}</td>
                <td>{{ ev.event_type }}</td>
                <td>{{ formatDateTime(ev.occurred_at) }}</td>
                <td class="muted">{{ formatDateTime(ev.received_at) }}</td>
                <td class="wrap"><pre class="payload">{{ JSON.stringify(ev.payload, null, 2) }}</pre></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import {
  ANOMALY_LABELS,
  formatDateTime,
  formatDuration,
  formatPercent,
  outcomeChipClass,
  outcomeText,
  statusChipClass,
  statusText,
} from '../format.js'

const props = defineProps({ sessionId: { type: String, required: true } })

const detail = ref(null)
const raw = ref(null)
const rawCount = ref(0)
const tab = ref('timeline')
const error = ref('')
const rawError = ref('')
const reprocessing = ref(false)

async function loadDetail() {
  error.value = ''
  try {
    detail.value = await api.getSession(props.sessionId)
  } catch (e) {
    error.value = `加载对局失败：${e.message}`
  }
}

async function loadRaw() {
  rawError.value = ''
  raw.value = null
  try {
    raw.value = await api.getRawEvents(props.sessionId)
    rawCount.value = raw.value.events.length
  } catch (e) {
    rawError.value = `加载原始事件失败：${e.message}`
  }
}

function switchRaw() {
  tab.value = 'raw'
  if (!raw.value) loadRaw()
}

async function reprocess() {
  reprocessing.value = true
  try {
    const result = await api.reprocess(props.sessionId)
    await loadDetail()
    if (raw.value) await loadRaw()
    window.alert(`重新处理完成\n规则版本：${result.rules_version}\nresult_hash：${result.result_hash}`)
  } catch (e) {
    window.alert(`重新处理失败：${e.message}`)
  } finally {
    reprocessing.value = false
  }
}

onMounted(loadDetail)
</script>
