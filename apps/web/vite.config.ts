import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      // Match /api and /api/... but NOT /api-docs, which is an app route.
      '^/api(/|$)': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // The OpenAPI document is served at the API root, not under /api.
      '^/openapi\\.json$': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Health and public config live at the API root too.
      '^/health(/|$)': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@pe/shared/tokens.css',
        replacement: resolve(__dirname, '../../packages/shared/src/tokens.css'),
      },
      {
        find: '@pe/shared',
        replacement: resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    ],
  },
});
