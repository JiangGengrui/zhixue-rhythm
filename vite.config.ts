import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 提交版只保留一个应用入口：`/` 直接进今日页，不再有落地页与登录页
  build: {
    rollupOptions: {
      input: {
        app: page('./index.html'),
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
