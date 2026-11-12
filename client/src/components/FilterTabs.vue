<template>
  <div class="filter-tabs">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="tab"
      :class="{ active: value === opt.value }"
      @click="$emit('change', opt.value)"
    >
      {{ opt.label }}
      <span class="tab-count">{{ counts[opt.value] ?? 0 }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  value: String,
  counts: Object,
});
defineEmits(['change']);

const options = [
  { value: 'all', label: '全部' },
  { value: 'accepted', label: '已通过' },
  { value: 'quarantined', label: '隔离中' },
  { value: 'purged', label: '已清理' },
];
</script>
