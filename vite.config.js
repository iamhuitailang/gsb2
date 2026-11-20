import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'assets',
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
