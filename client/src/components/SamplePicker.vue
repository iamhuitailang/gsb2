<template>
  <div class="samples">
    <h3>合法样例（项目自生成，可直接上传验证流程）</h3>
    <div class="sample-grid">
      <button
        v-for="s in samples"
        :key="s.name"
        class="sample-card"
        :disabled="busy === s.name"
        @click="uploadSample(s)"
      >
        <img v-if="s.kind === 'image'" :src="s.url" :alt="s.name" />
        <span v-else class="zip-icon">ZIP</span>
        <small>{{ s.label }}</small>
        <em v-if="busy === s.name">上传中…</em>
      </button>
    </div>
    <p class="hint">
      样例均为脚本纯代码编码生成、无第三方版权；可配合“改扩展名/伪造 MIME”等手工操作测试服务端判定。
    </p>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['pick']);
const busy = ref(null);

const samples = [
  { name: 'sample.png', url: '/samples/sample.png', label: 'PNG 图像', kind: 'image' },
  { name: 'sample.jpg', url: '/samples/sample.jpg', label: 'JPEG 图像', kind: 'image' },
  { name: 'sample.gif', url: '/samples/sample.gif', label: 'GIF 图像', kind: 'image' },
  { name: 'sample.bmp', url: '/samples/sample.bmp', label: 'BMP 图像', kind: 'image' },
  { name: 'sample.zip', url: '/samples/sample.zip', label: '含 2 张图的 ZIP', kind: 'zip' },
];

async function uploadSample(s) {
  busy.value = s.name;
  try {
    const res = await fetch(s.url);
    const blob = await res.blob();
    // 显式伪造一个 MIME，演示服务端忽略浏览器声明
    const file = new File([blob], s.name, { type: 'application/x-fake-mime' });
    await api.upload(file);
    emit('pick');
  } finally {
    busy.value = null;
  }
}
</script>
