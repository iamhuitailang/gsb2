<template>
  <div class="card">
    <h2 style="margin-top:0">运行记录</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>规则</th><th>状态</th>
          <th>排队</th><th>处理中</th><th>完成</th>
          <th>新增</th><th>修改</th><th>未变</th><th>消失</th><th>失败</th>
          <th>开始时间</th><th>耗时</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in runs" :key="r.id">
          <td><RouterLink class="link" :to="`/runs/${r.id}`">{{ r.id }}</RouterLink></td>
          <td>{{ r.rule_name }}</td>
          <td><span class="badge" :class="r.status">{{ statusText(r.status) }}</span></td>
          <td>{{ r.queued }}</td>
          <td>{{ r.processing }}</td>
          <td>{{ r.done }}</td>
          <td>{{ r.n_new }}</td>
          <td>{{ r.n_changed }}</td>
          <td>{{ r.n_unchanged }}</td>
          <td>{{ r.n_removed }}</td>
          <td>{{ r.n_failed }}</td>
          <td>{{ fmtTime(r.started_at) }}</td>
          <td>{{ duration(r) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!runs.length" style="color:#888">还没有运行记录，请先在「采集规则」中启动一轮采集。</p>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api, fmtTime } from '../api'

const runs = ref([])
let timer = null

function statusText(s) {
  return { running: '运行中', done: '完成', failed: '失败' }[s] || s
}
function duration(r) {
  if (!r.finished_at) return '-'
  return ((r.finished_at - r.started_at).toFixed(1)) + 's'
}

async function load() {
  runs.value = await api.listRuns()
  // 有运行中的任务时持续轮询
  if (runs.value.some((r) => r.status === 'running')) {
    timer = setTimeout(load, 1000)
  }
}

onMounted(load)
onUnmounted(() => clearTimeout(timer))
</script>
