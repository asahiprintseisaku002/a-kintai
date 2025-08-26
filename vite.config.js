// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',          // public/ を使う
  build: {
    outDir: 'dist',
    copyPublicDir: true         // ← public を必ず dist にコピー
  }
});
