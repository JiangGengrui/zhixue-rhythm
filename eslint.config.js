import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // 产物、生成物、数据与临时目录都不该被 lint：engine.generated.mjs 是 build:engine 的输出
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      'backups/**',
      'artifacts/**',
      'mockups/**',
      'public/**',
      '.archify/**',
      '.archify-*/**',
      'server/engine.generated.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx,js}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node, sourceType: 'module' },
  },
);
