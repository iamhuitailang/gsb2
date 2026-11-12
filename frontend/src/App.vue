<template>
  <div class="layout">
    <header class="topbar">
      <h1><router-link to="/" style="color: inherit">游戏事件回放分析平台</router-link></h1>
      <span class="meta">
        <template v-if="health">
          规则版本 <b>{{ health.rules_version }}</b> ·
          支持事件格式 {{ health.supported_schema_versions.join(', ') }}
        </template>
        <template v-else>后端连接中…</template>
      </span>
    </header>
    <router-view />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { api } from './api.js'

const health = ref(null)

onMounted(async () => {
  try {
    health.value = await api.health()
  } catch {
    health.value = null
  }
})
</script>
