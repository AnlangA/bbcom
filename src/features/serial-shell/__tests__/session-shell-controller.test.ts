import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SERIAL_SHELL_COALESCE_MS,
  SERIAL_SHELL_REPLAY_MAX_CHARS,
  createSessionShellController,
} from '@/features/serial-shell';
import { DEFAULT_SERIAL_SHELL_CONFIG, cloneSerialShellConfig } from '@/lib/serial-shell';
import type { SerialAutomationPausePort } from '@/features/serial';
import type { SerialSendResult } from '@/types/serial';
import type { SerialShellConfig } from '@/types/serial-shell';

function complete(bytes: number): SerialSendResult {
  return { outcome: 'complete', requestedBytes: bytes, sentBytes: bytes };
}

function createHarness(initial: Partial<SerialShellConfig> = {}) {
  const config = cloneSerialShellConfig({ ...DEFAULT_SERIAL_SHELL_CONFIG, ...initial });
  const sent: Uint8Array[] = [];
  const outputs: string[] = [];
  let resets = 0;
  const rawObservers = new Set<(bytes: Uint8Array) => void>();
  const cleared = new Set<() => void>();
  const automations: SerialAutomationPausePort[] = [];
  const timers: Array<{ id: number; fire: () => void }> = [];
  let nextTimer = 1;
  const controller = createSessionShellController(() => config, {
    sendBytes: async (payload) => {
      sent.push(Uint8Array.from(payload));
      return complete(payload.length);
    },
    onReceive: (callback) => {
      rawObservers.add(callback);
      return () => rawObservers.delete(callback);
    },
    registerAutomation: (port) => {
      automations.push(port);
      return () => undefined;
    },
    onCleared: (listener) => {
      cleared.add(listener);
      return () => cleared.delete(listener);
    },
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
  });
  controller.onOutput((chunk) => outputs.push(chunk));
  controller.onReset(() => {
    resets += 1;
  });
  return {
    controller,
    config,
    sent,
    outputs,
    resetCount: () => resets,
    emit(bytes: Uint8Array) {
      for (const observer of rawObservers) observer(bytes);
    },
    clearCapture() {
      for (const listener of cleared) listener();
    },
    automations,
    flushTimers() {
      const pending = timers.splice(0);
      for (const timer of pending) timer.fire();
    },
  };
}

test('terminal data coalesces text and flushes on enter with the configured EOL', async () => {
  const harness = createHarness({ txNewline: 'crlf', localEcho: false });
  harness.controller.handleTerminalData('a');
  harness.controller.handleTerminalData('b');
  assert.equal(harness.sent.length, 0);
  harness.flushTimers();
  await Promise.resolve();
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x61, 0x62]);
  harness.controller.handleTerminalData('\r');
  await harness.controller.flush();
  assert.deepEqual(Array.from(harness.sent[1] ?? []), [0x0d, 0x0a]);
  harness.controller.dispose();
});

test('pasted internal newlines use the configured EOL once per logical line', async () => {
  const harness = createHarness({ txNewline: 'crlf', localEcho: false });
  harness.controller.handleTerminalData('first\r\nsecond\n');
  await harness.controller.flush();
  assert.deepEqual(
    harness.sent.map((payload) => Array.from(payload)),
    [
      [0x66, 0x69, 0x72, 0x73, 0x74, 0x0d, 0x0a],
      [0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64, 0x0d, 0x0a],
    ],
  );
  harness.controller.dispose();
});

test('control characters transmit immediately', async () => {
  const harness = createHarness({ localEcho: false });
  harness.controller.handleTerminalData('\u0003');
  await harness.controller.flush();
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x03]);
  harness.controller.dispose();
});

test('local echo writes typed characters into the output stream and replay', async () => {
  const harness = createHarness({ localEcho: true, txNewline: 'cr' });
  harness.controller.handleTerminalData('hi');
  harness.controller.handleTerminalData('\r');
  await harness.controller.flush();
  assert.deepEqual(harness.outputs, ['hi', '\r\n']);
  assert.equal(harness.controller.replay(), 'hi\r\n');
  harness.controller.dispose();
});

test('enter with local echo disabled waits for the device response', async () => {
  const harness = createHarness({ localEcho: false, txNewline: 'lf' });
  harness.controller.handleTerminalData('\r');
  await harness.controller.flush();
  assert.deepEqual(harness.outputs, []);
  harness.flushTimers();
  assert.deepEqual(harness.outputs, []);
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x0a]);
  harness.controller.dispose();
});

test('device Enter response split across RX chunks is rendered exactly once', () => {
  const harness = createHarness({ localEcho: false, rxNewline: 'auto' });
  harness.controller.handleTerminalData('\r');
  harness.emit(new Uint8Array([0x0d]));
  harness.emit(new TextEncoder().encode('\nprompt> '));
  harness.flushTimers();
  assert.equal(harness.outputs.join(''), '\r\nprompt> ');
  assert.equal(harness.controller.replay(), '\r\nprompt> ');
  harness.controller.dispose();
});

test('consecutive device Enter responses are not altered', () => {
  const harness = createHarness({ localEcho: false, rxNewline: 'auto' });
  harness.controller.handleTerminalData('\r');
  harness.controller.handleTerminalData('\r');
  harness.emit(new TextEncoder().encode('\r\nprompt> \r\nprompt> '));
  harness.flushTimers();
  assert.equal(harness.outputs.join(''), '\r\nprompt> \r\nprompt> ');
  harness.controller.dispose();
});

test('whole-command device echo is not rewritten', () => {
  const harness = createHarness({ localEcho: false, rxNewline: 'auto' });
  harness.controller.handleTerminalData('help\r');
  harness.emit(new TextEncoder().encode('help\r\n'));
  harness.flushTimers();
  assert.equal(harness.outputs.join(''), 'help\r\n');
  harness.controller.dispose();
});

test('RX bytes are decoded, newline-adapted, published, and retained for replay', () => {
  const harness = createHarness({ rxNewline: 'auto' });
  harness.emit(new TextEncoder().encode('ok\nnext'));
  assert.deepEqual(harness.outputs, ['ok\r\nnext']);
  assert.equal(harness.controller.replay(), 'ok\r\nnext');
  harness.controller.dispose();
});

test('clear resets the replay buffer and notifies reset listeners', () => {
  const harness = createHarness();
  harness.emit(new TextEncoder().encode('data'));
  assert.equal(harness.controller.replay(), 'data');
  harness.clearCapture();
  assert.equal(harness.controller.replay(), '');
  assert.equal(harness.resetCount(), 1);
  harness.controller.dispose();
});

test('replay buffer is bounded', () => {
  const harness = createHarness({ rxNewline: 'none' });
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 8; i += 1) {
    harness.emit(new TextEncoder().encode(chunk));
  }
  assert.ok(harness.controller.replay().length <= SERIAL_SHELL_REPLAY_MAX_CHARS);
  harness.controller.dispose();
});

test('automation pause defers coalesced writes until restore', async () => {
  const harness = createHarness({ localEcho: false });
  const port = harness.automations.find((automation) => automation.id === 'serial-shell');
  assert.ok(port);
  const lease = await port.pause({ signal: new AbortController().signal });
  assert.ok(lease);
  harness.controller.handleTerminalData('\u0003');
  assert.equal(harness.sent.length, 0);
  await lease.restore();
  await harness.controller.flush();
  assert.deepEqual(Array.from(harness.sent[0] ?? []), [0x03]);
  harness.controller.dispose();
});

test('coalesce delay constant stays at 16 ms', () => {
  assert.equal(SERIAL_SHELL_COALESCE_MS, 16);
});
