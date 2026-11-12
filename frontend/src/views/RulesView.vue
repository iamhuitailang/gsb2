<template>
  <div>
    <div class="card" v-for="rule in rules" :key="rule.id">
      <h2 style="margin-top:0">采集规则</h2>
      <label>名称</label>
      <input v-model="rule.name">
      <label>起始地址</label>
      <input v-model="rule.start_url" placeholder="http://127.0.0.1:8001/index.html">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div>
          <label>最大页面数</label>
          <input type="number" v-model.number="rule.max_pages">
        </div>
        <div>
          <label>请求间隔（毫秒）</label>
          <input type="number" v-model.number="rule.delay_ms">
        </div>
        <div>
          <label>失败重试次数</label>
          <input type="number" v-model.number="rule.retry_times">
        </div>
      </div>
      <label>包含路径（正则，留空不限制）</label>
      <input v-model="rule.include_pattern" placeholder="例如 /articles/">
      <label>排除路径（正则，留空不排除）</label>
      <input v-model="rule.exclude_pattern" placeholder="例如 \\.css$">
      <label style="margin-top:12px">
        <input type="checkbox" v-model="rule.same_domain" style="width:auto"> 仅采集同域页面
      </label>
      <div style="margin-top:16px;display:flex;gap:10px">
        <button @click="save(rule)">保存规则</button>
        <button class="secondary" @click="start(rule)">开始新一轮采集</button>
        <span v-if="msg" style="align-self:center;color:#15803d">{{ msg }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

const rules = ref([])
const msg = ref('')
const router = useRouter()

onMounted(async () => {
  rules.value = await api.listRules()
})

async function save(rule) {
  await api.updateRule(rule.id, rule)
  msg.value = '已保存'
  setTimeout(() => (msg.value = ''), 2000)
}

async function start(rule) {
  await save(rule)
  const { run_id } = await api.startRun(rule.id)
  router.push(`/runs/${run_id}`)
}
</script>
