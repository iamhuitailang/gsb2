<template>
  <h1>本地视频裁切与转码工具</h1>
  <p class="subtitle">
    基于真实 FFmpeg 的本地处理：毫秒级裁切、格式转换、编码参数可调，任务持久化到 SQLite。
  </p>

  <div v-if="toast" class="toast" @click="toast = ''">{{ toast }}</div>

  <FileUpload v-model="selectedFile" :max-mb="maxMb" @uploaded="onUploaded" />

  <VideoTrim
    v-if="options"
    :file="selectedFile"
    :options="options"
    @created="onTaskCreated"
  />
  <div v-else class="panel muted">正在加载编码选项…</div>

  <TaskList ref="taskListRef" :files="files" :concurrency="concurrency" />

  <p class="muted" style="font-size: 12px; margin-top: 20px">
    所有处理均在本机完成，文件不会上传到外部服务。上传与输出文件保存在后端
    <span class="mono">data/</span> 目录，详见 README 的清理说明。
  </p>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import FileUpload from './components/FileUpload.vue'
import VideoTrim from './components/VideoTrim.vue'
import TaskList from './components/TaskList.vue'
import { api } from './api'

const selectedFile = ref(null)
const options = ref(null)
const files = ref([])
const toast = ref('')
const maxMb = ref(2048)
const concurrency = ref(2)
const taskListRef = ref(null)

onMounted(async () => {
  try {
    options.value = await api.options()
    files.value = await api.listFiles()
    const health = await api.health()
    concurrency.value = health.max_concurrent_tasks
  } catch (err) {
    showToast('初始化失败：' + err.message)
  }
})

function onUploaded(file) {
  files.value = [file, ...files.value]
}

async function onTaskCreated() {
  showToast('任务已提交，可在下方查看实时进度')
  await taskListRef.value?.refresh()
}

function showToast(message) {
  toast.value = message
  setTimeout(() => (toast.value = ''), 5000)
}
</script>
