import { test } from 'vitest';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import {
  createExportBatches,
  EXPORT_BATCH_MAX_BYTES,
  EXPORT_BATCH_MAX_FRAMES,
  EXPORT_FRAME_MAX_BYTES,
  savePurposeForFormat,
  useExport,
  type ExportSessionClient,
} from '../../src/composables/useExport.ts';
import type { ExportFramePayload } from '../../src/lib/ipc.ts';
import type { DataFrame, DisplayMode } from '../../src/types.ts';
import type { ExportFormat } from '../../src/lib/constants.ts';
import { createExportFrameSnapshot } from '../../src/lib/export-filters.ts';

function frame(direction: 'RX' | 'TX', data: number[] | Uint8Array, id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  };
}

interface SessionCalls {
  begins: Array<{
    format: ExportFormat;
    targetGrant: string;
    expectedFrames: number;
    expectedRawBytes: number;
  }>;
  batches: Array<{ exportId: string; frames: ExportFramePayload[] }>;
  finishes: string[];
  aborts: string[];
  order: string[];
}

function sessionDeps(
  overrides: {
    targetGrant?: string | null;
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
  let totalFrames = 0;
  let totalRawBytes = 0;
  const sessionClient: ExportSessionClient = {
    async begin(format, targetGrant, expectedFrames, expectedRawBytes) {
      calls.begins.push({ format, targetGrant, expectedFrames, expectedRawBytes });
      calls.order.push('begin');
      return overrides.begin
        ? overrides.begin(format, targetGrant, expectedFrames, expectedRawBytes)
        : { exportId: '00000000000000000000000000000001' };
    },
    async append(exportId, frames) {
      calls.batches.push({ exportId, frames });
      calls.order.push('append');
      if (overrides.append) return overrides.append(exportId, frames);
      totalFrames += frames.length;
      totalRawBytes += frames.reduce((total, frame) => total + frame.data.length, 0);
      return { totalFrames, totalRawBytes };
    },
    async finish(exportId) {
      calls.finishes.push(exportId);
      calls.order.push('finish');
      if (overrides.finish) return overrides.finish(exportId);
      return {
        frames: totalFrames,
        rawBytes: totalRawBytes,
        outputBytes: totalRawBytes,
        durationMs: 1,
      };
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
      requestTarget: async () => {
        const token =
          overrides.targetGrant === undefined ? 'grant-out-jsonl' : overrides.targetGrant;
        return token ? { token, displayName: 'out.jsonl' } : null;
      },
      sessionClient,
    }),
  };
}

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
    frame('RX', new Uint8Array(EXPORT_BATCH_MAX_BYTES), 1),
    frame('TX', new Uint8Array(1), 2),
    frame('RX', new Uint8Array(EXPORT_FRAME_MAX_BYTES), 3),
    frame('RX', [3], 3),
  ];
  const byteBatches = [...createExportBatches(byteLimited)];
  assert.deepEqual(
    byteBatches.map((batch) => batch.length),
    [1, 1, 1, 1],
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
  const { api, calls } = sessionDeps({ targetGrant: 'grant-data-jsonl' });
  const frames = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('RX', [index & 0xff], index),
  );

  const result = await api.exportData(frames, 'jsonl', 'UTF8' as DisplayMode);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.begins, [
    {
      format: 'jsonl',
      targetGrant: 'grant-data-jsonl',
      expectedFrames: EXPORT_BATCH_MAX_FRAMES + 1,
      expectedRawBytes: EXPORT_BATCH_MAX_FRAMES + 1,
    },
  ]);
  assert.deepEqual(
    calls.batches.map((call) => call.frames.length),
    [EXPORT_BATCH_MAX_FRAMES, 1],
  );
  assert.deepEqual(
    calls.batches.map((call) => call.exportId),
    ['00000000000000000000000000000001', '00000000000000000000000000000001'],
  );
  assert.deepEqual(calls.finishes, ['00000000000000000000000000000001']);
  assert.deepEqual(calls.aborts, []);
  assert.deepEqual(calls.order, ['begin', 'append', 'append', 'finish']);
});

test('useExport: append failure aborts the opened session and skips finish', async () => {
  let appendCalls = 0;
  const { api, calls } = sessionDeps({
    append: async () => {
      appendCalls += 1;
      if (appendCalls === 2) throw new Error('batch write failed');
      return { totalFrames: EXPORT_BATCH_MAX_FRAMES, totalRawBytes: EXPORT_BATCH_MAX_FRAMES };
    },
  });
  const frames = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('TX', [index & 0xff], index),
  );

  const result = await api.exportData(frames, 'csv', 'ASCII' as DisplayMode);

  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('batch write failed'));
  assert.deepEqual(calls.finishes, []);
  assert.deepEqual(calls.aborts, ['00000000000000000000000000000001']);
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
  assert.deepEqual(calls.finishes, ['00000000000000000000000000000001']);
  assert.deepEqual(calls.aborts, ['00000000000000000000000000000001']);
  assert.deepEqual(calls.order, ['begin', 'append', 'finish', 'abort']);
});

test('useExport: oversized frame is rejected before requesting a target', async () => {
  const { api, calls } = sessionDeps();
  const result = await api.exportData(
    [frame('RX', new Uint8Array(EXPORT_FRAME_MAX_BYTES + 1))],
    'bin',
    'HEX' as DisplayMode,
  );

  assert.equal(result.ok, false);
  assert.deepEqual(calls.batches, []);
  assert.deepEqual(calls.finishes, []);
  assert.deepEqual(calls.aborts, []);
  assert.deepEqual(calls.begins, []);
});

test('useExport: backend stats drive progress and cancellation aborts before finish', async () => {
  const setup = sessionDeps({
    append: async (_exportId, frames) => {
      api.cancelExport();
      return {
        totalFrames: frames.length,
        totalRawBytes: frames.reduce((total, item) => total + item.data.length, 0),
      };
    },
  });
  const api = setup.api;
  const result = await api.exportData(
    Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
      frame('RX', [index & 0xff], index),
    ),
    'jsonl',
    'HEX',
  );

  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(api.progress.value.completedFrames, EXPORT_BATCH_MAX_FRAMES);
  assert.equal(api.progress.value.phase, 'cancelled');
  assert.deepEqual(setup.calls.finishes, []);
  assert.deepEqual(setup.calls.aborts, ['00000000000000000000000000000001']);
});

test('useExport: only the dialog-filtered frame ids cross the append boundary', async () => {
  const { api, calls } = sessionDeps();
  const frames = [frame('RX', [1], 1), frame('TX', [2, 3], 2), frame('RX', [4], 3)];
  const snapshot = createExportFrameSnapshot(frames, {
    direction: 'TX',
    timePreset: 'all',
    customStartMs: null,
    customEndMs: null,
  });
  const result = await api.exportData(snapshot, 'csv', 'HEX');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.batches.flatMap((batch) => batch.frames.map((item) => item.id)),
    ['f2'],
  );
  assert.equal(calls.begins[0].expectedFrames, 1);
  assert.equal(calls.begins[0].expectedRawBytes, 2);
});

// ---- Shared behavior ----

test('useExport: cancelled dialog returns ok:false with no export call', async () => {
  const { api, calls } = sessionDeps({ targetGrant: null });
  const result = await api.exportData([frame('RX', [1])], 'txt', 'HEX' as DisplayMode);

  assert.deepEqual(
    result,
    { ok: false, cancelled: true },
    'cancel yields an explicit non-error cancellation',
  );
  assert.deepEqual(calls.order, [], 'no export session is opened on dialog cancel');
});

test('useExport: choice drives the backend save-target purpose', async () => {
  const purposes: string[] = [];
  const api2 = useExport({
    requestTarget: async (purpose) => {
      purposes.push(purpose);
      return { token: 'grant-bin', displayName: 'x.bin' };
    },
    sessionClient: {
      begin: async () => ({ exportId: '00000000000000000000000000000001' }),
      append: async () => ({ totalFrames: 1, totalRawBytes: 1 }),
      finish: async () => ({ frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 1 }),
      abort: async () => {},
    },
  });
  await api2.exportData([frame('TX', [0xaa])], 'bin', 'HEX' as DisplayMode);

  assert.deepEqual(purposes, ['export-bin']);
});

test('useExport: production save flow passes only the opaque grant to begin', async () => {
  const begins: Array<{
    format: ExportFormat;
    targetGrant: string;
    expectedFrames: number;
    expectedRawBytes: number;
  }> = [];
  const requested: Array<{ purpose: string; suggestedName: string }> = [];
  const api = useExport({
    requestTarget: async (purpose, suggestedName) => {
      requested.push({ purpose, suggestedName });
      return { token: 'opaque-export-grant', displayName: 'capture.csv' };
    },
    sessionClient: {
      begin: async (format, targetGrant, expectedFrames, expectedRawBytes) => {
        begins.push({ format, targetGrant, expectedFrames, expectedRawBytes });
        return { exportId: '00000000000000000000000000000001' };
      },
      append: async () => ({ totalFrames: 1, totalRawBytes: 1 }),
      finish: async () => ({ frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 1 }),
      abort: async () => {},
    },
  });

  const result = await api.exportData([frame('RX', [1])], 'csv', 'HEX' as DisplayMode);
  assert.deepEqual(result, { ok: true });
  assert.equal(requested[0].purpose, 'export-csv');
  assert.match(requested[0].suggestedName, /^bbcom-export-\d+\.csv$/);
  assert.deepEqual(begins, [
    {
      format: 'csv',
      targetGrant: 'opaque-export-grant',
      expectedFrames: 1,
      expectedRawBytes: 1,
    },
  ]);
  assert.notEqual(begins[0].targetGrant, 'C:\\Users\\me\\capture.csv');
});

test('savePurposeForFormat covers every export wire format', () => {
  assert.deepEqual(
    ['txt-hex', 'txt-ascii', 'csv', 'jsonl', 'bin'].map((format) =>
      savePurposeForFormat(format as ExportFormat),
    ),
    ['export-txt-hex', 'export-txt-ascii', 'export-csv', 'export-jsonl', 'export-bin'],
  );
});

test('useExport: isExporting resets even when export throws', async () => {
  const { api } = sessionDeps({
    begin: async () => {
      throw new Error('io');
    },
  });

  const result = await api.exportData([frame('RX', [1])], 'jsonl', 'UTF8' as DisplayMode);
  await nextTick();
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /io/);
  assert.equal(api.isExporting.value, false, 'isExporting cleared in the finally block');
});
