import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 多页：根入口是产品主页（index.html），学习空间在 app.html
  build: {
    rollupOptions: {
      input: {
        home: page('./index.html'),
        app: page('./app.html'),
        privacy: page('./privacy.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
