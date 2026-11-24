import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 开发时前端跑 5173，把 `/api`、`/v1` 代理到网关 7801。
 *
 * **`base` 现在是 `/`**：SPA 已经占根路径，服务端不再有 SSR 页面（2026-11-13 转正）。
 * 它决定产物里资源引用的绝对路径（`/assets/xxx.js`）和 `createWebHistory()` 的 base，
 * 两边必须一致——只改一边的表现是「HTML 拿到了、JS 全 404、页面一片空白」，
 * 而服务端日志里全是 200。
 */
export default defineConfig({
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7801',
      '/v1': 'http://127.0.0.1:7801',
    },
  },
  build: {
    // 产物给 `app.ts` 的 serveStatic 用：index.html 在 dist 根，JS/CSS 在 dist/assets。
    // 改这个布局要同步改 `src/app.ts` 的 root，否则刷新任意路由拿不到 index.html。
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
