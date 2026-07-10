// @vitest-environment happy-dom
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  AI_KEY_LEGACY_STORAGE_KEY,
  migrateLegacyAiApiKey,
  removeLegacyAiApiKey,
} from '../../src/lib/ai-key.ts';

function enableTauriRuntime(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
}

afterEach(() => {
  invoke.mockReset();
  localStorage.clear();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.history.replaceState({}, '', '/');
});

test('AI window reads only key status and never reads or removes a legacy plaintext key', async () => {
  enableTauriRuntime();
  window.history.replaceState({}, '', '/?window=ai');
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, 'legacy-secret');
  invoke.mockResolvedValue({ configured: true, durability: 'os' });

  const status = await migrateLegacyAiApiKey();

  assert.deepEqual(status, { configured: true, durability: 'os' });
  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), 'legacy-secret');
  removeLegacyAiApiKey();
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), 'legacy-secret');
});

test('main window supplies the legacy value only to the one-way migration command', async () => {
  enableTauriRuntime();
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, 'legacy-secret');
  invoke.mockResolvedValue({ configured: true, durability: 'os' });

  await migrateLegacyAiApiKey();

  assert.deepEqual(invoke.mock.calls, [
    ['migrate_ai_api_key', { request: { value: 'legacy-secret' } }],
  ]);
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), null);
});
