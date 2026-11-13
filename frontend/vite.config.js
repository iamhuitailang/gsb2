import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The dev server proxies API calls to the local FastAPI process on :8000.
// Everything stays on 127.0.0.1; no external service is contacted.
export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
      "/health": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
