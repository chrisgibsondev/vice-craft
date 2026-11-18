import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.BLOCKSHORE_SERVER ?? 'http://127.0.0.1:5421';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5420,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
