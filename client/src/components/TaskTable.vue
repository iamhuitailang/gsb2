<template>
  <table class="task-table">
    <thead>
      <tr>
        <th>原始文件名（仅展示）</th>
        <th>客户端声明</th>
        <th>服务端检出</th>
        <th>大小</th>
        <th>状态</th>
        <th>拒收原因 / 提示</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="t in tasks" :key="t.id" :class="`row-${t.status}`">
        <td class="name-cell">
          {{ t.original_name }}
          <small v-if="t.storage_name" class="storage">存储名: {{ t.storage_name }}</small>
          <small v-if="t.zip_meta" class="zip-meta">
            ZIP：{{ t.zip_meta.entries }} 个条目，解压总量 {{ formatBytes(t.zip_meta.totalUncompressedBytes) }}
          </small>
        </td>
        <td>
          <span class="dim">{{ t.client_mime || '—' }}</span>
          <small class="dim">扩展名: {{ t.client_ext || '无' }}</small>
        </td>
        <td>
          <span class="badge type">{{ t.detected_type ? t.detected_type.toUpperCase() : '无法识别' }}</span>
          <small v-if="t.width" class="dim">{{ t.width }}×{{ t.height }}</small>
        </td>
        <td>{{ formatBytes(t.stored_size ?? t.declared_size) }}</td>
        <td><status-badge :status="t.status" /></td>
        <td class="reason-cell">
          <ul v-if="t.reasons?.length">
            <li v-for="(r, i) in t.reasons" :key="i">{{ r }}</li>
          </ul>
          <span v-else class="dim">—</span>
        </td>
        <td class="op-cell">
          <a
            v-if="t.status === 'accepted'"
            class="btn small"
            :href="api.downloadUrl(t.id)"
          >下载</a>
          <button
            v-else
            class="btn small disabled"
            disabled
            title="隔离区文件不能通过下载接口取回"
          >禁止下载</button>
          <button class="btn small ghost" @click="$emit('audit', t.id)">审计记录</button>
          <button
            v-if="t.status === 'quarantined'"
            class="btn small danger"
            @click="onPurge(t)"
          >清理隔离文件</button>
          <span v-if="t.status === 'purged'" class="dim">已清理</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
import { api } from '../api.js';
import StatusBadge from './StatusBadge.vue';

defineProps({ tasks: { type: Array, required: true } });
const emit = defineEmits(['audit', 'purged']);

function formatBytes(n) {
  if (n == null) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function onPurge(task) {
  if (!confirm(`确认清理该隔离文件？\n${task.original_name}\n（任务记录与审计日志会保留）`)) return;
  await api.deleteQuarantine(task.id);
  emit('purged');
}
</script>
