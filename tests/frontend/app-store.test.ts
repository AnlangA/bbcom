import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useAppStore } from '../../src/stores/app.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function withLocalStorageMock<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  try {
    return fn();
  } finally {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  }
}

test('setLoopIntervalMs clamps into the allowed range', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();

    app.setLoopIntervalMs(10);
    assert.equal(app.loopIntervalMs, 50, 'below minimum clamps to 50');

    app.setLoopIntervalMs(5_000_000);
    assert.equal(app.loopIntervalMs, 3_600_000, 'above maximum clamps to 1h');

    app.setLoopIntervalMs(250);
    assert.equal(app.loopIntervalMs, 250, 'in-range value passes through');

    app.setLoopIntervalMs(NaN);
    assert.equal(app.loopIntervalMs, 1000, 'NaN falls back to default 1000');
  });
});

test('applyAiCommand sets the draft and bumps the sequence', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();
    const before = app.aiCommandSeq;

    app.applyAiCommand('ls -la');

    assert.equal(app.aiCommandDraft, 'ls -la');
    assert.equal(app.aiCommandSeq, before + 1);
  });
});

test('pending AI command is consumed exactly once', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();

    app.setPendingAiCommand('pwd');
    assert.equal(app.pendingAiCommand, 'pwd');
    assert.equal(app.consumePendingAiCommand(), 'pwd');
    assert.equal(app.pendingAiCommand, '', 'consumed command is cleared');
    assert.equal(app.consumePendingAiCommand(), '', 'second consume returns empty');
  });
});
