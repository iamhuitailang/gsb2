<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { jobStatus } from '../status.js';

const emit = defineEmits(['open']);
const jobs = ref([]);
const loading = ref(true);
const error = ref('');
let timer = null;

async function load() {
  try {
    jobs.value = await api.listJobs();
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  // 执行中的任务每 2 秒兜底刷新（实时更新主要由详情页 SSE 负责）
  timer = setInterval(load, 2000);
  window.addEventListener('focus', load);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener('focus', load);
});
</script>

<template>
  <h1 class="page-title">任务管理</h1>
  <p class="page-sub">
    服务重启后，未完成的任务会被显式标记为「已中断」，可打开后继续恢复；已完成记录不会重复提交。
  </p>

  <div v-if="error" class="error-box">{{ error }}（请确认后端服务已启动：npm run dev:server）</div>

  <div class="card">
    <div class="toolbar" style="justify-content: space-between; margin-bottom: 12px">
      <h3 style="margin: 0">全部任务</h3>
      <button class="ghost sm" @click="load">刷新</button>
    </div>
    <div v-if="loading" class="muted">加载中…</div>
    <div v-else-if="!jobs.length" class="muted">暂无任务，请先到「导入 CSV」上传文件。</div>
    <table v-else>
      <thead>
        <tr>
          <th>#</th><th>来源文件</th><th>状态</th><th>总数</th>
          <th>成功</th><th>失败</th><th>跳过</th><th>中断/待处理</th><th>创建时间</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="j in jobs"
          :key="j.id"
          class="job-row"
          @click="emit('open', j.id)"
        >
          <td>{{ j.id }}</td>
          <td>{{ j.name }}</td>
          <td>
            <span class="st" :class="jobStatus(j.status).cls">
              {{ j.running ? '执行中' : jobStatus(j.status).label }}
            </span>
          </td>
          <td>{{ j.total }}</td>
          <td>{{ j.counts.success }}</td>
          <td>{{ j.counts.failed }}</td>
          <td>{{ j.counts.skipped }}</td>
          <td>{{ j.counts.interrupted + j.counts.pending + j.counts.running }}</td>
          <td class="mono">{{ new Date(j.created_at).toLocaleString() }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
