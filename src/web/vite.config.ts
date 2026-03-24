import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/ui/',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7700',
      '/health': 'http://localhost:7700',
      '/ws/voice': {
        target: 'ws://localhost:7700',
        ws: true,
      },
      '/ws': {
        target: 'ws://localhost:7700',
        ws: true,
      },
    },
  },
});
