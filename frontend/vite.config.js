import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发环境把 /api 请求代理到 FastAPI（默认 127.0.0.1:8000）。
// 端口被占用时可用环境变量覆盖，例如：
//   VITE_PORT=5180 VITE_API_TARGET=http://127.0.0.1:8011 npm run dev
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8000'
const port = Number(process.env.VITE_PORT) || 5173

export default defineConfig({
  plugins: [vue()],
  server: {
    port,
    strictPort: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
