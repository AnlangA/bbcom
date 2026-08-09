import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const { version: appVersion } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Functional frontend tests run in Node by default. Component tests opt in to
 * happy-dom through an explicit `@vitest-environment happy-dom` directive so
 * the serial/data-plane suite never pays for a simulated browser.
 */
export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/frontend/**/*.test.ts'],
    exclude: ['tests/frontend/perf.bench.ts'],
    setupFiles: ['tests/frontend/vitest.setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    dangerouslyIgnoreUnhandledErrors: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json'],
      reportsDirectory: 'coverage/frontend',
      // `include` makes the V8 provider materialize uncovered source files
      // when the full suite runs. Keep every executable TypeScript and Vue
      // module in scope; otherwise a component can silently disappear from
      // the global gate merely because no test imported it.
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.d.ts',
        // These modules contain only TypeScript declarations and therefore
        // have no runtime statements to instrument. `types/constants.ts` and
        // `types/index.ts` remain intentionally covered because they export
        // executable values.
        'src/types/ai.ts',
        'src/types/checksum.ts',
        'src/types/display.ts',
        'src/types/errors.ts',
        'src/types/macros.ts',
        'src/types/modbus.ts',
        'src/types/serial.ts',
        'src/types/session.ts',
        'src/types/waveform.ts',
        'src/lib/session-state-worker-protocol.ts',
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        branches: 80,
        functions: 80,
      },
    },
  },
});
