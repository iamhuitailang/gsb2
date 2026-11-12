<template>
  <div
    class="dropzone"
    :class="{ dragging, busy }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
    @click="!busy && $refs.input.click()"
  >
    <input
      ref="input"
      type="file"
      class="hidden-input"
      @change="onChange"
    />
    <template v-if="!busy">
      <strong>点击选择或拖拽文件到此处</strong>
      <span class="hint">文件名、扩展名和浏览器 MIME 都不会被当作可信信息</span>
    </template>
    <template v-else>
      <strong>检查中… {{ progress }}%</strong>
      <div class="progress"><div :style="{ width: progress + '%' }" /></div>
    </template>
  </div>

  <div v-if="message" class="upload-msg" :class="message.kind">
    {{ message.text }}
    <ul v-if="message.reasons?.length">
      <li v-for="(r, i) in message.reasons" :key="i">{{ r }}</li>
    </ul>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['uploaded']);
const dragging = ref(false);
const busy = ref(false);
const progress = ref(0);
const message = ref(null);

async function handleFile(file) {
  if (!file) return;
  busy.value = true;
  progress.value = 0;
  message.value = null;
  try {
    const data = await api.upload(file, (p) => { progress.value = p; });
    const task = data.task;
    if (task.status === 'accepted') {
      message.value = {
        kind: 'ok',
        text: `《${task.original_name}》检查通过，已用随机存储名保存。`,
        reasons: task.reasons,
      };
    } else {
      message.value = {
        kind: 'warn',
        text: `《${task.original_name}》未通过检查，已进入隔离区，无法下载。`,
        reasons: task.reasons,
      };
    }
    emit('uploaded', task);
  } catch (err) {
    // 413 时服务端同样已建任务并隔离
    const task = err.body?.task;
    message.value = {
      kind: 'warn',
      text: task
        ? `《${task.original_name}》被拒收并隔离：${err.message}`
        : `上传失败：${err.message}`,
      reasons: task?.reasons,
    };
    emit('uploaded');
  } finally {
    busy.value = false;
  }
}

function onDrop(e) {
  dragging.value = false;
  const file = e.dataTransfer.files?.[0];
  handleFile(file);
}
function onChange(e) {
  handleFile(e.target.files?.[0]);
  e.target.value = '';
}
</script>
