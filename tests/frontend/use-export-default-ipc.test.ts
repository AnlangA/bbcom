import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { useExport } from '../../src/composables/useExport.ts';
import type { DataFrame } from '../../src/types.ts';

function frame(): DataFrame {
  return { id: 'f1', direction: 'RX', timestamp: 1, data: new Uint8Array([0xaa]) };
}

afterEach(() => {
  invoke.mockReset();
});

test('useExport defaults stream through only the opaque file-grant IPC protocol', async () => {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'request_save_target':
        return { token: 'opaque-grant', displayName: 'capture.bin' };
      case 'begin_export':
        return { exportId: 'export-id' };
      case 'append_export_batch':
        return { totalFrames: 1, totalRawBytes: 1 };
      case 'finish_export':
        return { frames: 1, rawBytes: 1, outputBytes: 1, durationMs: 3 };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  const api = useExport();

  assert.deepEqual(await api.exportData([frame()], 'bin', 'HEX'), { ok: true });
  const request = invoke.mock.calls[0]?.[1] as {
    request: { purpose: string; suggestedName: string };
  };
  assert.equal(invoke.mock.calls[0]?.[0], 'request_save_target');
  assert.equal(request.request.purpose, 'export-bin');
  assert.match(request.request.suggestedName, /^bbcom-export-\d+\.bin$/);
  assert.deepEqual(invoke.mock.calls.slice(1), [
    [
      'begin_export',
      { request: { format: 'bin', token: 'opaque-grant', expectedFrames: 1, expectedRawBytes: 1 } },
    ],
    [
      'append_export_batch',
      {
        request: {
          exportId: 'export-id',
          frames: [{ id: 'f1', direction: 'RX', timestamp: 1, data: [0xaa] }],
        },
      },
    ],
    ['finish_export', { request: { exportId: 'export-id' } }],
  ]);
});

test('useExport defaults revoke a newly granted target if cancellation wins the dialog race', async () => {
  let resolveTarget!: (value: { token: string; displayName: string }) => void;
  const target = new Promise<{ token: string; displayName: string }>((resolve) => {
    resolveTarget = resolve;
  });
  invoke.mockImplementation(async (command: string) => {
    if (command === 'request_save_target') return target;
    if (command === 'revoke_file_grant') return undefined;
    throw new Error(`unexpected command ${command}`);
  });
  const api = useExport();
  const pending = api.exportData([frame()], 'bin', 'HEX');
  api.cancelExport();
  resolveTarget({ token: 'grant', displayName: 'capture.bin' });

  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.deepEqual(invoke.mock.calls.at(-1), [
    'revoke_file_grant',
    { request: { token: 'grant' } },
  ]);
});
