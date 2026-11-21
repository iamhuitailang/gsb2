<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api, formatTime } from '../api'
import ResultPanel from './ResultPanel.vue'

const props = defineProps({
  initialId: { type: Number, default: null },
})

const emit = defineEmits(['open'])

const filters = ref({
  status: '',
  outcome: '',
  source: '',
  date_from: '',
  date_to: '',
})
const items = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const detail = ref(null)
const detailLoading = ref(false)
const page = ref(0)
const pageSize = 20

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'determined', label: '已判定' },
  { value: 'undetermined', label: '无法判定' },
]

const outcomeOptions = [
  { value: '', label: '全部结论' },
  { value: 'trusted_chain', label: '可信代理链还原成功' },
  { value: 'untrusted_peer', label: '对端不可信，转发信息被忽略' },
  { value: 'direct_peer', label: '无可用的转发字段，采用连接对端' },
  { value: 'forwarding_disabled', label: '转发字段均未启用，采用连接对端' },
  { value: 'peer_invalid', label: '连接对端地址无法解析' },
  { value: 'malformed_hop', label: '转发链中存在无法解析的地址' },
  { value: 'duplicate_field', label: '同一转发字段重复出现' },
  { value: 'duplicate_hop', label: '转发链中存在重复地址' },
  { value: 'hop_limit_exceeded', label: '转发链长度超出配置上限' },
  { value: 'chain_incomplete', label: '链路未闭合，缺少原始客户端' },
  { value: 'field_conflict', label: '两种转发字段无法对应' },
  { value: 'order_conflict', label: '两种转发字段顺序冲突' },
  { value: 'single_conflict', label: '单值字段与链路结果不一致' },
  { value: 'no_field_usable', label: '没有可用于判定的转发字段' },
]

const sourceOptions = [
  { value: '', label: '全部来源' },
  { value: 'demo', label: '演示' },
  { value: 'manual', label: '手动提交' },
]

const outcomeLabelMap = computed(() =>
  Object.fromEntries(outcomeOptions.map((item) => [item.value, item.label])),
)

const queryParams = computed(() => ({
  status: filters.value.status || undefined,
  outcome: filters.value.outcome || undefined,
  source: filters.value.source || undefined,
  date_from: filters.value.date_from ? `${filters.value.date_from}T00:00:00Z` : undefined,
  date_to: filters.value.date_to ? `${filters.value.date_to}T23:59:59Z` : undefined,
}))

const hasMore = computed(() => (page.value + 1) * pageSize < total.value)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const body = await api.analyses({
      ...queryParams.value,
      limit: pageSize,
      offset: page.value * pageSize,
    })
    items.value = body.items
    total.value = body.total
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function applyFilters() {
  page.value = 0
  await load()
}

async function nextPage() {
  if (!hasMore.value) return
  page.value += 1
  await load()
}

async function prevPage() {
  if (page.value === 0) return
  page.value -= 1
  await load()
}

async function openDetail(id) {
  detailLoading.value = true
  error.value = ''
  try {
    detail.value = await api.analysis(id)
    emit('open', id)
  } catch (err) {
    error.value = err.message
  } finally {
    detailLoading.value = false
  }
}

async function removeRecord(id) {
  if (!window.confirm(`确定删除记录 #${id}？导出文件不会受影响。`)) return
  try {
    await api.deleteAnalysis(id)
    if (detail.value?.id === id) detail.value = null
    await load()
  } catch (err) {
    error.value = err.message
  }
}

function download(format) {
  const url = api.exportUrl({ ...queryParams.value, format })
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

const statusClass = (status) => (status === 'determined' ? 'ok' : 'unknown')

watch(
  () => props.initialId,
  async (id) => {
    if (id) {
      await load()
      await openDetail(id)
    }
  },
)

onMounted(async () => {
  await load()
  if (props.initialId) await openDetail(props.initialId)
})
</script>

<template>
  <div>
    <section class="card">
      <div class="card-head">
        <div>
          <h2>记录与导出</h2>
          <p class="hint">
            每条记录保存提交时的输入、当时的信任配置快照与判定结果。导出内容不包含本机文件路径。
          </p>
        </div>
        <div class="button-row">
          <button :disabled="!items.length" @click="download('json')">导出 JSON</button>
          <button :disabled="!items.length" @click="download('csv')">导出 CSV</button>
        </div>
      </div>

      <form class="filters" @submit.prevent="applyFilters">
        <div>
          <label for="filter-status">结论</label>
          <select id="filter-status" v-model="filters.status" @change="applyFilters">
            <option v-for="option in statusOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div>
          <label for="filter-outcome">判定类型</label>
          <select id="filter-outcome" v-model="filters.outcome" @change="applyFilters">
            <option v-for="option in outcomeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div>
          <label for="filter-source">来源</label>
          <select id="filter-source" v-model="filters.source" @change="applyFilters">
            <option v-for="option in sourceOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div>
          <label for="filter-from">起始日期</label>
          <input id="filter-from" v-model="filters.date_from" type="date" @change="applyFilters" />
        </div>
        <div>
          <label for="filter-to">结束日期</label>
          <input id="filter-to" v-model="filters.date_to" type="date" @change="applyFilters" />
        </div>
        <div>
          <button type="submit" :disabled="loading">查询</button>
        </div>
      </form>

      <div v-if="error" class="notice error" style="margin-top: 12px">{{ error }}</div>

      <div style="margin-top: 14px" class="card-head">
        <span class="hint">共 {{ total }} 条记录，当前第 {{ page + 1 }} 页</span>
        <div class="button-row">
          <button class="ghost" :disabled="page === 0 || loading" @click="prevPage">上一页</button>
          <button class="ghost" :disabled="!hasMore || loading" @click="nextPage">下一页</button>
        </div>
      </div>

      <div v-if="loading" class="loading">正在载入记录…</div>
      <div v-else-if="!items.length" class="empty">没有符合条件的记录。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>来源</th>
              <th>连接对端</th>
              <th>结论</th>
              <th>最终地址</th>
              <th>配置</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td class="mono">{{ item.id }}</td>
              <td class="nowrap small">{{ formatTime(item.created_at) }}</td>
              <td>
                <span class="badge" :class="item.source === 'demo' ? 'accent' : 'info'">
                  {{ item.source === 'demo' ? '演示' : '手动' }}
                </span>
              </td>
              <td class="mono break">{{ item.peer_raw || '（空）' }}</td>
              <td>
                <span class="badge" :class="statusClass(item.status)">
                  {{ item.status === 'determined' ? '已判定' : '无法判定' }}
                </span>
                <div class="small muted">{{ item.outcome_label }}</div>
              </td>
              <td class="mono break">{{ item.final_client || '—' }}</td>
              <td class="small break">{{ item.config_name }}</td>
              <td>
                <div class="record-actions">
                  <button class="ghost small" @click="openDetail(item.id)">查看</button>
                  <button class="ghost small danger" @click="removeRecord(item.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="detail" class="card">
      <div class="card-head">
        <div>
          <h2>记录 #{{ detail.id }}</h2>
          <p class="hint">
            {{ formatTime(detail.created_at) }} · {{ detail.source === 'demo' ? '演示' : '手动提交' }}
            <template v-if="detail.demo_slug"> · {{ detail.demo_slug }}</template>
          </p>
        </div>
        <button class="ghost" @click="detail = null">收起</button>
      </div>

      <div class="grid two">
        <div>
          <h3 style="font-size: 14px; margin-bottom: 8px">保存时的输入</h3>
          <dl class="kv">
            <dt>连接对端</dt>
            <dd class="mono break">{{ detail.peer_raw || '（空）' }}</dd>
            <template v-for="(entry, index) in detail.headers" :key="`${entry.name}-${index}`">
              <dt>{{ entry.header }}</dt>
              <dd class="mono break">{{ entry.value === '' ? '（空）' : entry.value }}</dd>
            </template>
          </dl>
          <h3 style="font-size: 14px; margin: 16px 0 8px">当时的信任配置</h3>
          <div class="small">
            <div><strong>名称：</strong>{{ detail.config_snapshot.name }}</div>
            <div class="chip-list" style="margin-top: 6px">
              <span v-for="entry in detail.config_snapshot.entries" :key="entry.value" class="chip">
                {{ entry.value }}<template v-if="entry.label"> · {{ entry.label }}</template>
              </span>
            </div>
            <div style="margin-top: 8px" class="muted">
              <div v-for="(policy, key) in detail.config_snapshot.fields" :key="key">
                {{ key }}：{{ policy.enabled ? '启用' : '未启用' }} · 上限 {{ policy.max_hops }}
              </div>
            </div>
          </div>
        </div>
        <div>
          <ResultPanel :result="detail.result" />
        </div>
      </div>
    </section>
  </div>
</template>
