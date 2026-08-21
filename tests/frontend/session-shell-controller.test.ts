import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SERIAL_SHELL_COALESCE_MS,
  createSessionShellController,
} from '../../src/features/serial-shell';
import { DEFAULT_SERIAL_SHELL_CONFIG, cloneSerialShellConfig } from '../../src/lib/serial-shell';
import type { SerialSendResult } from '../../src/types/serial';
import type { SerialShellConfig } from '../../src/types/serial-shell';

function complete(bytes: number): SerialSendResult {
  return { outcome: 'complete', requestedBytes: bytes, sentBytes: bytes };
}

function createHarness(initial: Partial<SerialShellConfig> = {}) {
  let config = cloneSerialShellConfig({ ...DEFAULT_SERIAL_SHELL_CONFIG, ...initial });
  const sent: Uint8Array[] = [];
  const snapshots: number[] = [];
  const historyUpdates: string[][] = [];
  const rawObservers = new Set<(bytes: Uint8Array) => void>();
  const cleared = new Set<() => void>();
  const timers: Array<{ id: number; fire: () => void }> = [];
  let nextTimer = 1;
  const controller = createSessionShellController(
    () => config,
    (history) => {
      historyUpdates.push(history);
      config = cloneSerialShellConfig({ ...config, history });
      controller.configure(config);
    },
    {
      sendBytes: async (payload) => {
        sent.push(Uint8Array.from(payload));
        return complete(payload.length);
      },
      rawBytes: (callback) => {
        rawObservers.add(callback);
        return () => rawObservers.delete(callback);
      },
      registerAutomation: (port) => {
        void port;
        return () => undefined;
      },
      onCleared: (listener) => {
        cleared.add(listener);
        return () => cleared.delete(listener);
      },
      now: () => 1_000,
      scheduler: {
        schedule(callback) {
          const id = nextTimer;
          nextTimer += 1;
          timers.push({ id, fire: callback });
          return id;
        },
        cancel(handle) {
          const index = timers.findIndex((timer) => timer.id === handle);
          if (index >= 0) timers.splice(index, 1);
        },
        microtask(callback) {
          callback();
        },
      },
    },
    () => snapshots.push(1),
  );
  return {
    controller,
    sent,
    historyUpdates,
    emit(bytes: Uint8Array) {
      for (const observer of rawObservers) observer(bytes);
    },
    clearCapture() {
      for (const listener of cleared) listener();
    },
    flushTimers() {
      const pending = timers.splice(0);
      for (const timer of pending) timer.fire();
    },
  };
}

test('line submit encodes CRLF, echoes, and records history', async () => {
  const harness = createHarness({ localEcho: true, txNewline: 'crlf' });
  const result = await harness.controller.submitLine('AT');
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x41, 0x54, 0x0d, 0x0a]);
  assert.equal(harness.controller.snapshot().lines[0]?.text, 'AT');
  assert.deepEqual(harness.historyUpdates.at(-1), ['AT']);
  harness.controller.dispose();
});

test('character keys coalesce until the flush window or a control character', async () => {
  const harness = createHarness({ inputMode: 'char', localEcho: false, txNewline: 'lf' });
  assert.equal(await harness.controller.submitKey({ kind: 'text', text: 'a' }), null);
  assert.equal(harness.sent.length, 0);
  assert.equal(await harness.controller.submitKey({ kind: 'text', text: 'b' }), null);
  harness.flushTimers();
  await Promise.resolve();
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x61, 0x62]);
  await harness.controller.submitKey({ kind: 'control', code: 3 });
  assert.deepEqual(Array.from(harness.sent[1] ?? []), [0x03]);
  harness.controller.dispose();
});

test('raw RX updates the snapshot and clear resets it', () => {
  const harness = createHarness({ rxNewline: 'auto' });
  harness.emit(new TextEncoder().encode('ok\r\n'));
  assert.equal(harness.controller.snapshot().lines[0]?.text, 'ok');
  harness.clearCapture();
  assert.equal(harness.controller.snapshot().lines.length, 0);
  assert.ok(harness.controller.snapshot().resetVersion > 0);
  harness.controller.dispose();
});

test('coalesce delay constant stays at 16 ms', () => {
  assert.equal(SERIAL_SHELL_COALESCE_MS, 16);
});
