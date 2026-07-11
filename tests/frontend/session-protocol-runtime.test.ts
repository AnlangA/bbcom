import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import { useSerialConnection } from '../../src/composables/useSerialConnection.ts';
import { SessionProtocolRuntime } from '../../src/features/sessions/runtime/session-protocol-runtime.ts';
import type {
  SerialPortAdapter,
  SerialWatchHandleAdapter,
} from '../../src/lib/serial-port-adapter.ts';
import type { SerialTimerScheduler } from '../../src/lib/serial-rx-scheduler.ts';
import { useSessionStore } from '../../src/stores/sessions.ts';
import type { PortConfig } from '../../src/types/serial.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function parsedText(runtime: SessionProtocolRuntime): string[] {
  return runtime.snapshot().frames.map((frame) => new TextDecoder().decode(frame.data));
}

class FakeWatch implements SerialWatchHandleAdapter {
  async unwatch(): Promise<void> {}
}

class FakePort implements SerialPortAdapter {
  handlers: WatchHandlers | null = null;

  async open(): Promise<void> {}

  async watch(handlers: WatchHandlers, _options?: WatchOptions): Promise<SerialWatchHandleAdapter> {
    this.handlers = handlers;
    return new FakeWatch();
  }

  async writeBinary(data: Uint8Array): Promise<number> {
    return data.length;
  }

  async writeDataTerminalReady(_value: boolean): Promise<void> {}
  async writeRequestToSend(_value: boolean): Promise<void> {}
  async setBreak(): Promise<void> {}
  async clearBreak(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeTimerScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const scheduler: SerialTimerScheduler = {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) {
      (handle as (typeof timers)[number]).cancelled = true;
    },
    microtask() {
      throw new Error('test does not permit RX draining or UI/RAF work');
    },
  };
  return { scheduler, timers };
}

test('resident protocol parser consumes raw RX while terminal capture and UI publication never run', async () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM1', config);
  const port = new FakePort();
  const timer = fakeTimerScheduler();
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(sessionId, 'COM1', config, undefined, {
      createPort: () => port,
      timerScheduler: timer.scheduler,
      isDocumentVisible: () => true,
    }),
  );
  assert.ok(connection);

  const parser = new SessionProtocolRuntime();
  parser.configure({ kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false });
  const removeRawParser = connection.rawBytes((chunk) => {
    parser.feed(chunk, 1_000);
  });

  assert.equal(await connection.start(), true);
  port.handlers?.onData(bytes('first\npar'));

  // The 16ms capture drain remains pending. No frame was materialized for a
  // terminal component, but the long-lived raw-byte parser already emitted a
  // complete protocol frame.
  assert.equal(store.sessions[0].frames.length, 0);
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].delay, 16);
  assert.deepEqual(parsedText(parser), ['first']);

  port.handlers?.onData(bytes('tial\n'));
  assert.equal(store.sessions[0].frames.length, 0, 'no capture/UI timer was run');
  assert.deepEqual(parsedText(parser), ['first', 'partial']);

  removeRawParser();
  await connection.stop();
  scope.stop();
});

test('resident protocol parser resets for settings changes and explicit clears', () => {
  const parser = new SessionProtocolRuntime();
  parser.configure({ kind: 'fixed', frameSize: 2 });
  parser.feed(new Uint8Array([0x41, 0x42, 0x43, 0x44]), 1_000);
  const fixedSnapshot = parser.snapshot();
  assert.deepEqual(parsedText(parser), ['AB', 'CD']);

  parser.configure({ kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false }, [
    { direction: 'RX', data: bytes('captured\n') },
  ]);
  const delimiterSnapshot = parser.snapshot();
  assert.ok(delimiterSnapshot.resetVersion > fixedSnapshot.resetVersion);
  assert.deepEqual(parsedText(parser), ['captured']);
  parser.feed(bytes('next\n'), 1_100);
  assert.deepEqual(parsedText(parser), ['captured', 'next']);

  parser.clear();
  const clearedSnapshot = parser.snapshot();
  assert.ok(clearedSnapshot.resetVersion > delimiterSnapshot.resetVersion);
  assert.deepEqual(clearedSnapshot.frames, []);

  parser.configure({ kind: 'delimiter', delimiter: [], includeDelimiter: false });
  parser.feed(bytes('ignored\n'), 1_200);
  assert.deepEqual(parsedText(parser), []);
});

test('resident protocol parser reports raw-byte throughput before a frame completes', () => {
  const parser = new SessionProtocolRuntime();
  parser.configure({ kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false });

  assert.equal(parser.feed(bytes('abc'), 1_000), false);
  assert.equal(parser.snapshot().throughputBps, 0);
  assert.equal(parser.feed(bytes('de'), 1_600), true);
  assert.deepEqual(parsedText(parser), []);
  assert.equal(parser.snapshot().throughputBps, 8);
});
