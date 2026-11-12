<template>
  <div class="panel">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin: 0">4. 处理任务</h2>
      <div class="row" style="gap: 8px">
        <span class="muted" style="font-size: 12px">
          并发上限 {{ concurrency }} · 运行中 {{ runningCount }} · 每 1 秒刷新
        </span>
        <button class="ghost" @click="cleanupTemp">清理临时文件</button>
        <button class="ghost" @click="refresh">立即刷新</button>
      </div>
    </div>

    <div v-if="!tasks.length" class="muted" style="padding: 20px 0; text-align: center">
      暂无任务。提交裁切后会在这里显示，刷新页面也不会丢失。
    </div>

    <div v-for="task in tasks" :key="task.id" class="task-card">
      <div class="task-head">
        <div>
          <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] || task.status }}</span>
          <b style="margin-left: 8px">{{ fileName(task.file_id) }}</b>
        </div>
        <div class="row" style="gap: 8px">
          <button
            v-if="task.status === 'queued' || task.status === 'processing'"
            class="danger"
            @click="cancel(task)"
          >
            取消任务
          </button>
          <button
            v-if="['succeeded', 'failed', 'canceled'].includes(task.status)"
            class="ghost"
            @click="remove(task)"
          >
            删除记录
          </button>
        </div>
      </div>

      <div class="task-meta">
        <span>区间：<b class="mono">{{ msToText(task.start_ms) }} → {{ msToText(task.end_ms) }}</b></span>
        <span>时长：<b class="mono">{{ msToText(task.duration_ms) }}</b></span>
        <span>格式：{{ task.format.toUpperCase() }}</span>
        <span>视频：{{ task.video_codec }}</span>
        <span>音频：{{ task.audio_codec }}</span>
        <span v-if="task.crf !== null">CRF {{ task.crf }}</span>
        <span v-if="task.preset">preset {{ task.preset }}</span>
        <span v-if="task.video_bitrate">-b:v {{ task.video_bitrate }}</span>
        <span v-if="task.audio_bitrate">-b:a {{ task.audio_bitrate }}</span>
      </div>

      <div v-if="task.status === 'queued' || task.status === 'processing'" class="row">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: (task.status === 'queued' ? 0 : task.progress) + '%' }" />
        </div>
        <span class="mono">{{ task.status === 'queued' ? '排队中' : task.progress + '%' }}</span>
      </div>

      <div v-if="task.status === 'succeeded'" class="row" style="margin-top: 10px">
        <video controls style="max-height: 220px; max-width: 420px" :src="api.previewUrl(task.id)" />
        <div style="display: flex; flex-direction: column; gap: 8px">
          <span class="muted">输出大小：{{ formatBytes(task.output_size) }}</span>
          <a :href="api.previewUrl(task.id)" target="_blank">新窗口预览</a>
          <a :href="api.downloadUrl(task.id)">下载结果文件</a>
        </div>
      </div>

      <div v-if="task.status === 'failed'" class="error-text">
        失败原因：{{ task.error }}
      </div>
      <div v-if="task.status === 'canceled'" class="muted">
        任务已取消，临时文件已清理。
      </div>

      <details class="cmd-box" v-if="task.ffmpeg_cmd && task.ffmpeg_cmd !== '[]'">
        <summary>查看实际执行的 FFmpeg 命令</summary>
        <pre class="mono">{{ prettyCmd(task.ffmpeg_cmd) }}</pre>
      </details>
      <div class="task-meta" style="margin-top: 6px">
        <span>创建：{{ formatTime(task.created_at) }}</span>
        <span v-if="task.finished_at">结束：{{ formatTime(task.finished_at) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api'
import { formatBytes, formatTime, msToText } from '../utils/time'

const props = defineProps({
  files: { type: Array, default: () => [] },
  concurrency: { type: Number, default: 2 },
})

const tasks = ref([])
const error = ref('')
let timer = null

const STATUS_LABELS = {
  queued: '排队中',
  processing: '处理中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const runningCount = computed(
  () => tasks.value.filter((t) => t.status === 'processing').length
)

onMounted(async () => {
  await refresh()
  // 页面隐藏时暂停轮询，省资源；可见性恢复时立即刷新
  document.addEventListener('visibilitychange', onVisibility)
  timer = setInterval(refresh, 1000)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibility)
})

function onVisibility() {
  if (document.hidden) {
    clearInterval(timer)
    timer = null
  } else if (!timer) {
    refresh()
    timer = setInterval(refresh, 1000)
  }
}

async function refresh() {
  try {
    tasks.value = await api.listTasks()
    error.value = ''
  } catch (err) {
    error.value = err.message
  }
}

function fileName(fileId) {
  return props.files.find((f) => f.id === fileId)?.original_name || fileId.slice(0, 8)
}

function prettyCmd(raw) {
  try {
    return JSON.parse(raw).join(' \\\n  ')
  } catch {
    return raw
  }
}

async function cancel(task) {
  if (!window.confirm(`确定取消任务？将停止 FFmpeg 进程并删除临时文件。`)) return
  try {
    await api.cancelTask(task.id)
    await refresh()
  } catch (err) {
    error.value = err.message
  }
}

async function remove(task) {
  if (!window.confirm('删除该任务记录？已生成的输出文件也会一并删除。')) return
  try {
    await api.deleteTask(task.id)
    await refresh()
  } catch (err) {
    error.value = err.message
  }
}

async function cleanupTemp() {
  try {
    const result = await api.cleanupTemp()
    window.alert(
      `清理完成：删除 ${result.removed_temp} 个临时目录，释放 ${formatBytes(result.freed_bytes)}。`
    )
  } catch (err) {
    error.value = err.message
  }
}

defineExpose({ refresh })
</script>
