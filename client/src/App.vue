<template>
  <header class="topbar">
    <h1>文件接收与隔离工作台</h1>
    <p class="subtitle">
      服务端基于文件实际内容检查 · 随机存储名 · 隔离文件不可通过下载接口取回
    </p>
  </header>

  <section class="panel">
    <div class="panel-head">
      <h2>1. 上传文件</h2>
      <limits-badge :limits="limits" />
    </div>
    <upload-drop @uploaded="onUploaded" />
    <sample-picker @pick="onPickSample" />
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>2. 任务与状态</h2>
      <div class="actions">
        <filter-tabs :value="filter" @change="filter = $event" :counts="counts" />
        <button class="btn danger" :disabled="!counts.quarantined" @click="onPurgeAll">
          清空隔离区（{{ counts.quarantined }}）
        </button>
        <button class="btn ghost" @click="loadTasks">刷新</button>
      </div>
    </div>
    <task-table
      :tasks="filteredTasks"
      @audit="openAudit"
      @purged="loadTasks"
    />
    <p v-if="!filteredTasks.length" class="empty">暂无任务，先上传一个文件试试。</p>
  </section>

  <audit-drawer
    :task-id="auditTaskId"
    :open="!!auditTaskId"
    @close="auditTaskId = null"
  />
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from './api.js';
import LimitsBadge from './components/LimitsBadge.vue';
import UploadDrop from './components/UploadDrop.vue';
import SamplePicker from './components/SamplePicker.vue';
import TaskTable from './components/TaskTable.vue';
import AuditDrawer from './components/AuditDrawer.vue';

const tasks = ref([]);
const limits = ref(null);
const filter = ref('all');
const auditTaskId = ref(null);

const counts = computed(() => {
  const c = { all: tasks.value.length, accepted: 0, quarantined: 0, purged: 0 };
  for (const t of tasks.value) c[t.status] = (c[t.status] || 0) + 1;
  return c;
});

const filteredTasks = computed(() =>
  filter.value === 'all' ? tasks.value : tasks.value.filter((t) => t.status === filter.value),
);

async function loadTasks() {
  const data = await api.listTasks();
  tasks.value = data.tasks;
}

function onUploaded() {
  loadTasks();
}

function onPickSample() {
  loadTasks();
}

function openAudit(id) {
  auditTaskId.value = id;
}

async function onPurgeAll() {
  if (!confirm(`确认清空隔离区全部 ${counts.value.quarantined} 个文件？已通过检查的文件不会受影响。`)) return;
  await api.purgeAll();
  await loadTasks();
}

onMounted(async () => {
  try {
    const health = await api.health();
    limits.value = health.limits;
  } catch {
    limits.value = null;
  }
  await loadTasks();
});
</script>
