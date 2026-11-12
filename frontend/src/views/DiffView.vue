<template>
  <div>
    <div class="card">
      <h2 style="margin-top:0">两次运行的差异</h2>
      <div style="display:flex;gap:12px;align-items:flex-end">
        <div style="flex:1">
          <label>基准运行（旧）</label>
          <select v-model.number="runA">
            <option v-for="r in finishedRuns" :key="r.id" :value="r.id">
              #{{ r.id }} · {{ fmtTime(r.started_at) }}
            </option>
          </select>
        </div>
        <div style="flex:1">
          <label>对比运行（新）</label>
          <select v-model.number="runB">
            <option v-for="r in finishedRuns" :key="r.id" :value="r.id">
              #{{ r.id }} · {{ fmtTime(r.started_at) }}
            </option>
          </select>
        </div>
        <button @click="compare" :disabled="!runA || !runB || runA === runB">对比</button>
      </div>
    </div>

    <div class="card" v-if="items">
      <h3 style="margin-top:0">页面级变化（{{ changedItems.length }} / {{ items.length }} 有变化）</h3>
      <table>
        <thead>
          <tr><th>URL</th><th>标题</th><th>变化</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.url" :style="it.change === 'same' ? 'opacity:.55' : ''">
            <td class="mono">{{ it.url }}</td>
            <td>{{ it.title }}</td>
            <td><span class="badge" :class="it.change">{{ changeText(it.change) }}</span></td>
            <td>
              <a v-if="it.change === 'modified'" class="link" @click="showDiff(it.url)">查看正文差异</a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-if="pageDiff">
      <h3 style="margin-top:0">正文差异：{{ pageDiff.url }}</h3>
      <p style="font-size:13px;color:#666">
        旧更新时间：{{ pageDiff.a?.updated_text || '-' }} →
        新更新时间：{{ pageDiff.b?.updated_text || '-' }}
      </p>
      <pre class="diff mono"><div
        v-for="(line, i) in diffLines" :key="i"
        :class="lineClass(line)"
      >{{ line }}</div></pre>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { api, fmtTime } from '../api'

const runs = ref([])
const runA = ref(null)
const runB = ref(null)
const items = ref(null)
const pageDiff = ref(null)

const finishedRuns = computed(() => runs.value.filter((r) => r.status === 'done'))
const changedItems = computed(() => (items.value || []).filter((i) => i.change !== 'same'))
const diffLines = computed(() => (pageDiff.value?.diff || '').split('\n'))

function changeText(c) {
  return { appeared: '新增', disappeared: '消失', modified: '修改', same: '未变' }[c] || c
}
function lineClass(line) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-del'
  if (line.startsWith('@@')) return 'diff-hunk'
  return ''
}

async function compare() {
  pageDiff.value = null
  items.value = await api.diff(runA.value, runB.value)
}

async function showDiff(url) {
  pageDiff.value = await api.diffPage(runA.value, runB.value, url)
}

onMounted(async () => {
  runs.value = await api.listRuns()
  const done = finishedRuns.value
  if (done.length >= 2) {
    runA.value = done[1].id
    runB.value = done[0].id
  }
})
</script>

<style scoped>
.diff { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; }
.diff-add { color: #4ade80; }
.diff-del { color: #f87171; }
.diff-hunk { color: #93c5fd; }
</style>
