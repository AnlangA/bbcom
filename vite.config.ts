import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { readFileSync } from 'node:fs';
import { visualizer } from 'rollup-plugin-visualizer';

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

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
    // serialplugin-api 3.0.0 advertises a `development` conditional export
    // whose target (`guest-js/index.ts`) is not included in its npm package.
    // Resolve the pinned plugin through its published default build in both
    // Vite serve and build modes; this keeps the production serial API intact
    // and makes the WDIO browser-mock renderer executable.
    conditions: ['module', 'browser', 'production'],
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**', '**/coverage/**', '**/dist/**'],
    },
    host: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    // Keep the application bundle from importing the entire package manifest
    // merely to render the About version in Settings.
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    target: 'esnext',
    // The bundle-size gate consumes the Vite manifest to identify every
    // emitted entry rather than guessing from a hashed filename.
    manifest: true,
    // Vite 8 uses its built-in Oxc minifier. A boolean keeps that optimized
    // default and avoids pulling the now-optional esbuild service into builds.
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
