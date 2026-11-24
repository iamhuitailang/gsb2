import { defineConfig } from 'vite';

// 本地试验页：默认 5173 端口，构建产物输出到 dist/
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
