<template>
  <section>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <div class="panel">
      <div class="filters">
        <div class="field">
          <label for="f-player">玩家</label>
          <select id="f-player" v-model="filters.player_id">
            <option value="">全部玩家</option>
            <option v-for="p in players" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="field">
          <label for="f-date">日期（UTC）</label>
          <input id="f-date" type="date" v-model="filters.date" />
        </div>
        <div class="field">
          <label for="f-start">起始日期</label>
          <input id="f-start" type="date" v-model="filters.start_date" />
        </div>
        <div class="field">
          <label for="f-end">结束日期</label>
          <input id="f-end" type="date" v-model="filters.end_date" />
        </div>
        <div class="field">
          <label for="f-status">对局状态</label>
          <select id="f-status" v-model="filters.status">
            <option value="">全部</option>
            <option value="completed">已结束</option>
            <option value="open">进行中</option>
          </select>
        </div>
        <div class="field">
          <label for="f-outcome">胜负</label>
          <select id="f-outcome" v-model="filters.outcome">
            <option value="">全部</option>
            <option value="win">胜</option>
            <option value="loss">负</option>
            <option value="draw">平</option>
          </select>
        </div>
        <div class="field">
          <label for="f-anomaly">异常</label>
          <select id="f-anomaly" v-model="filters.has_anomaly">
            <option value="">全部</option>
            <option value="true">仅有异常</option>
            <option value="false">仅无异常</option>
          </select>
        </div>
        <div class="toolbar">
          <button class="primary" @click="applyFilters">查询</button>
          <button @click="resetFilters">重置</button>
          <button @click="exportCsv">导出 CSV</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="toolbar" style="justify-content: space-between; margin-bottom: 10px">
        <strong>对局列表（共 {{ data.total }} 局）</strong>
        <span class="muted">结果由服务端规则引擎生成，规则版本 {{ data.rules_version }}</span>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="data.items.length === 0" class="empty">没有符合条件的对局</div>
      <table v-else>
        <thead>
          <tr>
            <th>对局 ID</th>
            <th>玩家</th>
            <th>开始时间 (UTC)</th>
            <th>状态</th>
            <th>胜负</th>
            <th>时长</th>
            <th>事件数</th>
            <th>关键行为</th>
            <th>完整率</th>
            <th>异常</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in data.items" :key="row.session_id">
            <td>
              <router-link :to="`/sessions/${encodeURIComponent(row.session_id)}`">
                {{ row.session_id }}
              </router-link>
            </td>
            <td>{{ row.player_id }}</td>
            <td>{{ formatDateTime(row.started_at) }}</td>
            <td><span class="chip" :class="statusChipClass(row.status)">{{ statusText(row.status) }}</span></td>
            <td><span class="chip" :class="outcomeChipClass(row.outcome)">{{ outcomeText(row.outcome) }}</span></td>
            <td>{{ formatDuration(row.duration_seconds) }}</td>
            <td>{{ row.total_events }}</td>
            <td>{{ row.key_action_count }}</td>
            <td :style="row.completeness_rate < 1 ? 'color: var(--warn); font-weight: 600' : ''">
              {{ formatPercent(row.completeness_rate) }}
            </td>
            <td>
              <span v-if="row.anomaly_total === 0" class="chip ok">正常</span>
              <span v-else class="chip danger">{{ row.anomaly_total }} 项</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="data.total > pageSize" class="pagination">
        <button :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
        <span class="muted">第 {{ page }} 页 / 共 {{ totalPages }} 页</span>
        <button :disabled="page >= totalPages" @click="changePage(page + 1)">下一页</button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import {
  formatDateTime,
  formatDuration,
  formatPercent,
  outcomeChipClass,
  outcomeText,
  statusChipClass,
  statusText,
} from '../format.js'

const pageSize = 20
const page = ref(1)
const loading = ref(false)
const error = ref('')
const players = ref([])
const data = ref({ total: 0, items: [], rules_version: '' })

const emptyFilters = () => ({
  player_id: '',
  date: '',
  start_date: '',
  end_date: '',
  status: '',
  outcome: '',
  has_anomaly: '',
})

const filters = reactive(emptyFilters())
const applied = ref(emptyFilters())

const totalPages = computed(() => Math.max(1, Math.ceil(data.value.total / pageSize)))

function activeFilters() {
  const out = {}
  for (const [k, v] of Object.entries(applied.value)) {
    if (v !== '') out[k] = v
  }
  return out
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.listSessions(activeFilters(), page.value, pageSize)
  } catch (e) {
    error.value = `加载失败：${e.message}`
  } finally {
    loading.value = false
  }
}

function applyFilters() {
  applied.value = { ...filters }
  page.value = 1
  load()
}

function resetFilters() {
  Object.assign(filters, emptyFilters())
  applied.value = emptyFilters()
  page.value = 1
  load()
}

function changePage(next) {
  page.value = next
  load()
}

function exportCsv() {
  // Same filters as the current query; the browser handles the download.
  window.open(api.exportCsvUrl(activeFilters()), '_blank')
}

onMounted(async () => {
  try {
    players.value = (await api.players()).players
  } catch {
    players.value = []
  }
  load()
})
</script>
