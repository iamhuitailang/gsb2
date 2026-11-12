<template>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="margin:0">当前页面</h2>
      <div style="display:flex;gap:8px">
        <a href="/api/export/current?format=json" download>
          <button class="secondary">导出 JSON</button>
        </a>
        <a href="/api/export/current?format=csv" download>
          <button class="secondary">导出 CSV</button>
        </a>
      </div>
    </div>
    <table style="margin-top:16px">
      <thead>
        <tr>
          <th>URL</th><th>标题</th><th>页面更新时间</th><th>状态</th>
          <th>首次出现</th><th>最近采集</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in pages" :key="p.url">
          <td class="mono">{{ p.url }}</td>
          <td>{{ p.title }}</td>
          <td>{{ p.updated_text || '-' }}</td>
          <td><span class="badge" :class="p.status">{{ statusText(p.status) }}</span></td>
          <td>运行 #{{ p.first_seen_run }}</td>
          <td>{{ fmtTime(p.last_fetch_at) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!pages.length" style="color:#888">暂无数据。</p>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { api, fmtTime } from '../api'

const pages = ref([])

function statusText(s) {
  return { new: '新增', changed: '修改', unchanged: '未变', removed: '消失' }[s] || s
}

onMounted(async () => {
  pages.value = await api.listPages()
})
</script>
