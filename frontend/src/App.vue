<script setup>
import { onMounted, ref } from 'vue'
import { api, FIELD_ORDER } from './api'
import AnalyzeView from './components/AnalyzeView.vue'
import DemosView from './components/DemosView.vue'
import TrustConfigView from './components/TrustConfigView.vue'
import RecordsView from './components/RecordsView.vue'

const tabs = [
  { key: 'analyze', label: '发起判定' },
  { key: 'demos', label: '演示请求' },
  { key: 'config', label: '信任配置' },
  { key: 'records', label: '记录与导出' },
]

const active = ref('analyze')
const health = ref(null)
const healthError = ref('')
const configs = ref([])
const demoCount = ref(0)

// Shared form state so demos can populate the analysis form.
const form = ref({
  peer: '',
  headers: {
    x_forwarded_for: [''],
    forwarded: [''],
    x_real_ip: [''],
    cf_connecting_ip: [''],
  },
  configId: null,
  config: null,
})

const result = ref(null)
const resultMeta = ref(null)
const lastAnalysisId = ref(null)
const analyzeError = ref(null)
const analyzing = ref(false)
const notice = ref('')

async function refreshConfigs() {
  try {
    const listing = await api.configs()
    configs.value = listing.items
    if (!form.value.config && listing.items.length) {
      loadConfigIntoForm(listing.items[0])
    }
  } catch (error) {
    console.error(error)
  }
}

function loadConfigIntoForm(saved) {
  form.value.configId = saved.id
  form.value.config = JSON.parse(JSON.stringify(saved.config))
}

async function bootstrap() {
  try {
    health.value = await api.health()
  } catch (error) {
    healthError.value = error.message
  }
  try {
    const listing = await api.configs()
    configs.value = listing.items
    if (listing.items.length) {
      loadConfigIntoForm(listing.items[0])
    }
  } catch (error) {
    console.error(error)
  }
  try {
    const demos = await api.demos()
    demoCount.value = demos.items.length
  } catch (error) {
    console.error(error)
  }
}

async function runAnalysis() {
  analyzing.value = true
  analyzeError.value = null
  notice.value = ''
  try {
    const headers = {}
    if (!form.value.config) {
      throw new Error('请先在「信任配置」页保存一份配置')
    }
    FIELD_ORDER.forEach((key) => {
      const lines = (form.value.headers[key] || []).filter(
        (line) => line !== null && line !== undefined && String(line).trim() !== '',
      )
      if (lines.length === 1) {
        headers[key] = lines[0]
      } else if (lines.length > 1) {
        headers[key] = lines
      }
    })
    const body = await api.analyze({
      peer: form.value.peer,
      headers,
      config: form.value.config,
      save: true,
      source: 'manual',
    })
    result.value = body.result
    resultMeta.value = body
    lastAnalysisId.value = body.analysis_id
    notice.value = body.analysis_id
      ? `已保存记录 #${body.analysis_id}`
      : '已生成判定（未保存记录）'
    active.value = 'analyze'
  } catch (error) {
    analyzeError.value = error
  } finally {
    analyzing.value = false
  }
}

function applyDemo(payload) {
  form.value.peer = payload.peer
  const headers = { x_forwarded_for: [''], forwarded: [''], x_real_ip: [''], cf_connecting_ip: [''] }
  FIELD_ORDER.forEach((key) => {
    const value = payload.headers?.[key]
    headers[key] = value === null || value === undefined ? [''] : [...value]
  })
  form.value.headers = headers
  form.value.configId = null
  form.value.config = JSON.parse(JSON.stringify(payload.config))
  result.value = payload.result || null
  resultMeta.value = payload.resultMeta || null
  lastAnalysisId.value = payload.analysisId || null
  analyzeError.value = null
  notice.value = payload.notice || ''
  active.value = 'analyze'
}

function showDemoResult({ demo, body }) {
  // Populate the analysis form so the hop table is inspectable, but switch
  // tabs only when the user chooses to (running a demo already shows an
  // inline result card on the demo page).
  const full = body.demo || demo
  form.value.peer = full.peer
  const headers = { x_forwarded_for: [''], forwarded: [''], x_real_ip: [''], cf_connecting_ip: [''] }
  FIELD_ORDER.forEach((key) => {
    const value = full.headers?.[key]
    headers[key] = value === null || value === undefined ? [''] : [...value]
  })
  form.value.headers = headers
  form.value.configId = null
  form.value.config = JSON.parse(JSON.stringify(full.config))
  result.value = body.result
  resultMeta.value = body
  lastAnalysisId.value = body.analysis_id
  analyzeError.value = null
  notice.value = body.analysis_id
    ? `演示「${full.title || demo.title}」已保存为记录 #${body.analysis_id}`
    : `演示「${full.title || demo.title}」已执行（未保存）`
}

function makeTemporaryConfig() {
  const config = {
    name: '临时信任配置',
    entries: [{ value: '10.0.0.0/8', label: '内网反向代理' }],
    fields: {
      x_forwarded_for: { enabled: true, max_hops: 5 },
      forwarded: { enabled: false, max_hops: 5 },
      x_real_ip: { enabled: false, max_hops: 1 },
      cf_connecting_ip: { enabled: false, max_hops: 1 },
    },
  }
  form.value.configId = null
  form.value.config = config
}

function openRecord(recordId) {
  lastAnalysisId.value = recordId
  active.value = 'records'
}

onMounted(bootstrap)
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div>
        <h1>转发地址安全分析台</h1>
        <p class="subtitle">
          复盘反向代理传来的客户端地址：逐跳说明哪些地址可被信任、哪些输入可能被伪造。
          仅处理本地提交的样例数据，不向任何外部地址发起请求。
        </p>
      </div>
      <div class="status-pill">
        <span class="dot" :class="healthError ? 'bad' : health ? 'ok' : 'warn'"></span>
        <span v-if="healthError">后端不可达：{{ healthError }}</span>
        <span v-else-if="health">后端就绪 · SQLite · 记录 {{ health.counts?.analyses ?? 0 }} 条</span>
        <span v-else>正在连接后端…</span>
      </div>
    </header>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: active === tab.key }"
        @click="active = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <AnalyzeView
      v-if="active === 'analyze'"
      v-model:form="form"
      :configs="configs"
      :result="result"
      :result-meta="resultMeta"
      :error="analyzeError"
      :analyzing="analyzing"
      :notice="notice"
      :last-analysis-id="lastAnalysisId"
      @submit="runAnalysis"
      @load-config="loadConfigIntoForm"
      @create-config="makeTemporaryConfig"
      @open-record="openRecord"
    />

    <DemosView
      v-else-if="active === 'demos'"
      @apply="applyDemo"
      @show-result="showDemoResult"
      @changed="refreshConfigs"
      @go-analyze="active = 'analyze'"
    />

    <TrustConfigView
      v-else-if="active === 'config'"
      :configs="configs"
      @saved="refreshConfigs"
      @use-config="loadConfigIntoForm"
      @go-analyze="active = 'analyze'"
    />

    <RecordsView
      v-else-if="active === 'records'"
      :initial-id="lastAnalysisId"
      @open="openRecord"
    />
  </div>
</template>
