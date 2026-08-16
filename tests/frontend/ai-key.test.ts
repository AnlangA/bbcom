// @vitest-environment happy-dom
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  AI_KEY_LEGACY_STORAGE_KEY,
  clearAiApiKey,
  getAiKeyStatus,
  migrateLegacyAiApiKey,
  removeLegacyAiApiKey,
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

test('AI window key-status request is denied without reading or removing a legacy plaintext key', async () => {
  enableTauriRuntime();
  window.history.replaceState({}, '', '/?window=ai');
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, 'legacy-secret');
  invoke.mockRejectedValue({ code: 'SECURITY_DENIED' });

  await assert.rejects(migrateLegacyAiApiKey());

  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), 'legacy-secret');
  removeLegacyAiApiKey();
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), 'legacy-secret');
});

test('AI window key-status invoke is denied by the native label boundary', async () => {
  enableTauriRuntime();
  window.history.replaceState({}, '', '/?window=ai');
  invoke.mockRejectedValue({ code: 'SECURITY_DENIED' });

  await assert.rejects(getAiKeyStatus());
  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
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

test('non-Tauri renderers expose only a missing status and refuse credential writes', async () => {
  assert.deepEqual(await getAiKeyStatus(), { configured: false, durability: 'missing' });
  assert.deepEqual(await migrateLegacyAiApiKey(), { configured: false, durability: 'missing' });
  await assert.rejects(() => setAiApiKey('secret'), /native AI key storage is unavailable/);
  await assert.rejects(() => clearAiApiKey(), /native AI key storage is unavailable/);
  assert.deepEqual(invoke.mock.calls, []);
});

test('key status, writes, and clears use the native keyring command boundary', async () => {
  enableTauriRuntime();
  invoke.mockResolvedValue({ configured: true, durability: 'session' });

  assert.deepEqual(await getAiKeyStatus(), { configured: true, durability: 'session' });
  assert.deepEqual(await setAiApiKey('secret'), { configured: true, durability: 'session' });
  await clearAiApiKey();

  assert.deepEqual(invoke.mock.calls, [
    ['get_ai_key_status'],
    ['set_ai_api_key', { request: { value: 'secret' } }],
    ['clear_ai_api_key'],
  ]);
});

test('the alternate Tauri global is accepted without exposing a browser fallback', async () => {
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: {} });
  invoke.mockResolvedValue({ configured: false, durability: 'missing' });

  assert.deepEqual(await getAiKeyStatus(), { configured: false, durability: 'missing' });
  assert.deepEqual(invoke.mock.calls, [['get_ai_key_status']]);
});

test('migration retains plaintext when OS-keyring durability is not confirmed or no value exists', async () => {
  enableTauriRuntime();
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, ' session-only-secret ');
  invoke.mockResolvedValueOnce({ configured: true, durability: 'session' });

  await migrateLegacyAiApiKey();
  assert.deepEqual(invoke.mock.calls, [
    ['migrate_ai_api_key', { request: { value: 'session-only-secret' } }],
  ]);
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), ' session-only-secret ');

  invoke.mockReset();
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, '   ');
  invoke.mockResolvedValue({ configured: true, durability: 'os' });
  await migrateLegacyAiApiKey();
  assert.deepEqual(invoke.mock.calls, [['migrate_ai_api_key', { request: { value: undefined } }]]);
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), '   ');
});

test('main-window explicit cleanup removes only the legacy localStorage entry', () => {
  localStorage.setItem(AI_KEY_LEGACY_STORAGE_KEY, 'old-secret');
  removeLegacyAiApiKey();
  assert.equal(localStorage.getItem(AI_KEY_LEGACY_STORAGE_KEY), null);
});
