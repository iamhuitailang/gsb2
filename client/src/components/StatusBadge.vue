<template>
  <span class="badge" :class="`status-${status}`">{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ status: { type: String, required: true } });

const LABELS = {
  inspecting: '检查中',
  accepted: '已通过',
  quarantined: '隔离中',
  purged: '已清理',
};
const label = computed(() => LABELS[props.status] || props.status);
</script>
