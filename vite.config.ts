import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 构建产出单个自包含 HTML(dist/index.html), 可直接双击在浏览器打开
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  test: {
    environment: 'node',
  },
});
