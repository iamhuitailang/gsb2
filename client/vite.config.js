import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 开发期把 API 代理到后端 8787，避免跨域与双源问题
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
