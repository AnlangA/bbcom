import { test } from 'vitest';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import {
  createExportBatches,
  EXPORT_BATCH_MAX_BYTES,
  EXPORT_BATCH_MAX_FRAMES,
  EXPORT_FRAME_MAX_BYTES,
  EXPORT_MAX_BYTES,
  EXPORT_MAX_FRAMES,
  savePurposeForFormat,
  summarizeExportFrames,
  useExport,
  type ExportSessionClient,
  type WorkspaceDbExportSource,
} from '@/features/workspace/application/use-export.ts';
import type { ExportFramePayload, ExportSource } from '@/features/platform/native/index.ts';
import type { DataFrame, DisplayMode } from '@/types.ts';
import type { ExportFormat } from '@/lib/constants.ts';
import { createExportFrameSnapshot } from '@/lib/export-filters.ts';
import { OperationRegistry } from '@/features/platform/application/operation-registry.ts';

function frame(direction: 'RX' | 'TX', data: number[] | Uint8Array, id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  };
}

function deferredTarget(): {
  promise: Promise<{ token: string; displayName: string }>;
  resolve(value: { token: string; displayName: string }): void;
} {
  let resolve!: (value: { token: string; displayName: string }) => void;
  const promise = new Promise<{ token: string; displayName: string }>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

interface SessionCalls {
  begins: Array<{
    format: ExportFormat;
    targetGrant: string;
    expectedFrames: number;
    expectedRawBytes: number;
    source?: ExportSource;
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
    async begin(format, targetGrant, expectedFrames, expectedRawBytes, source) {
      calls.begins.push({
        format,
        targetGrant,
        expectedFrames,
        expectedRawBytes,
        ...(source ? { source } : {}),
      });
      calls.order.push('begin');
      return overrides.begin
        ? overrides.begin(format, targetGrant, expectedFrames, expectedRawBytes, source)
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

test('createExportBatches enforces frame-count and byte limits with byte-backed data', () => {
  const countLimited = Array.from({ length: EXPORT_BATCH_MAX_FRAMES + 1 }, (_, index) =>
    frame('RX', [index & 0xff], index),
  );
  const countBatches = [...createExportBatches(countLimited)];
  assert.deepEqual(
    countBatches.map((batch) => batch.length),
    [EXPORT_BATCH_MAX_FRAMES, 1],
  );
  assert.equal(
    countBatches[0][0].data instanceof Uint8Array,
    true,
    'batch data stays a zero-copy Uint8Array; the IPC wrapper widens it to base64',
  );

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

test('useExport: registers an application-owned cancellable session export before target selection', async () => {
  const target = deferredTarget();
  const operations = new OperationRegistry();
  let aborts = 0;
  const api = useExport({
    operations,
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    operationIdFactory: () => 'operation-main',
    requestTarget: () => target.promise,
    sessionClient: {
      begin: async () => ({ exportId: 'native-export' }),
      append: async () => ({ totalFrames: 1, totalRawBytes: 1 }),
      finish: async () => ({ frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 1 }),
      abort: async () => {
        aborts += 1;
      },
    },
  });

  const exporting = api.exportData([frame('RX', [1])], 'bin', 'HEX');
  await nextTick();
  const operationId = 'session-export:operation-main';
  assert.equal(operations.get(operationId)?.status, 'running');
  assert.equal(operations.get(operationId)?.kind, 'session-export');
  assert.equal(operations.get(operationId)?.workspaceId, 'workspace-main');
  assert.equal(operations.get(operationId)?.sessionId, 'session-main');

  await operations.cancel(operationId);
  target.resolve({ token: 'late-grant', displayName: 'late.bin' });
  assert.deepEqual(await exporting, { ok: false, cancelled: true });
  assert.equal(operations.get(operationId)?.status, 'cancelled');
  assert.equal(aborts, 0, 'no native export exists while the save dialog is pending');
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

test('useExport: a raw source is frozen before awaiting the save target', async () => {
  let resolveTarget!: (target: { token: string; displayName: string }) => void;
  const target = new Promise<{ token: string; displayName: string }>((resolve) => {
    resolveTarget = resolve;
  });
  const frames = [frame('RX', [1], 1), frame('TX', [2, 3], 2)];
  const calls: string[][] = [];
  const api = useExport({
    requestTarget: async () => target,
    sessionClient: {
      begin: async (_format, _grant, expectedFrames, expectedRawBytes) => {
        assert.equal(expectedFrames, 2);
        assert.equal(expectedRawBytes, 3);
        return { exportId: '00000000000000000000000000000001' };
      },
      append: async (_exportId, payloads) => {
        calls.push(payloads.map((payload) => payload.id));
        return { totalFrames: 2, totalRawBytes: 3 };
      },
      finish: async () => ({ frames: 2, rawBytes: 3, outputBytes: 3, durationMs: 1 }),
      abort: async () => {},
    },
  });

  const exporting = api.exportData(frames, 'bin', 'HEX');
  frames.shift();
  frames.splice(0, 1);
  frames.push(frame('RX', [9], 9));
  resolveTarget({ token: 'grant', displayName: 'capture.bin' });

  assert.deepEqual(await exporting, { ok: true });
  assert.deepEqual(calls, [['f1', 'f2']]);
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

test('useExport: limits are enforced before a target dialog, including empty selections', () => {
  assert.throws(() => summarizeExportFrames([]), /No frames match/);

  function* tooManyFrames(): Generator<DataFrame> {
    const empty = frame('RX', [], 1);
    for (let index = 0; index <= EXPORT_MAX_FRAMES; index += 1) yield empty;
  }
  assert.throws(() => summarizeExportFrames(tooManyFrames()), /more than/);

  function* oversizedTotal(): Generator<DataFrame> {
    const maximalFrame = {
      id: 'maximal-frame',
      direction: 'RX',
      timestamp: 1,
      data: { length: EXPORT_FRAME_MAX_BYTES },
    } as unknown as DataFrame;
    for (
      let index = 0;
      index <= Math.floor(EXPORT_MAX_BYTES / EXPORT_FRAME_MAX_BYTES);
      index += 1
    ) {
      yield maximalFrame;
    }
  }
  assert.throws(() => summarizeExportFrames(oversizedTotal()), /data exceeds/);
});

test('useExport: cancellation while the dialog is open keeps progress stable and revokes the grant', async () => {
  let resolveTarget!: (target: { token: string; displayName: string }) => void;
  const target = new Promise<{ token: string; displayName: string }>((resolve) => {
    resolveTarget = resolve;
  });
  const revoked: string[] = [];
  const api = useExport({
    requestTarget: async () => target,
    revokeTarget: async (token) => {
      revoked.push(token);
    },
    sessionClient: {
      begin: async () => {
        throw new Error('must not start after dialog cancellation');
      },
      append: async () => ({ totalFrames: 0, totalRawBytes: 0 }),
      finish: async () => ({ frames: 0, rawBytes: 0, outputBytes: 0, durationMs: 0 }),
      abort: async () => {},
    },
  });

  api.cancelExport();
  const exporting = api.exportData([frame('RX', [1])], 'bin', 'HEX');
  assert.equal(api.progress.value.phase, 'selecting-target');
  api.resetExportProgress();
  assert.equal(
    api.progress.value.phase,
    'selecting-target',
    'reset is ignored while work is active',
  );
  api.cancelExport();
  resolveTarget({ token: 'grant-to-revoke', displayName: 'capture.bin' });

  assert.deepEqual(await exporting, { ok: false, cancelled: true });
  assert.deepEqual(revoked, ['grant-to-revoke']);
  assert.equal(api.progress.value.phase, 'cancelled');
  api.resetExportProgress();
  assert.equal(api.progress.value.phase, 'idle');
});

test('createExportBatches emits an oversized single frame with and without a preceding batch', () => {
  const oversizedForBatch = new Uint8Array(EXPORT_BATCH_MAX_BYTES + 1);
  assert.deepEqual(
    [...createExportBatches([frame('RX', oversizedForBatch, 1)])].map((batch) => batch.length),
    [1],
  );
  assert.deepEqual(
    [
      ...createExportBatches([
        frame('RX', [1], 1),
        frame('TX', oversizedForBatch, 2),
        frame('RX', [3], 3),
      ]),
    ].map((batch) => batch.map((entry) => entry.id)),
    [['f1'], ['f2'], ['f3']],
  );
});

test('useExport: application-owned success publishes progress and completes the operation', async () => {
  const operations = new OperationRegistry();
  const api = useExport({
    operations,
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    requestTarget: async () => ({ token: 'grant-success', displayName: 'capture.bin' }),
    sessionClient: {
      begin: async () => ({ exportId: 'native-success' }),
      append: async (_exportId, frames) => ({
        totalFrames: frames.length,
        totalRawBytes: frames.reduce((total, item) => total + item.data.length, 0),
      }),
      finish: async () => ({ frames: 2, rawBytes: 3, outputBytes: 3, durationMs: 7 }),
      abort: async () => {},
    },
  });

  assert.deepEqual(
    await api.exportData([frame('RX', [1], 1), frame('TX', [2, 3], 2)], 'bin', 'HEX'),
    { ok: true },
  );
  const [operation] = operations.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.completedUnits, 2);
  assert.equal(operation.totalUnits, 2);
  assert.equal(api.progress.value.phase, 'completed');
});

test('useExport: cancelExport delegates to the registered operation while selecting a target', async () => {
  const target = deferredTarget();
  const operations = new OperationRegistry();
  const api = useExport({
    operations,
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    operationIdFactory: () => 'cancel-via-api',
    requestTarget: () => target.promise,
    sessionClient: {
      begin: async () => ({ exportId: 'must-not-start' }),
      append: async () => ({ totalFrames: 0, totalRawBytes: 0 }),
      finish: async () => ({ frames: 0, rawBytes: 0, outputBytes: 0, durationMs: 0 }),
      abort: async () => {},
    },
  });

  const exporting = api.exportData([frame('RX', [1])], 'bin', 'HEX');
  await nextTick();
  api.cancelExport();
  target.resolve({ token: 'late-grant', displayName: 'late.bin' });

  assert.deepEqual(await exporting, { ok: false, cancelled: true });
  assert.equal(operations.get('session-export:cancel-via-api')?.status, 'cancelled');
});

test('useExport: dialog cancellation cancels a still-running registered operation', async () => {
  const operations = new OperationRegistry();
  const api = useExport({
    operations,
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    operationIdFactory: () => 'dialog-cancel',
    requestTarget: async () => null,
    sessionClient: {
      begin: async () => ({ exportId: 'must-not-start' }),
      append: async () => ({ totalFrames: 0, totalRawBytes: 0 }),
      finish: async () => ({ frames: 0, rawBytes: 0, outputBytes: 0, durationMs: 0 }),
      abort: async () => {},
    },
  });

  assert.deepEqual(await api.exportData([frame('RX', [1])], 'bin', 'HEX'), {
    ok: false,
    cancelled: true,
  });
  assert.equal(operations.get('session-export:dialog-cancel')?.status, 'cancelled');
});

test('useExport: cancellation after the only append aborts before finish', async () => {
  const calls: string[] = [];
  const api = useExport({
    requestTarget: async () => ({ token: 'grant-cancel-after-append', displayName: 'x.bin' }),
    sessionClient: {
      begin: async () => ({ exportId: 'cancel-after-append' }),
      append: async (_exportId, frames) => {
        calls.push('append');
        api.cancelExport();
        return {
          totalFrames: frames.length,
          totalRawBytes: frames.reduce((total, item) => total + item.data.length, 0),
        };
      },
      finish: async () => {
        calls.push('finish');
        return { frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 1 };
      },
      abort: async () => {
        calls.push('abort');
      },
    },
  });

  assert.deepEqual(await api.exportData([frame('RX', [1])], 'bin', 'HEX'), {
    ok: false,
    cancelled: true,
  });
  assert.deepEqual(calls, ['append', 'abort']);
});

test('useExport: registered failures preserve typed IPC errors and normalize primitive failures', async () => {
  const typedFailure = {
    code: 'IO_DISK_FULL',
    messageKey: 'error.io_disk_full',
    retryable: true,
    operation: 'session-export',
  } as const;

  for (const [suffix, failure, expectedCode] of [
    ['typed', typedFailure, 'IO_DISK_FULL'],
    ['primitive', 'plain failure', 'EXPORT_REPLACE_FAILED'],
  ] as const) {
    const operations = new OperationRegistry();
    const operationId = `failure-${suffix}`;
    const api = useExport({
      operations,
      workspaceId: 'workspace-main',
      sessionId: 'session-main',
      operationIdFactory: () => operationId,
      requestTarget: async () => ({ token: `grant-${suffix}`, displayName: 'x.bin' }),
      sessionClient: {
        begin: async () => Promise.reject(failure),
        append: async () => ({ totalFrames: 0, totalRawBytes: 0 }),
        finish: async () => ({ frames: 0, rawBytes: 0, outputBytes: 0, durationMs: 0 }),
        abort: async () => {},
      },
    });

    assert.equal((await api.exportData([frame('RX', [1])], 'bin', 'HEX')).ok, false);
    const operation = operations.get(`session-export:${operationId}`);
    assert.equal(operation?.status, 'failed');
    assert.equal(operation?.error?.code, expectedCode);
  }
});

test('useExport: a terminal operation is not downgraded by a late export error', async () => {
  const operations = new OperationRegistry();
  const operationId = 'already-completed';
  const api = useExport({
    operations,
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    operationIdFactory: () => operationId,
    requestTarget: async () => ({ token: 'grant-terminal', displayName: 'x.bin' }),
    sessionClient: {
      begin: async () => {
        operations.complete(`session-export:${operationId}`);
        throw new Error('late renderer error');
      },
      append: async () => ({ totalFrames: 0, totalRawBytes: 0 }),
      finish: async () => ({ frames: 0, rawBytes: 0, outputBytes: 0, durationMs: 0 }),
      abort: async () => {},
    },
  });

  assert.equal((await api.exportData([frame('RX', [1])], 'bin', 'HEX')).ok, false);
  assert.equal(operations.get(`session-export:${operationId}`)?.status, 'completed');
});

test('useExport: operation identity validation fails before target selection', async () => {
  let targetRequests = 0;
  const missingWorkspace = useExport({
    operations: new OperationRegistry(),
    sessionId: 'session-main',
    requestTarget: async () => {
      targetRequests += 1;
      return { token: 'unused', displayName: 'unused.bin' };
    },
  });
  assert.equal((await missingWorkspace.exportData([frame('RX', [1])], 'bin', 'HEX')).ok, false);

  const invalidOperationId = useExport({
    operations: new OperationRegistry(),
    workspaceId: 'workspace-main',
    sessionId: 'session-main',
    operationIdFactory: () => '../not-opaque',
    requestTarget: async () => {
      targetRequests += 1;
      return { token: 'unused', displayName: 'unused.bin' };
    },
  });
  assert.equal((await invalidOperationId.exportData([frame('RX', [1])], 'bin', 'HEX')).ok, false);
  assert.equal(targetRequests, 0);
});

test('useExport: raw arrays stop before retaining a frame beyond the reference ceiling', async () => {
  let targetRequests = 0;
  const api = useExport({
    requestTarget: async () => {
      targetRequests += 1;
      return { token: 'unused', displayName: 'unused.bin' };
    },
  });
  const repeated = frame('RX', []);
  const overLimit = Array.from({ length: EXPORT_MAX_FRAMES + 1 }, () => repeated);

  const result = await api.exportData(overLimit, 'bin', 'HEX');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : (result.error ?? ''), /more than/);
  assert.equal(targetRequests, 0);
});

// ---- DB-sourced (workspace-frames) mode ----

function recordingDbSource(
  selection: { workspaceId: string; toSeqExclusive: number } | null,
): WorkspaceDbExportSource & { prepared: string[] } {
  const prepared: string[] = [];
  return {
    prepared,
    async prepare(sessionId) {
      prepared.push(sessionId);
      return selection;
    },
  };
}

function unfilteredSnapshot(frames: DataFrame[]) {
  return createExportFrameSnapshot(frames, {
    direction: 'all',
    timePreset: 'all',
    customStartMs: null,
    customEndMs: null,
  });
}

test('useExport: unfiltered exports flush first, begin with the DB source, and stream nothing', async () => {
  const dbSource = recordingDbSource({ workspaceId: 'workspace-main', toSeqExclusive: 7 });
  const order: string[] = [];
  const appends: number[] = [];
  const api = useExport({
    sessionId: 'session-main',
    dbSource,
    requestTarget: async () => ({ token: 'grant-db', displayName: 'out.jsonl' }),
    sessionClient: {
      begin: async (_format, _grant, expectedFrames, _expectedRawBytes, source) => {
        order.push('begin');
        assert.deepEqual(source, {
          kind: 'workspace-frames',
          workspaceId: 'workspace-main',
          sessionId: 'session-main',
          toSeqExclusive: 7,
        } satisfies ExportSource);
        return { exportId: 'db-export', expectedFrames };
      },
      append: async (_exportId, frames) => {
        order.push('append');
        appends.push(frames.length);
        return { totalFrames: frames.length, totalRawBytes: 0 };
      },
      finish: async () => {
        order.push('finish');
        return { frames: 3, rawBytes: 6, outputBytes: 9, durationMs: 1 };
      },
      abort: async () => {
        order.push('abort');
      },
    },
  });
  const frames = [frame('RX', [1], 1), frame('TX', [2, 3], 2), frame('RX', [4], 3)];

  const result = await api.exportData(unfilteredSnapshot(frames), 'jsonl', 'HEX', {
    unfiltered: true,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(dbSource.prepared, ['session-main']);
  assert.deepEqual(
    order,
    ['begin', 'finish'],
    'prepare must run before begin; no appends in DB mode',
  );
  assert.deepEqual(appends, []);
  assert.equal(api.progress.value.completedFrames, 3);
});

test('useExport: filtered exports and unavailable DB sources stay in renderer mode', async () => {
  const dbSource = recordingDbSource({ workspaceId: 'workspace-main', toSeqExclusive: 7 });
  const sources: Array<ExportSource | undefined> = [];
  const client = {
    begin: async (
      _format: ExportFormat,
      _grant: string,
      expectedFrames: number,
      expectedRawBytes: number,
      source?: ExportSource,
    ) => {
      sources.push(source);
      return { exportId: 'renderer-export' };
    },
    append: async (_exportId: string, frames: readonly { data: Uint8Array }[]) => ({
      totalFrames: frames.length,
      totalRawBytes: frames.reduce((total, item) => total + item.data.length, 0),
    }),
    finish: async () => ({ frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 1 }),
    abort: async () => {},
  } satisfies ExportSessionClient;

  // A direction filter (or any filter) disqualifies DB mode even when the
  // durable source is available.
  const filtered = useExport({
    sessionId: 'session-main',
    dbSource,
    requestTarget: async () => ({ token: 'grant', displayName: 'out.csv' }),
    sessionClient: client,
  });
  const snapshot = createExportFrameSnapshot([frame('RX', [1], 1), frame('TX', [2], 2)], {
    direction: 'TX',
    timePreset: 'all',
    customStartMs: null,
    customEndMs: null,
  });
  await filtered.exportData(snapshot, 'csv', 'HEX', { unfiltered: false });
  assert.equal(sources.at(-1), undefined);
  assert.deepEqual(dbSource.prepared, [], 'filtered exports never consult the DB source');

  // An unfiltered export whose source cannot resolve falls back to renderer memory.
  const unavailable = recordingDbSource(null);
  const fallback = useExport({
    sessionId: 'session-main',
    dbSource: unavailable,
    requestTarget: async () => ({ token: 'grant', displayName: 'out.csv' }),
    sessionClient: client,
  });
  await fallback.exportData(unfilteredSnapshot([frame('RX', [1], 1)]), 'csv', 'HEX', {
    unfiltered: true,
  });
  assert.deepEqual(unavailable.prepared, ['session-main']);
  assert.equal(sources.at(-1), undefined);

  // Without the unfiltered flag the default is renderer mode.
  await filtered.exportData(unfilteredSnapshot([frame('RX', [1], 1)]), 'csv', 'HEX');
  assert.equal(sources.at(-1), undefined);
});

test('useExport: DB-mode begin totals divergence is surfaced, never silent', async () => {
  const dbSource = recordingDbSource({ workspaceId: 'workspace-main', toSeqExclusive: 9 });
  const api = useExport({
    sessionId: 'session-main',
    dbSource,
    requestTarget: async () => ({ token: 'grant-db', displayName: 'out.jsonl' }),
    sessionClient: {
      // The durable source holds 5 frames; the paused-capture preview showed 3.
      begin: async () => ({ exportId: 'db-export', expectedFrames: 5 }),
      append: async () => {
        throw new Error('renderer appends must not run in DB mode');
      },
      finish: async () => ({ frames: 5, rawBytes: 10, outputBytes: 20, durationMs: 2 }),
      abort: async () => {},
    },
  });

  const result = await api.exportData(
    unfilteredSnapshot([frame('RX', [1], 1), frame('RX', [2], 2), frame('RX', [3], 3)]),
    'jsonl',
    'HEX',
    { unfiltered: true },
  );

  assert.deepEqual(result, {
    ok: true,
    divergence: { persistedFrames: 5, selectionFrames: 3 },
  });
  assert.equal(api.progress.value.totalFrames, 5, 'progress re-baselines to the durable total');
  assert.equal(api.progress.value.completedFrames, 5);
});
