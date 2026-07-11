import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  asAppError,
  calculateChecksum,
  cancelAiRequest,
  getAiWindowState,
  getCommandErrorMessage,
  hideAiWindow,
  invokeAbortAutoLog,
  invokeAbortExport,
  invokeAppendAutoLogBatch,
  invokeAppendExportBatch,
  invokeBeginAutoLog,
  invokeBeginExport,
  invokeFinishAutoLog,
  invokeFinishExport,
  requestSaveTarget,
  resizeAiWindow,
  revokeFileGrant,
  runAiRequest,
  showAiWindow,
  startAiWindowDrag,
} from '../../src/lib/ipc.ts';

test('IPC: every export, automatic-log, and AI wrapper sends the exact bounded DTO', async () => {
  invoke.mockResolvedValue({ ok: true });
  const frames = [{ id: 'f1', direction: 'RX' as const, timestamp: 7, data: [1, 2] }];

  await calculateChecksum(new Uint8Array([0xaa]), 'CRC16');
  await requestSaveTarget('export-csv', 'capture.csv');
  await revokeFileGrant('grant');
  await invokeBeginExport('csv', 'grant', 1, 2);
  await invokeAppendExportBatch('export', frames);
  await invokeFinishExport('export');
  await invokeAbortExport('export');
  await invokeBeginAutoLog('grant', 'hex');
  await invokeAppendAutoLogBatch('log', frames);
  await invokeFinishAutoLog('log');
  await invokeAbortAutoLog('log');
  await runAiRequest({
    requestId: 'request',
    kind: 'terminal',
    prompt: 'help',
    model: 'glm-4.5-air',
    shell: 'zsh',
    context: 'untrusted serial bytes',
  });
  await cancelAiRequest('request');
  await getAiWindowState();
  await showAiWindow();
  await hideAiWindow();
  await resizeAiWindow(480, 640);
  await startAiWindowDrag();

  assert.deepEqual(invoke.mock.calls, [
    ['calculate_checksum', { request: { data: [0xaa], algorithm: 'CRC16' } }],
    ['request_save_target', { request: { purpose: 'export-csv', suggestedName: 'capture.csv' } }],
    ['revoke_file_grant', { request: { token: 'grant' } }],
    [
      'begin_export',
      { request: { format: 'csv', token: 'grant', expectedFrames: 1, expectedRawBytes: 2 } },
    ],
    ['append_export_batch', { request: { exportId: 'export', frames } }],
    ['finish_export', { request: { exportId: 'export' } }],
    ['abort_export', { request: { exportId: 'export' } }],
    ['begin_auto_log', { request: { token: 'grant', format: 'hex' } }],
    ['append_auto_log_batch', { request: { logId: 'log', frames } }],
    ['finish_auto_log', { request: { logId: 'log' } }],
    ['abort_auto_log', { request: { logId: 'log' } }],
    [
      'run_ai_request',
      {
        request: {
          requestId: 'request',
          kind: 'terminal',
          prompt: 'help',
          model: 'glm-4.5-air',
          shell: 'zsh',
          context: 'untrusted serial bytes',
        },
      },
    ],
    ['cancel_ai_request', { request: { requestId: 'request' } }],
    ['get_ai_window_state'],
    ['show_ai_window'],
    ['hide_ai_window'],
    ['resize_ai_window', { request: { width: 480, height: 640 } }],
    ['start_ai_window_drag'],
  ]);
});

test('IPC: AppError narrowing requires each security-contract field', () => {
  assert.equal(asAppError(null), null);
  assert.equal(asAppError('failure'), null);
  assert.equal(asAppError({}), null);
  assert.equal(asAppError({ code: 'BUSY' }), null);
  assert.equal(asAppError({ code: 'BUSY', messageKey: 'error.busy' }), null);
  assert.equal(asAppError({ code: 'BUSY', messageKey: 'error.busy', retryable: true }), null);
  const valid = {
    code: 'BUSY',
    messageKey: 'error.busy',
    retryable: true,
    operation: 'run_ai_request',
  } as const;
  assert.equal(asAppError(valid), valid);
});

test('IPC: command error display chooses code, details, message, then fallback without leaking shape', () => {
  assert.equal(getCommandErrorMessage('plain', 'fallback'), 'plain');
  assert.equal(getCommandErrorMessage(null, 'fallback'), 'fallback');
  assert.equal(getCommandErrorMessage({ code: 'NOT_MAPPED' }, 'fallback'), 'fallback');
  assert.equal(
    getCommandErrorMessage({ details: { message: 'safe detail' } }, 'fallback'),
    'safe detail',
  );
  assert.equal(
    getCommandErrorMessage({ details: {}, message: 'safe message' }, 'fallback'),
    'safe message',
  );
  assert.equal(getCommandErrorMessage({ details: { message: '' } }, 'fallback'), 'fallback');
});
