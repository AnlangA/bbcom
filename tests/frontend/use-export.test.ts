import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import {
  createExportBatches,
  EXPORT_BATCH_MAX_BYTES,
  EXPORT_BATCH_MAX_FRAMES,
  EXPORT_FRAME_MAX_BYTES,
  useExport,
  type ExportSessionClient,
} from '../../src/composables/useExport.ts';
import type { ExportFramePayload } from '../../src/lib/ipc.ts';
import type { DataFrame, DisplayMode } from '../../src/types.ts';
import type { ExportChoice, ExportFormat } from '../../src/lib/constants.ts';

function frame(direction: 'RX' | 'TX', data: number[] | Uint8Array, id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  };
}

function legacyDeps(
  overrides: {
    savePath?: string | null;
    exportFrames?: (frames: DataFrame[], format: ExportFormat, path: string) => Promise<void>;
  } = {},
) {
  const calls: Array<{ frames: DataFrame[]; format: ExportFormat; path: string }> = [];
  return {
    calls,
    api: useExport({
      promptSave: async () =>
        overrides.savePath === undefined ? '/tmp/out.txt' : overrides.savePath,
      exportFrames:
        overrides.exportFrames ??
        (async (frames, format, path) => {
          calls.push({ frames, format, path });
        }),
    }),
  };
}

interface SessionCalls {
  begins: Array<{ format: ExportFormat; path: string }>;
  batches: Array<{ exportId: string; frames: ExportFramePayload[] }>;
  finishes: string[];
  aborts: string[];
  order: string[];
}

function sessionDeps(
  overrides: {
    savePath?: string | null;
    begin?: ExportSessionClient['begin'];
    append?: ExportSessionClient['append'];
    finish?: ExportSessionClient['finish'];
    abort?: ExportSessionClient['abort'];
  } = {},
) {
  const calls: SessionCalls = {
    begins: [],
    batches: [],
    finishes: [],
    aborts: [],
    order: [],
  };
  const sessionClient: ExportSessionClient = {
    async begin(format, path) {
      calls.begins.push({ format, path });
      calls.order.push('begin');
      return overrides.begin ? overrides.begin(format, path) : 'export-1';
    },
    async append(exportId, frames) {
      calls.batches.push({ exportId, frames });
      calls.order.push('append');
      await overrides.append?.(exportId, frames);
    },
    async finish(exportId) {
      calls.finishes.push(exportId);
      calls.order.push('finish');
      await overrides.finish?.(exportId);
    },
    async abort(exportId) {
      calls.aborts.push(exportId);
      calls.order.push('abort');
      await overrides.abort?.(exportId);
    },
  };
  return {
    calls,
    api: useExport({
      promptSave: async () =>
        overrides.savePath === undefined ? '/tmp/out.jsonl' : overrides.savePath,
      sessionClient,
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

// ---- Bounded session protocol (production default) ----

test('createExportBatches enforces frame-count and byte limits with plain-array data', () => {
  const countLimited = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('RX', [index & 0xff], index),
  );
  const countBatches = [...createExportBatches(countLimited)];
  assert.deepEqual(
    countBatches.map((batch) => batch.length),
    [EXPORT_BATCH_MAX_FRAMES, 1],
  );
  assert.equal(Array.isArray(countBatches[0][0].data), true, 'wire data is an explicit number[]');

  const byteLimited = [
    frame('RX', new Uint8Array(EXPORT_FRAME_MAX_BYTES), 1),
    frame('TX', new Uint8Array(EXPORT_FRAME_MAX_BYTES), 2),
    frame('RX', [3], 3),
  ];
  const byteBatches = [...createExportBatches(byteLimited)];
  assert.deepEqual(
    byteBatches.map((batch) => batch.length),
    [2, 1],
  );
  assert.equal(
    byteBatches[0].reduce((total, item) => total + item.data.length, 0),
    EXPORT_BATCH_MAX_BYTES,
  );

  assert.throws(
    () => [...createExportBatches([frame('RX', new Uint8Array(EXPORT_FRAME_MAX_BYTES + 1))])],
    /exceeds the .* export limit/,
  );
});

test('useExport: streams bounded batches then finishes exactly once without aborting', async () => {
  const { api, calls } = sessionDeps({ savePath: '/tmp/data.jsonl' });
  const frames = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('RX', [index & 0xff], index),
  );

  const result = await api.exportData(frames, 'jsonl', 'UTF8' as DisplayMode);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.begins, [{ format: 'jsonl', path: '/tmp/data.jsonl' }]);
  assert.deepEqual(
    calls.batches.map((call) => call.frames.length),
    [EXPORT_BATCH_MAX_FRAMES, 1],
  );
  assert.deepEqual(
    calls.batches.map((call) => call.exportId),
    ['export-1', 'export-1'],
  );
  assert.deepEqual(calls.finishes, ['export-1']);
  assert.deepEqual(calls.aborts, []);
  assert.deepEqual(calls.order, ['begin', 'append', 'append', 'finish']);
});

test('useExport: append failure aborts the opened session and skips finish', async () => {
  let appendCalls = 0;
  const { api, calls } = sessionDeps({
    append: async () => {
      appendCalls += 1;
      if (appendCalls === 2) throw new Error('batch write failed');
    },
  });
  const frames = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('TX', [index & 0xff], index),
  );

  const result = await api.exportData(frames, 'csv', 'ASCII' as DisplayMode);

  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('batch write failed'));
  assert.deepEqual(calls.finishes, []);
  assert.deepEqual(calls.aborts, ['export-1']);
  assert.deepEqual(calls.order, ['begin', 'append', 'append', 'abort']);
});

test('useExport: finish failure still aborts and preserves the finish error', async () => {
  const { api, calls } = sessionDeps({
    finish: async () => {
      throw new Error('atomic replace failed');
    },
    abort: async () => {
      throw new Error('cleanup also failed');
    },
  });

  const result = await api.exportData([frame('RX', [1])], 'bin', 'HEX' as DisplayMode);

  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('atomic replace failed'));
  assert.deepEqual(calls.finishes, ['export-1']);
  assert.deepEqual(calls.aborts, ['export-1']);
  assert.deepEqual(calls.order, ['begin', 'append', 'finish', 'abort']);
});

test('useExport: oversized frame aborts after begin without appending', async () => {
  const { api, calls } = sessionDeps();
  const result = await api.exportData(
    [frame('RX', new Uint8Array(EXPORT_FRAME_MAX_BYTES + 1))],
    'bin',
    'HEX' as DisplayMode,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(calls.batches, []);
  assert.deepEqual(calls.finishes, []);
  assert.deepEqual(calls.aborts, ['export-1']);
});

// ---- Shared behavior ----

test('useExport: cancelled dialog (null path) returns ok:false with no export call', async () => {
  const { api, calls } = sessionDeps({ savePath: null });
  const result = await api.exportData([frame('RX', [1])], 'txt', 'HEX' as DisplayMode);

  assert.deepEqual(result, { ok: false }, 'cancel yields ok:false without an error');
  assert.deepEqual(calls.order, [], 'no export session is opened on dialog cancel');
});

test('useExport: choice drives the requested save path filter via promptSave', async () => {
  const prompted: ExportChoice[] = [];
  // Override promptSave to record the choice (the legacy helper already stubs it;
  // re-create with a recording promptSave for this assertion).
  const api2 = useExport({
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
