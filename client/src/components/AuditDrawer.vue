<template>
  <div v-if="open" class="drawer-mask" @click.self="$emit('close')">
    <aside class="drawer">
      <header>
        <h2>审计记录</h2>
        <button class="btn ghost" @click="$emit('close')">关闭</button>
      </header>
      <p class="hint">所有状态变化均为追加记录，服务端只增不改；这里不展示任何本机绝对路径。</p>
      <div v-if="loading" class="dim">加载中…</div>
      <ol v-else class="audit-list">
        <li v-for="r in records" :key="r.id">
          <div class="audit-head">
            <span class="badge action">{{ r.action }}</span>
            <time>{{ formatTime(r.at) }}</time>
          </div>
          <p v-if="r.detail">{{ r.detail }}</p>
        </li>
      </ol>
      <p v-if="!loading && !records.length" class="dim">暂无记录</p>
    </aside>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({ taskId: String, open: Boolean });
defineEmits(['close']);

const records = ref([]);
const loading = ref(false);

watch(
  () => props.taskId,
  async (id) => {
    if (!id) return;
    loading.value = true;
    try {
      const data = await api.taskAudit(id);
      records.value = data.records;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

function formatTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
</script>
