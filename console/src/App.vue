<script setup>
import { ref } from 'vue';
import ImportView from './views/ImportView.vue';
import JobListView from './views/JobListView.vue';
import JobDetailView from './views/JobDetailView.vue';

const view = ref({ name: 'import' });

function go(name, id = null) {
  view.value = id === null ? { name } : { name, id };
}
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="logo">
        本地 RPA 执行台
        <small>LOCAL RPA CONSOLE · 离线运行</small>
      </div>
      <button class="nav-item" :class="{ active: view.name === 'import' }" @click="go('import')">
        ① 导入 CSV
      </button>
      <button class="nav-item" :class="{ active: view.name !== 'import' }" @click="go('jobs')">
        ② 任务管理
      </button>
      <div class="env-note">
        本系统仅访问本机模拟业务网站，不连接任何真实网站或第三方服务；数据保存在本地 SQLite。
      </div>
    </aside>
    <main class="main">
      <ImportView v-if="view.name === 'import'" @imported="(id) => go('job', id)" />
      <JobListView v-else-if="view.name === 'jobs'" @open="(id) => go('job', id)" />
      <JobDetailView v-else :job-id="view.id" @back="() => go('jobs')" />
    </main>
  </div>
</template>
