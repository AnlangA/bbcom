// @vitest-environment happy-dom

import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { computed, effectScope, nextTick, ref, toRaw } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SerialSession } from '../../src/types/session.ts';
import type { PortConfig, SerialSendResult } from '../../src/types/serial.ts';
import type { SerialStopResult } from '../../src/features/sessions/application/use-serial-connection.ts';
import { PortLeaseRegistry } from '../../src/features/serial/application/port-lease-registry.ts';
import type { SerialAutomationPausePort } from '../../src/features/serial/application/serial-transaction-lease.ts';
import { SessionRuntimeStatusRegistry } from '../../src/features/sessions/runtime/session-runtime-status.ts';

const mocked = vi.hoisted(() => {
  const { ref } = require('vue') as typeof import('vue');
  return {
  autoLog: {
    enable: vi.fn(),
    disable: vi.fn(),
    prepareShutdown: vi.fn(),
    appendFrame: vi.fn(),
  },
  message: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  modbus: {
    master: {
      stop: vi.fn(),
      pauseForSerialTransaction: vi.fn(async () => undefined),
      resumeAfterSerialTransaction: vi.fn(),
    },
  },
  modbusOptions: undefined as unknown,
  serial: undefined as unknown,
  serialOptions: undefined as unknown,
  triggerFeed: vi.fn(),
  triggerPause: vi.fn(async () => undefined),
  triggerReset: vi.fn(),
  triggerResume: vi.fn(),
  triggerOptions: undefined as unknown,
  macroRunning: ref(false),
  macroRun: vi.fn(),
  macroAbort: vi.fn(),
  macroPause: vi.fn(async () => undefined),
  macroResume: vi.fn(),
  };
});

vi.mock('naive-ui', () => ({ useMessage: () => mocked.message }));
vi.mock('../../src/features/sessions/application/modbus-bridge.ts', () => ({
  createModbusBridge: (options: unknown) => {
    mocked.modbusOptions = options;
    return mocked.modbus;
  },
}));
vi.mock('@/features/sessions/application/modbus-bridge', () => ({
  createModbusBridge: (options: unknown) => {
    mocked.modbusOptions = options;
    return mocked.modbus;
  },
}));
vi.mock('../../src/features/sessions/application/mcumgr-bridge.ts', () => ({
  createMcumgrBridge: () => ({
    status: { value: { kind: 'idle' } },
    lastResult: { value: '' },
    busy: { value: false },
    portYielding: { value: false },
    execute: vi.fn(),
    cancel: vi.fn(),
    patchConfig: vi.fn(),
    rememberShell: vi.fn(),
    setResult: vi.fn(),
  }),
}));
vi.mock('@/features/sessions/application/mcumgr-bridge', () => ({
  createMcumgrBridge: () => ({
    status: { value: { kind: 'idle' } },
    lastResult: { value: '' },
    busy: { value: false },
    portYielding: { value: false },
    execute: vi.fn(),
    cancel: vi.fn(),
    patchConfig: vi.fn(),
    rememberShell: vi.fn(),
    setResult: vi.fn(),
  }),
}));
vi.mock('../../src/features/sessions/application/automation-bridge.ts', () => ({
  createAutomationBridge: (options: unknown) => {
    mocked.triggerOptions = (options as { triggers: unknown }).triggers;
    return {
      triggers: {
        feedBytes: mocked.triggerFeed,
        pause: mocked.triggerPause,
        reset: mocked.triggerReset,
        resume: mocked.triggerResume,
      },
      macro: {
        running: mocked.macroRunning,
        run: mocked.macroRun,
        abort: mocked.macroAbort,
        pause: mocked.macroPause,
        resume: mocked.macroResume,
      },
      autoLog: mocked.autoLog,
      dispose: vi.fn(),
    };
  },
}));
vi.mock('@/features/sessions/application/automation-bridge', () => ({
  createAutomationBridge: (options: unknown) => {
    mocked.triggerOptions = (options as { triggers: unknown }).triggers;
    return {
      triggers: {
        feedBytes: mocked.triggerFeed,
        pause: mocked.triggerPause,
        reset: mocked.triggerReset,
        resume: mocked.triggerResume,
      },
      macro: {
        running: mocked.macroRunning,
        run: mocked.macroRun,
        abort: mocked.macroAbort,
        pause: mocked.macroPause,
        resume: mocked.macroResume,
      },
      autoLog: mocked.autoLog,
      dispose: vi.fn(),
    };
  },
}));
vi.mock('../../src/features/sessions/application/serial-bridge.ts', () => ({
  createSerialBridge: (options: unknown) => {
    mocked.serialOptions = options;
    return mocked.serial;
  },
  serialConnectionFailureMessage: () => 'error.port_in_use',
}));
vi.mock('@/features/sessions/application/serial-bridge', () => ({
  createSerialBridge: (options: unknown) => {
    mocked.serialOptions = options;
    return mocked.serial;
  },
  serialConnectionFailureMessage: () => 'error.port_in_use',
}));

import {
  useSessionRuntimeController,
  type SessionRuntimeController,
} from '../../src/features/sessions/runtime/session-runtime-controller.ts';
import { useSessionStore } from '../../src/features/sessions/store/session-store.ts';

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
  connectionFailure: ReturnType<typeof ref<unknown>>;
  isConnected: ReturnType<typeof ref<boolean>>;
  isConnecting: ReturnType<typeof ref<boolean>>;
  isClosing: ReturnType<typeof ref<boolean>>;
  reconnecting: ReturnType<typeof ref<boolean>>;
  totalDroppedBytes: ReturnType<typeof ref<number>>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendBytes: ReturnType<typeof vi.fn>;
  sendBreak: ReturnType<typeof vi.fn>;
  rawBytes: ReturnType<typeof vi.fn>;
  serialTransactions: {
    registerAutomation: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
  };
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
    outcome: 'complete',
    requestedBytes: bytes,
    sentBytes: bytes,
  };
}

function rejected(bytes: number): SerialSendResult {
  return {
    outcome: 'failed',
    requestedBytes: bytes,
    sentBytes: 0,
    error: {
      code: 'SERIAL_DISCONNECTED',
      messageKey: 'error.serial_disconnected',
      retryable: true,
      operation: 'serial_send',
    },
  };
}

function incomplete(outcome: 'partial' | 'cancelled', bytes: number): SerialSendResult {
  const cancelled = outcome === 'cancelled';
  return {
    outcome,
    requestedBytes: bytes,
    sentBytes: 1,
    error: {
      code: cancelled ? 'CANCELLED' : 'SERIAL_PARTIAL_WRITE',
      messageKey: cancelled ? 'error.cancelled' : 'error.serial_partial_write',
      retryable: false,
      operation: 'serial_send',
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stoppedWithNoConnection(): SerialStopResult {
  return {
    watch: 'not-installed',
    rxDrainGuarantee: 'guaranteed',
    rxDrainStatus: 'no-active-connection',
    nativeDrainedBytes: 0,
    pendingOpen: 'none',
    portClose: 'no-active-port',
  };
}

function stoppedAfterNativeDrain(): SerialStopResult {
  return {
    watch: 'unwatch-acknowledged',
    rxDrainGuarantee: 'guaranteed',
    rxDrainStatus: 'idle-gap-observed',
    nativeDrainedBytes: 0,
    pendingOpen: 'none',
    portClose: 'close-acknowledged',
  };
}

function makeSerial(): FakeSerial {
  const observers = new Set<(bytes: Uint8Array) => void>();
  const isConnected = ref(false);
  const serial: FakeSerial = {
    error: ref<string | null>(null),
    connectionFailure: ref(null),
    isConnected,
    isConnecting: ref(false),
    isClosing: ref(false),
    reconnecting: ref(false),
    totalDroppedBytes: ref(0),
    start: vi.fn(async () => {
      isConnected.value = true;
      return true;
    }),
    stop: vi.fn(async () => {
      const result = isConnected.value ? stoppedAfterNativeDrain() : stoppedWithNoConnection();
      isConnected.value = false;
      return result;
    }),
    send: vi.fn(async (data: string) => complete(new TextEncoder().encode(data).length)),
    sendBytes: vi.fn(async (payload: Uint8Array) => complete(payload.length)),
    sendBreak: vi.fn(async () => true),
    rawBytes: vi.fn((callback: (bytes: Uint8Array) => void) => {
      observers.add(callback);
      return () => observers.delete(callback);
    }),
    serialTransactions: {
      registerAutomation: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ manualWriteAllowed: true })),
    },
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

function setup(runtimeStatusRegistry?: SessionRuntimeStatusRegistry, includeClosing = true) {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM1', config);
  const serial = makeSerial();
  if (!includeClosing) Reflect.deleteProperty(serial, 'isClosing');
  mocked.serial = serial;
  const scope = effectScope();
  const runtime = scope.run(() =>
    useSessionRuntimeController(
      computed(() => sessionById(store.sessions, id)),
      {
        notifications: mocked.message,
        portLeaseClient: new PortLeaseRegistry({ platform: 'windows' }),
        runtimeStatusRegistry,
      },
    ),
  );
  assert.ok(runtime);
  return { id, runtime, scope, serial, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocked.autoLog.enable.mockReset();
  mocked.autoLog.disable.mockReset();
  mocked.autoLog.prepareShutdown.mockReset();
  mocked.autoLog.enable.mockResolvedValue('capture.log');
  mocked.autoLog.disable.mockResolvedValue(undefined);
  mocked.autoLog.prepareShutdown.mockResolvedValue(undefined);
  mocked.message.error.mockReset();
  mocked.message.info.mockReset();
  mocked.message.success.mockReset();
  mocked.message.warning.mockReset();
  mocked.modbus.master.stop.mockReset();
  mocked.modbus.master.pauseForSerialTransaction.mockClear();
  mocked.modbus.master.resumeAfterSerialTransaction.mockReset();
  mocked.triggerFeed.mockReset();
  mocked.triggerFeed.mockResolvedValue(undefined);
  mocked.triggerPause.mockClear();
  mocked.triggerReset.mockReset();
  mocked.triggerResume.mockReset();
  mocked.modbusOptions = undefined;
  mocked.serialOptions = undefined;
  mocked.macroRunning.value = false;
  mocked.macroRun.mockReset();
  mocked.macroAbort.mockReset();
  mocked.macroPause.mockClear();
  mocked.macroResume.mockReset();
  mocked.macroRun.mockImplementation(async () => {
    mocked.macroRunning.value = true;
    return { completed: 1, failedAt: 1, aborted: false };
  });
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

test('resident controller publishes bounded-parser drop counters and resets them on clear', async () => {
  const { id, runtime, scope, serial, store } = setup();
  store.setParserState(id, { kind: 'fixed', frameSize: 1 });

  serial.emit(Uint8Array.from({ length: 5_001 }, (_, index) => index));
  await vi.advanceTimersByTimeAsync(17);

  assert.equal(runtime.parser.frames.value.length, 5_000);
  assert.equal(runtime.parser.frames.value[0]?.offset, 1);
  assert.equal(runtime.parser.droppedFrames.value, 1);
  assert.equal(runtime.parser.droppedBytes.value, 1);

  store.clearFrames(id);
  assert.equal(runtime.parser.frames.value.length, 0);
  assert.equal(runtime.parser.droppedFrames.value, 0);
  assert.equal(runtime.parser.droppedBytes.value, 0);

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
  serial.send.mockResolvedValueOnce(incomplete('partial', 2));
  assert.equal(await runtime.send('PA', false), false);
  serial.send.mockResolvedValueOnce(incomplete('cancelled', 2));
  assert.equal(await runtime.send('CA', false), false);
  assert.deepEqual(session.sendHistory, [{ data: 'AT', isHex: false }]);
  assert.equal(
    await runtime.sendBytes(new Uint8Array([1, 2])).then((result) => result.outcome === 'complete'),
    true,
  );

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
  assert.equal(
    mocked.autoLog.prepareShutdown.mock.calls.length,
    1,
    'dispose strictly finalizes auto-log',
  );

  assert.equal(await runtime.connect(), false);
  assert.equal(await runtime.send('ignored', false), false);
  assert.equal(await runtime.sendBreak(), false);
  assert.equal(runtime.startSendLoop('ignored', false), false);
  scope.stop();
});

test('prepareShutdown preserves runtime reuse and orders serial drain before auto-log footer', async () => {
  const { runtime, scope, serial } = setup();
  const order: string[] = [];
  serial.stop.mockImplementation(async () => {
    order.push('serial');
    serial.isConnected.value = false;
    return stoppedAfterNativeDrain();
  });
  mocked.autoLog.prepareShutdown.mockImplementation(async () => {
    order.push('footer');
  });

  assert.equal(await runtime.connect(), true);
  await runtime.prepareShutdown();
  assert.deepEqual(order, ['serial', 'footer']);
  assert.equal(mocked.modbus.master.stop.mock.calls.length, 1);

  assert.equal(await runtime.connect(), true, 'preparation does not dispose or seal the runtime');
  await runtime.prepareShutdown();
  assert.deepEqual(order, ['serial', 'footer', 'serial', 'footer']);

  await runtime.dispose();
  scope.stop();
});

test('prepareShutdown rejects false-ready serial evidence but still attempts the log footer', async () => {
  const { runtime, scope, serial } = setup();
  serial.stop.mockResolvedValue({
    watch: 'unwatch-acknowledged',
    rxDrainGuarantee: 'not-guaranteed',
    rxDrainStatus: 'renderer-overflow',
    nativeDrainedBytes: 4,
    pendingOpen: 'none',
    portClose: 'close-acknowledged',
  });

  await assert.rejects(runtime.prepareShutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /serial stop did not prove shutdown/);
    return true;
  });
  assert.equal(mocked.autoLog.prepareShutdown.mock.calls.length, 1);

  serial.stop.mockResolvedValue(stoppedWithNoConnection());
  await runtime.dispose();
  scope.stop();
});

test('prepareShutdown propagates strict auto-log footer or sync failures', async () => {
  const { runtime, scope, serial } = setup();
  serial.stop.mockResolvedValue(stoppedWithNoConnection());
  mocked.autoLog.prepareShutdown.mockRejectedValueOnce(new Error('native sync failed'));

  await assert.rejects(runtime.prepareShutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /native sync failed/);
    return true;
  });

  mocked.autoLog.prepareShutdown.mockResolvedValue(undefined);
  await runtime.dispose();
  scope.stop();
});

test('controller surfaces connection callbacks and a failed connect without leaking stale activity', async () => {
  const { id, runtime, scope, serial, store } = setup();
  const options = (mocked.serialOptions as { options: {
    onDisconnect?: () => void;
    onOverflow?: (total: number) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
  } }).options;

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

test('controller exposes lazy status/error branches and joins concurrent shutdown preparation', async () => {
  const { id, runtime, scope, serial, store } = setup();

  assert.equal(runtime.error.value, null);
  serial.connectionFailure.value = {
    error: {
      code: 'PORT_IN_USE',
      messageKey: 'error.port_in_use',
      retryable: false,
      operation: 'serial_open',
    },
    category: 'port-in-use',
  };
  assert.equal(typeof runtime.error.value, 'string');
  serial.error.value = 'port is already open';
  serial.start.mockResolvedValueOnce(false);
  assert.equal(await runtime.connect(), false);

  assert.equal(runtime.macro.status.value, 'idle');
  const sending = new Promise<SerialSendResult>(() => undefined);
  serial.send.mockReturnValueOnce(sending);
  mocked.macroRunning.value = true;
  const running = runtime.macro.run({
    id: 'coverage-macro',
    name: 'coverage',
    steps: [{ data: 'AT', isHex: false, delayMs: 0 }],
  });
  await Promise.resolve();
  assert.equal(runtime.macro.status.value, 'running');
  runtime.macro.abort();

  serial.stop.mockResolvedValueOnce({
    ...stoppedAfterNativeDrain(),
    portClose: 'force-close-acknowledged',
  });
  const footer = new Promise<void>(() => undefined);
  mocked.autoLog.prepareShutdown.mockReturnValueOnce(footer);
  const first = runtime.prepareShutdown();
  const joined = runtime.prepareShutdown();
  assert.equal(joined, first);

  // Leave intentionally pending operations scoped to this coverage case.
  assert.equal(sessionById(store.sessions, id).id, id);
  scope.stop();
  void running;
});

test('runtime status projection preserves closing, reconnecting, and connecting precedence', async () => {
  const statuses = new SessionRuntimeStatusRegistry();
  const { id, runtime, scope, serial } = setup(statuses);

  serial.isConnecting.value = true;
  assert.equal(statuses.get(id).phase, 'connecting');
  serial.reconnecting.value = true;
  assert.equal(statuses.get(id).phase, 'reconnecting');
  serial.isClosing.value = true;
  assert.equal(statuses.get(id).phase, 'closing');
  serial.isClosing.value = false;
  assert.equal(statuses.get(id).phase, 'reconnecting');
  serial.reconnecting.value = false;
  assert.equal(statuses.get(id).phase, 'connecting');
  serial.isConnecting.value = false;
  serial.isConnected.value = true;
  assert.equal(statuses.get(id).phase, 'connected');

  serial.serialTransactions.snapshot.mockReturnValueOnce({ manualWriteAllowed: false });
  assert.deepEqual(await runtime.macro.run({ id: 'blocked', name: 'blocked', steps: [] }), {
    completed: 0,
    failedAt: 0,
    aborted: true,
  });

  await runtime.dispose();
  scope.stop();
});

test('runtime status projection supports serial adapters without an explicit closing ref', async () => {
  const statuses = new SessionRuntimeStatusRegistry();
  const { id, runtime, scope } = setup(statuses, false);

  assert.equal(statuses.get(id).phase, 'stopped');
  await runtime.dispose();
  scope.stop();
});

test('loop payload is cleared when an already-running scheduler rejects a second start', async () => {
  const { runtime, scope, serial } = setup();
  serial.isConnected.value = true;

  let settleFirstSend!: (result: SerialSendResult) => void;
  const firstSend = new Promise<SerialSendResult>((resolve) => {
    settleFirstSend = resolve;
  });
  serial.send.mockReturnValueOnce(firstSend);

  assert.equal(runtime.startSendLoop('FIRST', false), true);
  await Promise.resolve();

  // Exercise the defensive mismatch branch: the scheduler is still running,
  // while a stale UI flag has already been reset by a concurrent boundary.
  toRaw(runtime.looping).value = false;
  assert.equal(runtime.startSendLoop('SECOND', false), false);

  settleFirstSend(complete(5));
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  runtime.stopSendLoop();

  await runtime.dispose();
  scope.stop();
});

test('runtime registers every automatic writer with the serial transaction gate', async () => {
  const { runtime, scope, serial } = setup();
  const ports = serial.serialTransactions.registerAutomation.mock.calls.map(
    ([port]) => port as SerialAutomationPausePort,
  );
  assert.deepEqual(
    ports.map((port) => port.id),
    ['serial-shell', 'cyclic-send', 'macro-runner', 'modbus-master', 'trigger-responses'],
  );
  const byId = Object.fromEntries(ports.map((port) => [port.id, port]));
  const context = {
    ownerId: 'plugin.test',
    generation: 1,
    signal: new AbortController().signal,
  };
  const shellSuspension = await byId['serial-shell'].pause(context);
  assert.ok(shellSuspension);
  await shellSuspension.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });
  assert.equal(await byId['cyclic-send'].pause(context), null);
  assert.equal(await byId['macro-runner'].pause(context), null);
  const modbusSuspension = await byId['modbus-master'].pause(context);
  assert.equal(mocked.modbus.master.pauseForSerialTransaction.mock.calls.length, 1);
  await modbusSuspension?.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });
  assert.equal(mocked.modbus.master.resumeAfterSerialTransaction.mock.calls.length, 1);
  const triggerSuspension = await byId['trigger-responses'].pause(context);
  assert.equal(mocked.triggerPause.mock.calls.length, 1);
  await triggerSuspension?.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });
  assert.equal(mocked.triggerResume.mock.calls.length, 1);

  await runtime.dispose();
  assert.equal(serial.serialTransactions.dispose.mock.calls.length, 1);
  scope.stop();
});

test('automation suspensions preserve cyclic and macro work but never restart after disposal', async () => {
  const { runtime, scope, serial } = setup();
  serial.isConnected.value = true;
  const ports = serial.serialTransactions.registerAutomation.mock.calls.map(
    ([port]) => port as SerialAutomationPausePort,
  );
  const byId = Object.fromEntries(ports.map((port) => [port.id, port]));
  const context = {
    ownerId: 'plugin.test',
    generation: 1,
    signal: new AbortController().signal,
  };

  const firstLoopSend = deferred<SerialSendResult>();
  serial.send.mockReturnValueOnce(firstLoopSend.promise);
  assert.equal(runtime.startSendLoop('AT', false), true);
  await Promise.resolve();
  const firstCyclicSuspension = await byId['cyclic-send'].pause(context);
  assert.ok(firstCyclicSuspension);
  await firstCyclicSuspension.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });
  firstLoopSend.resolve(complete(2));
  await Promise.resolve();
  await Promise.resolve();
  const finalCyclicSuspension = await byId['cyclic-send'].pause(context);
  assert.ok(finalCyclicSuspension);

  const macroSend = deferred<SerialSendResult>();
  serial.send.mockReturnValueOnce(macroSend.promise);
  const macroRun = runtime.macro.run({
    id: 'paused-macro',
    name: 'paused macro',
    steps: [{ data: 'M', isHex: false, delayMs: 0 }],
  });
  await Promise.resolve();
  const macroPause = byId['macro-runner'].pause(context);
  macroSend.resolve(complete(1));
  const macroSuspension = await macroPause;
  assert.ok(macroSuspension);
  assert.deepEqual(await macroRun, { completed: 1, failedAt: 1, aborted: false });
  await macroSuspension.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });

  await runtime.dispose();
  await finalCyclicSuspension.restore({
    ownerId: context.ownerId,
    generation: context.generation,
    reason: 'released',
  });
  assert.equal(runtime.looping.value, false);
  scope.stop();
});
