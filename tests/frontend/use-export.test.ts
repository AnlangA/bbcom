import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { useExport } from '../../src/composables/useExport.ts';
import type { DataFrame, DisplayMode } from '../../src/types.ts';
import type { ExportChoice, ExportFormat } from '../../src/lib/constants.ts';

function frame(direction: 'RX' | 'TX', data: number[], id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: new Uint8Array(data),
  };
}

function legacyDeps(overrides: {
  savePath?: string | null;
  exportFrames?: (frames: DataFrame[], format: ExportFormat, path: string) => Promise<void>;
} = {}) {
  const calls: Array<{ frames: DataFrame[]; format: ExportFormat; path: string }> = [];
  return {
    calls,
    api: useExport({
      // Legacy path only: explicitly disable the F12 capture-file bypass so
      // exportFrames is the path under test.
      exportViaCaptureFile: undefined,
      promptSave: async () => (overrides.savePath === undefined ? '/tmp/out.txt' : overrides.savePath),
      exportFrames:
        overrides.exportFrames ??
        (async (frames, format, path) => {
          calls.push({ frames, format, path });
        }),
    }),
  };
}

/** Deps that route through the F12 capture-file bypass (the production default). */
function f12Deps(overrides: {
  savePath?: string | null;
  exportViaCaptureFile?: (frames: DataFrame[], format: ExportFormat, path: string) => Promise<void>;
} = {}) {
  const calls: Array<{ frames: DataFrame[]; format: ExportFormat; path: string }> = [];
  return {
    calls,
    api: useExport({
      promptSave: async () => (overrides.savePath === undefined ? '/tmp/out.jsonl' : overrides.savePath),
      exportViaCaptureFile:
        overrides.exportViaCaptureFile ??
        (async (frames, format, path) => {
          calls.push({ frames, format, path });
        }),
    }),
  };
}

// ---- Legacy path (exportFrames) ----

test('useExport (legacy): happy path invokes exportFrames and sets isExporting', async () => {
  const { api, calls } = legacyDeps({ savePath: '/tmp/data.txt' });
  const frames = [frame('RX', [1, 2, 3])];

  assert.equal(api.isExporting.value, false, 'not exporting initially');
  const done = api.exportData(frames, 'txt', 'UTF8' as DisplayMode);
  assert.equal(api.isExporting.value, true, 'isExporting flips on during the call');
  const result = await done;
  assert.equal(api.isExporting.value, false, 'isExporting resets after the call');

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, 'legacy export invoked exactly once');
  assert.equal(calls[0].path, '/tmp/data.txt');
});

test('useExport (legacy): backend error is surfaced as ok:false with a message', async () => {
  const boom = new Error('too many frames');
  const { api } = legacyDeps({
    exportFrames: async () => {
      throw boom;
    },
  });

  const result = await api.exportData([frame('RX', [1])], 'csv', 'ASCII' as DisplayMode);

  assert.equal(result.ok, false);
  assert.ok(result.error, 'error message present');
  assert.equal(result.error!.includes('too many frames'), true, 'error text propagated');
});

// ---- F12 capture-file path (production default) ----

test('useExport (F12): prefers exportViaCaptureFile over exportFrames when provided', async () => {
  const { api, calls } = f12Deps({ savePath: '/tmp/out.jsonl' });
  const frames = [frame('RX', [1, 2, 3])];

  const result = await api.exportData(frames, 'jsonl', 'UTF8' as DisplayMode);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, 'F12 path invoked');
  assert.equal(calls[0].path, '/tmp/out.jsonl');
  assert.deepEqual(
    calls[0].frames.map((f) => f.direction),
    ['RX'],
    'frames forwarded to the capture-file path',
  );
});

test('useExport (F12): a failing capture-file export surfaces as ok:false', async () => {
  const { api } = f12Deps({
    exportViaCaptureFile: async () => {
      throw new Error('capture read failed');
    },
  });
  const result = await api.exportData([frame('RX', [1])], 'jsonl', 'UTF8' as DisplayMode);
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('capture read failed'), 'F12 error propagated');
});

// ---- Shared behavior ----

test('useExport: cancelled dialog (null path) returns ok:false with no export call', async () => {
  const { api, calls } = legacyDeps({ savePath: null });
  const result = await api.exportData([frame('RX', [1])], 'txt', 'HEX' as DisplayMode);

  assert.deepEqual(result, { ok: false }, 'cancel yields ok:false without an error');
  assert.equal(calls.length, 0, 'no export performed on cancel');
});

test('useExport: choice drives the requested save path filter via promptSave', async () => {
  const prompted: ExportChoice[] = [];
  const { api } = legacyDeps({});
  // Override promptSave to record the choice (the legacy helper already stubs it;
  // re-create with a recording promptSave for this assertion).
  const api2 = useExport({
    exportViaCaptureFile: undefined,
    promptSave: async (choice: ExportChoice) => {
      prompted.push(choice);
      return '/x.bin';
    },
    exportFrames: async () => {},
  });
  await api2.exportData([frame('TX', [0xaa])], 'bin', 'HEX' as DisplayMode);

  assert.deepEqual(prompted, ['bin'], 'the chosen ExportChoice is forwarded to promptSave');
});

test('useExport: isExporting resets even when export throws', async () => {
  const { api } = legacyDeps({
    exportFrames: async () => {
      throw new Error('io');
    },
  });

  await api.exportData([frame('RX', [1])], 'jsonl', 'UTF8' as DisplayMode);
  await nextTick();
  assert.equal(api.isExporting.value, false, 'isExporting cleared in the finally block');
});
