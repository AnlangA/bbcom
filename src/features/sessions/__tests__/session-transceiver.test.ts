import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { createSessionTransceiver } from '@/features/sessions/application/session-transceiver.ts';
import { useSessionCapture } from '@/features/sessions/ports/session-ports.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import type { PortConfig, SerialSendResult } from '@/types';

const config: PortConfig = {
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 0,
  dtr: false,
  rts: false,
};

function complete(bytes: number): SerialSendResult {
  return { outcome: 'complete', requestedBytes: bytes, sentBytes: bytes };
}

function createFakeSerial() {
  const receiveListeners = new Set<(bytes: Uint8Array) => void>();
  const sendBytes = vi.fn(async (payload: Uint8Array) => complete(payload.length));
  const dispose = vi.fn(async () => undefined);
  return {
    isConnecting: ref(false),
    isConnected: ref(true),
    isClosing: ref(false),
    reconnecting: ref(false),
    error: ref<string | null>(null),
    connectionFailure: ref(null),
    totalDroppedBytes: ref(0),
    serialTransactions: {
      registerAutomation: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => undefined),
    },
    start: vi.fn(async () => true),
    stop: vi.fn(async () => ({
      watch: 'not-installed',
      rxDrainGuarantee: 'guaranteed',
      rxDrainStatus: 'no-active-connection',
      nativeDrainedBytes: 0,
      pendingOpen: 'none',
      portClose: 'no-active-port',
    })),
    send: vi.fn(async (data: string) => complete(data.length)),
    sendBytes,
    sendBreak: vi.fn(async () => true),
    rawBytes(listener: (bytes: Uint8Array) => void) {
      receiveListeners.add(listener);
      return () => receiveListeners.delete(listener);
    },
    dispose,
    emit(bytes: Uint8Array) {
      for (const listener of receiveListeners) listener(bytes);
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

test('one transceiver shares native RX and the send API across function consumers', async () => {
  const store = useSessionStore();
  const sessionId = store.createSession('COM-shared', config);
  const serial = createFakeSerial();
  const transceiver = createSessionTransceiver({
    capture: useSessionCapture(sessionId),
    serial: {
      sessionId,
      portName: 'COM-shared',
      config,
      options: undefined,
      dependencies: { leaseClient: {} as never, sessionName: 'shared' },
      appendAutoLogFrame: () => undefined,
    },
    createSerial: () => serial as never,
  });
  const shellRx: number[][] = [];
  const modbusRx: number[][] = [];
  const stopShell = transceiver.onReceive((bytes) => shellRx.push(Array.from(bytes)));
  transceiver.onReceive((bytes) => modbusRx.push(Array.from(bytes)));

  serial.emit(Uint8Array.of(1, 2, 3));
  assert.deepEqual(shellRx, [[1, 2, 3]]);
  assert.deepEqual(modbusRx, [[1, 2, 3]]);

  await transceiver.sendBytes(Uint8Array.of(4, 5));
  assert.deepEqual(serial.sendBytes.mock.calls[0]?.[0], Uint8Array.of(4, 5));

  stopShell();
  serial.emit(Uint8Array.of(6));
  assert.deepEqual(shellRx, [[1, 2, 3]]);
  assert.deepEqual(modbusRx, [[1, 2, 3], [6]]);

  await transceiver.dispose();
  assert.equal(serial.dispose.mock.calls.length, 1);
});

test('MCUmgr trace enters the shared raw timeline, UI view, RX stream, and auto-log once', () => {
  const store = useSessionStore();
  const sessionId = store.createSession('COM-mcumgr', config);
  const serial = createFakeSerial();
  const logged: Array<{ id: string; direction: string; bytes: number[] }> = [];
  const receiveOrder: string[] = [];
  const transceiver = createSessionTransceiver({
    capture: useSessionCapture(sessionId),
    serial: {
      sessionId,
      portName: 'COM-mcumgr',
      config,
      options: undefined,
      dependencies: { leaseClient: {} as never, sessionName: 'mcumgr' },
      appendAutoLogFrame: (id, frame) => {
        logged.push({ id, direction: frame.direction, bytes: Array.from(frame.data) });
      },
    },
    createSerial: () => serial as never,
  });
  transceiver.onReceive((bytes) => receiveOrder.push(`rx:${Array.from(bytes).join(',')}`));
  assert.equal(transceiver.rawData.frames.value.length, 0);
  assert.equal(transceiver.rawData.txBytes.value, 0);

  transceiver.ingestTraceFrames([
    { direction: 'TX', timestampMs: 10, data: [0x06, 0x09] },
    { direction: 'RX', timestampMs: 11, data: [0x04, 0x00] },
  ]);

  assert.deepEqual(receiveOrder, ['rx:4,0']);
  assert.equal(transceiver.rawData.version.value, 1, 'one final publication per trace batch');
  assert.equal(transceiver.rawData.txBytes.value, 2);
  assert.equal(transceiver.rawData.rxBytes.value, 2);
  assert.deepEqual(
    transceiver.rawData.frames.value.map((frame) => ({
      direction: frame.direction,
      origin: frame.origin,
      bytes: Array.from(frame.data),
    })),
    [
      { direction: 'TX', origin: 'mcumgr-trace', bytes: [0x06, 0x09] },
      { direction: 'RX', origin: 'mcumgr-trace', bytes: [0x04, 0x00] },
    ],
  );
  assert.deepEqual(logged, [
    { id: sessionId, direction: 'TX', bytes: [0x06, 0x09] },
    { id: sessionId, direction: 'RX', bytes: [0x04, 0x00] },
  ]);
});

test('pause, buffered data, resume, and clear are projected by the transceiver view', () => {
  const store = useSessionStore();
  const sessionId = store.createSession('COM-pause', config);
  const serial = createFakeSerial();
  const transceiver = createSessionTransceiver({
    capture: useSessionCapture(sessionId),
    serial: {
      sessionId,
      portName: 'COM-pause',
      config,
      options: undefined,
      dependencies: { leaseClient: {} as never, sessionName: 'pause' },
      appendAutoLogFrame: () => undefined,
    },
    createSerial: () => serial as never,
  });
  let clears = 0;
  transceiver.onCaptureCleared(() => {
    clears += 1;
  });

  transceiver.setCapturePaused(true);
  transceiver.ingestTraceFrames([{ direction: 'RX', timestampMs: 1, data: [1, 2, 3] }]);
  assert.equal(transceiver.rawData.paused.value, true);
  assert.equal(transceiver.rawData.frames.value.length, 0);
  assert.equal(transceiver.rawData.bufferedFrames.value.length, 1);

  transceiver.setCapturePaused(false);
  assert.equal(transceiver.rawData.frames.value.length, 1);
  assert.equal(transceiver.rawData.bufferedFrames.value.length, 0);
  transceiver.clearRawData();
  assert.equal(transceiver.rawData.frames.value.length, 0);
  assert.equal(transceiver.rawData.rxBytes.value, 0);
  assert.equal(clears, 1);
});
