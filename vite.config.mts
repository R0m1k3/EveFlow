/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: false
  },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    globals: false
  }
});
