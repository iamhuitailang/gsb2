import { defineConfig } from 'vite';

// base 用相对路径，构建产物可以直接用任意静态服务器 / file 托管子路径打开
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
