import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSecretString,
  loadSecretString,
  saveSecretString,
} from '../../src/lib/secure-settings.ts';

function stubWarn() {
  const calls: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console.warn = original;
    },
  };
}

test('secure settings no-op quietly outside the Tauri runtime', async () => {
  const warn = stubWarn();
  try {
    assert.equal(await loadSecretString('ai-api-key'), '');
    assert.equal(await saveSecretString('ai-api-key', 'secret'), false);
    assert.equal(await clearSecretString('ai-api-key'), false);
  } finally {
    warn.restore();
  }

  assert.equal(warn.calls.length, 0);
});
