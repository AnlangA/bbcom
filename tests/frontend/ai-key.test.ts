// @vitest-environment happy-dom
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  clearAiApiKey,
  getAiKeyStatus,
  isAiAssistantWindow,
  setAiApiKey,
} from '../../src/features/settings/tauri-ai-key.ts';

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
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  window.history.replaceState({}, '', '/');
});

test('AI window key-status invoke is denied by the native label boundary', async () => {
  enableTauriRuntime();
  window.history.replaceState({}, '', '/?window=ai');
  invoke.mockRejectedValue({ code: 'SECURITY_DENIED' });

  assert.equal(isAiAssistantWindow(), true);
  await assert.rejects(getAiKeyStatus());
  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
});

test('non-Tauri renderers expose only a missing status and refuse credential writes', async () => {
  assert.deepEqual(await getAiKeyStatus(), { configured: false });
  await assert.rejects(() => setAiApiKey('secret'), /native AI key storage is unavailable/);
  await assert.rejects(() => clearAiApiKey(), /native AI key storage is unavailable/);
  assert.deepEqual(invoke.mock.calls, []);
});

test('key status, writes, and clears use the native command boundary', async () => {
  enableTauriRuntime();
  invoke.mockResolvedValue({ configured: true });

  assert.deepEqual(await getAiKeyStatus(), { configured: true });
  assert.deepEqual(await setAiApiKey('secret'), { configured: true });
  await clearAiApiKey();

  assert.deepEqual(invoke.mock.calls, [
    ['get_ai_key_status'],
    ['set_ai_api_key', { request: { value: 'secret' } }],
    ['clear_ai_api_key'],
  ]);
});

test('the alternate Tauri global is accepted without exposing a browser fallback', async () => {
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: {} });
  invoke.mockResolvedValue({ configured: false });

  assert.deepEqual(await getAiKeyStatus(), { configured: false });
  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
});
