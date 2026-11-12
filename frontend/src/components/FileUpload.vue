<template>
  <div class="panel">
    <h2>1. 选择视频文件</h2>
    <div
      class="dropzone"
      :class="{ dragover: dragging }"
      @click="pick"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <div v-if="uploading">
        正在上传 {{ uploadProgress }}%
        <div class="progress-track" style="margin-top: 10px">
          <div class="progress-fill" :style="{ width: uploadProgress + '%' }" />
        </div>
      </div>
      <div v-else>
        点击选择，或把视频拖拽到此处<br />
        <span class="muted" style="font-size: 12px">
          允许类型：{{ allowedExt }} · 大小上限：{{ maxMb }}MB
        </span>
      </div>
      <input
        ref="inputRef"
        type="file"
        accept=".mp4,.mov,.m4v,.mkv,.avi,.webm,.flv,.wmv,.ts,.mpg,.mpeg,.3gp,.ogv,video/*"
        style="display: none"
        @change="onChange"
      />
    </div>

    <div v-if="error" class="error-text" style="margin-top: 10px">{{ error }}</div>

    <div v-if="files.length" style="margin-top: 14px">
      <div class="muted" style="margin-bottom: 8px; font-size: 12px">已上传的文件：</div>
      <div class="row">
        <div
          v-for="f in files"
          :key="f.id"
          class="file-chip"
          :style="f.id === modelValue?.id ? { borderColor: 'var(--primary)' } : {}"
        >
          <a href="#" @click.prevent="$emit('update:modelValue', f)">{{ f.original_name }}</a>
          <span class="muted mono">{{ msToText(f.duration_ms) }}</span>
          <button class="ghost" @click="$emit('update:modelValue', f)">使用</button>
          <button class="danger" @click="remove(f)">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api'
import { msToText } from '../utils/time'

const props = defineProps({
  modelValue: { type: Object, default: null },
  maxMb: { type: Number, default: 2048 },
})
const emit = defineEmits(['update:modelValue', 'uploaded'])

const files = ref([])
const inputRef = ref(null)
const dragging = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const error = ref('')
const allowedExt = '.mp4 .mov .mkv .avi .webm 等常见视频格式'

onMounted(loadFiles)

async function loadFiles() {
  try {
    files.value = await api.listFiles()
  } catch (err) {
    error.value = err.message
  }
}

function pick() {
  if (!uploading.value) inputRef.value?.click()
}

function onChange(e) {
  const file = e.target.files?.[0]
  if (file) upload(file)
  e.target.value = ''
}

function onDrop(e) {
  dragging.value = false
  const file = e.dataTransfer.files?.[0]
  if (file) upload(file)
}

async function upload(file) {
  error.value = ''
  try {
    uploading.value = true
    uploadProgress.value = 0
    const saved = await api.uploadFile(file, (p) => (uploadProgress.value = p))
    await loadFiles()
    emit('update:modelValue', saved)
    emit('uploaded', saved)
  } catch (err) {
    error.value = err.message
  } finally {
    uploading.value = false
  }
}

async function remove(file) {
  if (!window.confirm(`删除文件「${file.original_name}」？该文件的源视频将从服务器移除。`)) return
  try {
    await api.deleteFile(file.id)
    if (props.modelValue?.id === file.id) emit('update:modelValue', null)
    await loadFiles()
  } catch (err) {
    error.value = err.message
  }
}
</script>
