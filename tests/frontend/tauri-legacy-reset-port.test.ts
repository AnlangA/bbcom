import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { TauriLegacyResetPort } from '../../src/features/migration/tauri-legacy-reset-port.ts';

afterEach(() => invoke.mockReset());

test('a real native completion response is not replaced by a post-invoke AbortError', async () => {
  const controller = new AbortController();
  invoke.mockImplementation(async (command: string, args: unknown) => {
    assert.equal(command, 'complete_legacy_reset');
    const request = (args as { request: { requestId: string } }).request;
    controller.abort();
    return {
      requestId: request.requestId,
      journal: {
        phase: 'completed',
        workspaceId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 0,
      },
    };
  });

  const result = await new TauriLegacyResetPort().complete(
    '00000000-0000-4000-8000-000000000001',
    0,
    { signal: controller.signal },
  );

  assert.deepEqual(result, {
    phase: 'completed',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 0,
  });
});
