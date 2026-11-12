<template>
  <div class="limits">
    <span class="chip">单文件 ≤ {{ formatBytes(limits.maxUploadBytes) }}</span>
    <span class="chip">ZIP 条目 ≤ {{ limits.zip.maxEntries }}</span>
    <span class="chip">ZIP 解压总量 ≤ {{ formatBytes(limits.zip.maxTotalUncompressedBytes) }}</span>
    <span class="chip">允许格式：{{ Object.keys(limits.allowed).join(' / ') }}</span>
  </div>
</template>

<script setup>
defineProps({ limits: { type: Object, default: null } });

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
</script>
