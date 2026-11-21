<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../api'

const emit = defineEmits(['apply', 'show-result', 'changed', 'go-analyze'])

const demos = ref([])
const loading = ref(true)
const error = ref('')
const runningSlug = ref('')
const demoResults = ref({})
const demoErrors = ref({})
const resetting = ref(false)
const resetMessage = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const listing = await api.demos()
    demos.value = listing.items
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function loadDemo(slug) {
  try {
    const payload = await api.demo(slug)
    emit('apply', {
      slug,
      peer: payload.peer,
      headers: payload.headers,
      config: payload.config,
      result: null,
      resultMeta: null,
      notice: `已载入演示「${payload.title}」，可直接修改后再判定`,
    })
  } catch (err) {
    demoErrors.value = { ...demoErrors.value, [slug]: err.message }
  }
}

async function runDemo(demo) {
  runningSlug.value = demo.slug
  demoErrors.value = { ...demoErrors.value, [demo.slug]: '' }
  try {
    const body = await api.runDemo(demo.slug, true)
    demoResults.value = { ...demoResults.value, [demo.slug]: body }
    emit('show-result', { demo, body })
    emit('changed')
  } catch (err) {
    demoErrors.value = { ...demoErrors.value, [demo.slug]: err.message }
  } finally {
    runningSlug.value = ''
  }
}

async function resetDemoData() {
  resetting.value = true
  resetMessage.value = ''
  try {
    const body = await api.resetDemoData()
    resetMessage.value = `已删除 ${body.deleted} 条演示记录；当前剩余记录 ${body.counts.analyses} 条。`
    demoResults.value = {}
    emit('changed')
  } catch (err) {
    resetMessage.value = err.message
  } finally {
    resetting.value = false
  }
}

function expectationBadge(expectation) {
  return expectation.status === 'determined' ? 'ok' : 'unknown'
}

onMounted(load)
</script>

<template>
  <div>
    <section class="card">
      <div class="card-head">
        <div>
          <h2>演示请求</h2>
          <p class="hint">
            每个示例都自带信任配置，全部离线运行。可以直接运行看结果，也可以载入到「发起判定」页修改后再判。
          </p>
        </div>
        <div class="button-row">
          <button :disabled="resetting" @click="resetDemoData">
            {{ resetting ? '清理中…' : '清理演示数据' }}
          </button>
        </div>
      </div>

      <div v-if="resetMessage" class="notice info">{{ resetMessage }}</div>
      <div v-if="loading" class="loading">正在载入演示…</div>
      <div v-else-if="error" class="notice error">{{ error }}</div>
      <div v-else-if="!demos.length" class="empty">没有可用的演示。</div>

      <div v-for="demo in demos" :key="demo.slug" class="demo-card">
        <div class="card-head" style="margin-bottom: 4px">
          <div>
            <h3>{{ demo.title }}</h3>
            <p class="desc">{{ demo.description }}</p>
          </div>
          <span class="badge" :class="expectationBadge(demo.expectation)">
            预期：{{ demo.expectation.outcome_label }}
          </span>
        </div>
        <div class="expect">
          <div>
            <strong>预期最终地址：</strong>
            <span class="mono">{{ demo.expectation.final_client || '无法判定' }}</span>
          </div>
          <div class="muted">{{ demo.expectation.note }}</div>
        </div>
        <div class="button-row" style="margin-top: 10px">
          <button class="primary" :disabled="runningSlug === demo.slug" @click="runDemo(demo)">
            {{ runningSlug === demo.slug ? '运行中…' : '运行演示' }}
          </button>
          <button @click="loadDemo(demo.slug)">载入到判定页</button>
          <span class="small muted">配置：{{ demo.config_name }}</span>
        </div>
        <div v-if="demoErrors[demo.slug]" class="notice error" style="margin-top: 8px">
          {{ demoErrors[demo.slug] }}
        </div>
        <div v-if="demoResults[demo.slug]" class="notice" :class="demoResults[demo.slug].expectation_check?.passed ? 'ok' : 'warn'" style="margin-top: 8px">
          <strong>实际结果：</strong>
          {{ demoResults[demo.slug].result.verdict.outcome_label }} ·
          <span class="mono">{{ demoResults[demo.slug].result.verdict.final_client || '无法判定' }}</span>
          <span class="small" style="margin-left: 8px">
            {{ demoResults[demo.slug].expectation_check?.passed ? '与预期一致' : '与预期不一致，请查看明细' }}
          </span>
          <div class="small">
            记录 #{{ demoResults[demo.slug].analysis_id }}，可在「记录与导出」页查找。
          </div>
          <div class="small" style="margin-top: 4px">
            已同步到「发起判定」页，可查看逐跳明细。
            <button class="ghost small" style="margin-left: 4px" @click="emit('go-analyze')">
              打开判定页
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
