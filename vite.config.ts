import { defineConfig } from 'vite';

// 全部素材本地化：不使用任何外部 CDN，three 从 node_modules 打包
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    // 后台 / 非 TTY 运行时不要因 stdin 关闭而退出
    strictPort: true,
  },
  // 同上：禁用 stdin 监听，避免 CI / 后台进程被回收
  clearScreen: false,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
