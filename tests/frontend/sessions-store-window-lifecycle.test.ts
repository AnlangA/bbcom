// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionStore } from '../../src/stores/sessions.ts';

test('browser lifecycle events request the bounded final session-state flush', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  await sessions.whenPersistenceReady();
  sessions.createSession('COM-window', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    dtr: false,
    rts: false,
  });

  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(new Event('beforeunload'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();

  assert.ok(localStorage.getItem('bbcom-session-snapshots'));
});
