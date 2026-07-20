// @vitest-environment happy-dom

import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { computed, effectScope, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SerialSession } from '../../src/types/session.ts';
import type { PortConfig, SerialSendResult } from '../../src/types/serial.ts';

const mocked = vi.hoisted(() => ({
  autoLog: {
    enable: vi.fn(),
    disable: vi.fn(),
  },
  message: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  modbus: {
    master: { stop: vi.fn() },
  },
  modbusOptions: undefined as unknown,
  serial: undefined as unknown,
  serialArgs: undefined as unknown,
  triggerFeed: vi.fn(),
  triggerOptions: undefined as unknown,
}));

vi.mock('naive-ui', () => ({ useMessage: () => mocked.message }));
vi.mock('../../src/composables/useAutoLog.ts', () => ({ useAutoLog: () => mocked.autoLog }));
vi.mock('../../src/composables/useSessionModbus.ts', () => ({
  useSessionModbus: (options: unknown) => {
    mocked.modbusOptions = options;
    return mocked.modbus;
  },
}));
vi.mock('../../src/composables/useTriggers.ts', () => ({
  useTriggers: (options: unknown) => {
    mocked.triggerOptions = options;
    return { feedBytes: mocked.triggerFeed };
  },
}));
vi.mock('../../src/composables/useSerialConnection.ts', () => ({
  useSerialConnection: (...args: unknown[]) => {
    mocked.serialArgs = args;
    return mocked.serial;
  },
}));

import {
  useSessionRuntimeController,
  type SessionRuntimeController,
} from '../../src/features/sessions/runtime/session-runtime-controller.ts';
import { useSessionStore } from '../../src/stores/sessions.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

interface FakeSerial {
  error: ReturnType<typeof ref<string | null>>;
  isConnected: ReturnType<typeof ref<boolean>>;
  isConnecting: ReturnType<typeof ref<boolean>>;
  reconnecting: ReturnType<typeof ref<boolean>>;
  totalDroppedBytes: ReturnType<typeof ref<number>>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendBytes: ReturnType<typeof vi.fn>;
  sendBreak: ReturnType<typeof vi.fn>;
  rawBytes: ReturnType<typeof vi.fn>;
  emit: (bytes: Uint8Array) => void;
}

interface TriggerRuntimeOptions {
  onFire?: (fire: { triggerId: string; response: string; responseIsHex: boolean }) => void;
}

interface ModbusRuntimeOptions {
  waveformRef: { value: unknown };
  showWaveform: () => void;
}

function complete(bytes: number): SerialSendResult {
  return {
    status: 'complete',
    ok: true,
    requestedBytes: bytes,
    confirmedBytes: bytes,
    bytesWritten: bytes,
    reason: null,
  };
}

function rejected(bytes: number): SerialSendResult {
  return {
    status: 'rejected',
    ok: false,
    requestedBytes: bytes,
    confirmedBytes: 0,
    bytesWritten: 0,
    reason: 'not-connected',
    code: 'SERIAL_DISCONNECTED',
  };
}

function makeSerial(): FakeSerial {
  const observers = new Set<(bytes: Uint8Array) => void>();
  const isConnected = ref(false);
  const serial: FakeSerial = {
    error: ref<string | null>(null),
    isConnected,
    isConnecting: ref(false),
    reconnecting: ref(false),
    totalDroppedBytes: ref(0),
    start: vi.fn(async () => {
      isConnected.value = true;
      return true;
    }),
    stop: vi.fn(async () => {
      isConnected.value = false;
    }),
    send: vi.fn(async (data: string) => complete(new TextEncoder().encode(data).length)),
    sendBytes: vi.fn(async (payload: Uint8Array) => complete(payload.length)),
    sendBreak: vi.fn(async () => true),
    rawBytes: vi.fn((callback: (bytes: Uint8Array) => void) => {
      observers.add(callback);
      return () => observers.delete(callback);
    }),
    emit: (bytes: Uint8Array) => {
      for (const callback of observers) callback(bytes);
    },
  };
  return serial;
}

function parserTexts(runtime: SessionRuntimeController): string[] {
  return runtime.parser.frames.value.map((frame) => new TextDecoder().decode(frame.data));
}

function sessionById(session: SerialSession[], id: string): SerialSession {
  const found = session.find((item) => item.id === id);
  assert.ok(found);
  return found;
}

function setup() {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM1', config);
  const serial = makeSerial();
  mocked.serial = serial;
  const scope = effectScope();
  const runtime = scope.run(() =>
    useSessionRuntimeController(computed(() => sessionById(store.sessions, id))),
  );
  assert.ok(runtime);
  return { id, runtime, scope, serial, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocked.autoLog.enable.mockReset();
  mocked.autoLog.disable.mockReset();
  mocked.autoLog.enable.mockResolvedValue('capture.log');
  mocked.autoLog.disable.mockResolvedValue(undefined);
  mocked.message.error.mockReset();
  mocked.message.info.mockReset();
  mocked.message.success.mockReset();
  mocked.message.warning.mockReset();
  mocked.modbus.master.stop.mockReset();
  mocked.triggerFeed.mockReset();
  mocked.triggerFeed.mockResolvedValue(undefined);
  mocked.modbusOptions = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

test('resident controller parses raw RX without a panel, rebuilds on settings, and clears with the terminal', async () => {
  const { id, runtime, scope, serial, store } = setup();
  store.setParserState(id, { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false });
  const triggerId = store.addTrigger(id, {
    name: 'Ready trigger',
    enabled: true,
    matchMode: 'text',
    pattern: 'ready',
    response: 'ack',
    responseIsHex: false,
    cooldownMs: 0,
  });
  assert.ok(triggerId);
  const triggerOptions = mocked.triggerOptions as TriggerRuntimeOptions;
  triggerOptions.onFire?.({ triggerId, response: 'ack', responseIsHex: false });
  triggerOptions.onFire?.({ triggerId: 'deleted', response: 'ack', responseIsHex: false });
  assert.equal(mocked.message.info.mock.calls.length, 2);

  serial.emit(new TextEncoder().encode('one\npar'));
  assert.deepEqual(parserTexts(runtime), [], 'parser presentation is UI-throttled');
  await vi.advanceTimersByTimeAsync(17);
  assert.deepEqual(parserTexts(runtime), ['one']);

  serial.emit(new TextEncoder().encode('tial\n'));
  await vi.advanceTimersByTimeAsync(17);
  assert.deepEqual(parserTexts(runtime), ['one', 'partial']);
  assert.equal(mocked.triggerFeed.mock.calls.length, 2, 'triggers see the same raw stream');

  store.addFrame(id, { direction: 'RX', data: new Uint8Array([0x41, 0x42, 0x43, 0x44]) });
  store.setParserState(id, { kind: 'fixed', frameSize: 2 });
  assert.deepEqual(parserTexts(runtime), ['AB', 'CD'], 'settings rebuild retained capture history');

  const resetBeforeClear = runtime.parser.resetVersion.value;
  store.clearFrames(id);
  assert.deepEqual(parserTexts(runtime), []);
  assert.ok(runtime.parser.resetVersion.value > resetBeforeClear);

  // Replacing state with the same parser key must preserve the active stream.
  store.setParserState(id, { kind: 'fixed', frameSize: 2 });
  serial.emit(new Uint8Array([0x11, 0x22]));
  await vi.advanceTimersByTimeAsync(17);
  assert.deepEqual(
    runtime.parser.frames.value.map((frame) => Array.from(frame.data)),
    [[0x11, 0x22]],
  );

  const modbusOptions = mocked.modbusOptions as ModbusRuntimeOptions;
  assert.equal(modbusOptions.waveformRef.value, null);
  const detach = runtime.attachView({ waveformRef: ref(null) });
  assert.equal(modbusOptions.waveformRef.value, null);
  modbusOptions.showWaveform();
  assert.equal(runtime.viewMode.value, 'waveform');
  detach();

  await runtime.dispose();
  scope.stop();
});

test('controller delegates lifecycle commands and releases every resident resource exactly once', async () => {
  const { id, runtime, scope, serial, store } = setup();
  const session = sessionById(store.sessions, id);

  assert.equal(await runtime.connect(), true);
  await runtime.disconnect();
  assert.equal(serial.stop.mock.calls.length, 1);
  serial.isConnected.value = true;
  assert.equal(await runtime.send('AT', false), true);
  serial.send.mockResolvedValueOnce(rejected(2));
  assert.equal(await runtime.send('NO', false), false);
  assert.deepEqual(session.sendHistory, [{ data: 'AT', isHex: false }]);
  assert.equal(await runtime.sendBytes(new Uint8Array([1, 2])).then((result) => result.ok), true);

  assert.equal(await runtime.sendBreak(), true);
  serial.sendBreak.mockResolvedValueOnce(false);
  assert.equal(await runtime.sendBreak(), false);
  assert.ok(mocked.message.success.mock.calls.length > 0);
  assert.ok(mocked.message.warning.mock.calls.length > 0);

  assert.equal(runtime.startSendLoop('PING', false), true);
  serial.isConnected.value = false;
  await nextTick();
  assert.equal(runtime.looping.value, false, 'disconnecting halts the settle-based send loop');
  serial.isConnected.value = true;
  serial.send.mockResolvedValueOnce(rejected(4));
  assert.equal(runtime.startSendLoop('FAIL', false), true);
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  assert.ok(mocked.message.error.mock.calls.length >= 1, 'failed loop send is surfaced once');
  runtime.stopSendLoop();
  assert.equal(runtime.startSendLoop('', false), false);
  serial.isConnected.value = false;
  await nextTick();
  assert.equal(runtime.startSendLoop('PING', false), false);

  session.autoLogEnabled = false;
  await runtime.toggleAutoLog();
  mocked.autoLog.enable.mockResolvedValueOnce(null);
  await runtime.toggleAutoLog();
  session.autoLogEnabled = true;
  await runtime.toggleAutoLog();
  assert.equal(mocked.autoLog.enable.mock.calls.length, 2);
  assert.equal(mocked.autoLog.disable.mock.calls.length, 1);

  const detach = runtime.attachView({ waveformRef: ref(null) });
  detach();
  detach();

  const firstDispose = runtime.dispose();
  const secondDispose = runtime.dispose();
  assert.equal(firstDispose, secondDispose);
  await firstDispose;
  assert.ok(serial.stop.mock.calls.length >= 1);
  assert.equal(mocked.modbus.master.stop.mock.calls.length, 1);
  assert.equal(mocked.autoLog.disable.mock.calls.length, 2, 'dispose invalidates auto-log');

  assert.equal(await runtime.connect(), false);
  assert.equal(await runtime.send('ignored', false), false);
  assert.equal(await runtime.sendBreak(), false);
  assert.equal(runtime.startSendLoop('ignored', false), false);
  scope.stop();
});

test('controller surfaces connection callbacks and a failed connect without leaking stale activity', async () => {
  const { id, runtime, scope, serial, store } = setup();
  const args = mocked.serialArgs as unknown[];
  const options = args[3] as {
    onDisconnect?: () => void;
    onOverflow?: (total: number) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
  };

  options.onDisconnect?.();
  options.onOverflow?.(42);
  options.onReconnecting?.();
  options.onReconnected?.();
  assert.equal(sessionById(store.sessions, id).droppedBytes, 42);
  assert.ok(mocked.message.warning.mock.calls.length >= 2);
  assert.ok(mocked.message.info.mock.calls.length >= 1);
  assert.ok(mocked.message.success.mock.calls.length >= 1);

  serial.start.mockResolvedValueOnce(false);
  serial.error.value = 'watch failed';
  assert.equal(await runtime.connect(), false);
  assert.ok(mocked.message.error.mock.calls.length >= 1);

  mocked.triggerFeed.mockRejectedValueOnce(new Error('trigger response failed'));
  serial.emit(new Uint8Array([1]));
  await Promise.resolve();
  await runtime.dispose();
  scope.stop();
});

test('headless controller does not require a document to allocate or dispose runtime resources', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  try {
    const { runtime, scope } = setup();
    await runtime.dispose();
    scope.stop();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
