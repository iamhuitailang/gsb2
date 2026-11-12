<template>
  <div>
    <div class="card" v-if="run">
      <h2 style="margin-top:0">
        运行 #{{ run.id }}
        <span class="badge" :class="run.status">{{ statusText(run.status) }}</span>
      </h2>
      <p style="color:#666;font-size:13px">
        {{ run.rule_name }} · 起始 {{ run.start_url }} · {{ fmtTime(run.started_at) }}
      </p>
      <div>
        <div class="stat"><div class="num">{{ run.queued }}</div><div class="lbl">排队</div></div>
        <div class="stat"><div class="num">{{ run.processing }}</div><div class="lbl">处理中</div></div>
        <div class="stat"><div class="num">{{ run.done }}</div><div class="lbl">完成</div></div>
        <div class="stat"><div class="num" style="color:#15803d">{{ run.n_new }}</div><div class="lbl">新增</div></div>
        <div class="stat"><div class="num" style="color:#a16207">{{ run.n_changed }}</div><div class="lbl">修改</div></div>
        <div class="stat"><div class="num" style="color:#64748b">{{ run.n_unchanged }}</div><div class="lbl">未变</div></div>
        <div class="stat"><div class="num" style="color:#b91c1c">{{ run.n_removed }}</div><div class="lbl">消失</div></div>
        <div class="stat"><div class="num" style="color:#b91c1c">{{ run.n_failed }}</div><div class="lbl">失败</div></div>
      </div>
      <p v-if="run.error" style="color:#b91c1c">{{ run.error }}</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">本轮页面</h3>
      <table>
        <thead>
          <tr><th>URL</th><th>标题</th><th>页面更新时间</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in pages" :key="p.url">
            <td class="mono">{{ p.url }}</td>
            <td>{{ p.title }}</td>
            <td>{{ p.updated_text || '-' }}</td>
            <td><span class="badge" :class="p.status">{{ statusText(p.status) }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, fmtTime } from '../api'

const route = useRoute()
const run = ref(null)
const pages = ref([])
let timer = null

function statusText(s) {
  return {
    running: '运行中', done: '完成', failed: '失败',
    new: '新增', changed: '修改', unchanged: '未变', removed: '消失',
  }[s] || s
}

async function load() {
  const id = route.params.id
  run.value = await api.getRun(id)
  pages.value = await api.runPages(id)
  if (run.value.status === 'running') {
    timer = setTimeout(load, 1000)
  }
}

onMounted(load)
onUnmounted(() => clearTimeout(timer))
</script>
