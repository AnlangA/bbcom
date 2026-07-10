import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(async () => ({
  plugins: [
    vue(),
    // Emit a rollup visualization when ANALYZE=1 so bundle composition is
    // auditable without affecting normal builds.
    process.env.ANALYZE
      ? visualizer({
          filename: 'dist/stats.html',
          jsonFilename: 'dist/stats.json',
          template: 'treemap',
          gzipSize: true,
          brotliSize: true,
        })
      : undefined,
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    host: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    // Vite 8 uses its built-in Oxc minifier. A boolean keeps that optimized
    // default and avoids pulling the now-optional esbuild service into builds.
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
