// @vitest-environment happy-dom

import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { computed, effectScope, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { ModbusRegister } from '@/types/modbus.ts';
import type { PortConfig } from '@/types/serial.ts';

const mocked = vi.hoisted(() => ({
  master: undefined as unknown,
  masterOptions: undefined as unknown,
  message: {
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('naive-ui', () => ({ useMessage: () => mocked.message }));
vi.mock('@/features/sessions/application/use-modbus-master.ts', () => ({
  useModbusMaster: (options: unknown) => {
    mocked.masterOptions = options;
    return mocked.master;
  },
}));

import { useSessionModbus } from '@/features/sessions/application/use-session-modbus.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';

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

interface FakeMaster {
  readAll: ReturnType<typeof vi.fn>;
  readOnce: ReturnType<typeof vi.fn>;
  sendAll: ReturnType<typeof vi.fn>;
  sendRow: ReturnType<typeof vi.fn>;
  startReplay: ReturnType<typeof vi.fn>;
  stopReplay: ReturnType<typeof vi.fn>;
  loadWriteSource: ReturnType<typeof vi.fn>;
  clearWriteSource: ReturnType<typeof vi.fn>;
}

interface MasterOptions {
  onSamples?: (samples: Array<{ channel: number | null; value: number; ts: number }>) => void;
  onStatus?: (status: { kind: string; [key: string]: unknown }) => void;
}

function makeMaster(): FakeMaster {
  return {
    readAll: vi.fn(async () => undefined),
    readOnce: vi.fn(async () => 7),
    sendAll: vi.fn(async () => ({ sent: 2, ok: 1 })),
    sendRow: vi.fn(async () => true),
    startReplay: vi.fn(),
    stopReplay: vi.fn(),
    loadWriteSource: vi.fn(),
    clearWriteSource: vi.fn(),
  };
}

function setup() {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const id = store.createSession('COM1', config);
  const waveformSamples: Array<readonly { channel: number; value: number; timestamp?: number }[]> =
    [];
  const waveformRef = ref<{
    pushRegisterSample: (channel: number, value: number, timestamp?: number) => void;
    pushRegisterSamples: (
      samples: readonly { channel: number; value: number; timestamp?: number }[],
    ) => void;
  } | null>({
    pushRegisterSample: vi.fn(),
    pushRegisterSamples: vi.fn((samples) => waveformSamples.push(samples)),
  });
  const showWaveform = vi.fn();
  const master = makeMaster();
  mocked.master = master;
  const scope = effectScope();
  const api = scope.run(() =>
    useSessionModbus({
      session: computed(() => store.sessions[0]),
      sendBytes: async (payload) => ({
        outcome: 'complete',
        requestedBytes: payload.length,
        sentBytes: payload.length,
      }),
      rawBytes: () => () => undefined,
      isConnected: ref(true),
      waveformRef,
      showWaveform,
      notifications: mocked.message,
    }),
  );
  assert.ok(api);
  return { api, id, master, scope, showWaveform, store, waveformRef, waveformSamples };
}

function addRegister(
  store: ReturnType<typeof useSessionStore>,
  sessionId: string,
  patch: Partial<ModbusRegister> = {},
): ModbusRegister {
  const id = store.addModbusRegister(sessionId, {
    name: patch.name ?? 'Register',
    slaveAddress: patch.slaveAddress ?? 1,
    functionCode: patch.functionCode ?? 0x03,
    address: patch.address ?? 0,
    quantity: patch.quantity ?? 1,
    type: patch.type ?? 'uint16',
    waveformChannel: patch.waveformChannel ?? null,
    periodicRead: patch.periodicRead ?? true,
    periodicWrite: patch.periodicWrite ?? false,
  });
  assert.ok(id);
  return store.sessions[0].modbusRegisters.find((item) => item.id === id)!;
}

beforeEach(() => {
  mocked.message.success.mockReset();
  mocked.message.warning.mockReset();
  mocked.masterOptions = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('session Modbus bridge routes samples, status, commands, and waveform assignments', async () => {
  const { api, id, master, scope, showWaveform, store, waveformRef, waveformSamples } = setup();
  const register = addRegister(store, id, { name: 'Voltage' });
  const options = mocked.masterOptions as MasterOptions;

  store.setWaveformSourceMode(id, 'register');
  options.onSamples?.([
    { channel: null, value: 1, ts: 10 },
    { channel: 2, value: 12.5, ts: 11 },
  ]);
  assert.deepEqual(waveformSamples, [[{ channel: 2, value: 12.5, timestamp: 11 }]]);

  store.setWaveformSourceMode(id, 'text');
  options.onSamples?.([{ channel: 3, value: 99, ts: 12 }]);
  assert.equal(waveformSamples.length, 1, 'text waveform mode ignores register samples');
  waveformRef.value = null;
  store.setWaveformSourceMode(id, 'register');
  options.onSamples?.([{ channel: 3, value: 99, ts: 12 }]);

  options.onStatus?.({
    kind: 'backoff',
    scope: 'write',
    delayMs: 50,
    consecutiveFailures: 2,
    key: '1:6:0',
  });
  assert.equal(api.modbusStatusClass.value, 'backoff');
  assert.ok(api.modbusStatusText.value.length > 0);

  store.setWaveformSourceMode(id, 'text');
  api.toggleWaveformSourceMode();
  assert.equal(store.sessions[0].waveformSourceMode, 'register');
  api.toggleWaveformSourceMode();
  assert.equal(store.sessions[0].waveformSourceMode, 'text');

  await api.readAll();
  await api.readRow(register);
  await api.sendAll();
  master.sendAll.mockResolvedValueOnce({ sent: 0, ok: 0 });
  await api.sendAll();
  assert.equal(await api.sendRow(register), true);
  assert.equal(api.modbusBusy.value, false);
  assert.equal(master.readAll.mock.calls.length, 1);
  assert.equal(master.readOnce.mock.calls.length, 1);
  assert.equal(master.sendAll.mock.calls.length, 2);
  assert.equal(master.sendRow.mock.calls.length, 1);
  assert.equal(mocked.message.success.mock.calls.length, 1);
  assert.equal(api.waveformChannelLabels.value[0], undefined);

  api.startReplay([]);
  api.stopReplay();
  assert.equal(master.startReplay.mock.calls.length, 1);
  assert.equal(master.stopReplay.mock.calls.length, 1);

  const input = { click: vi.fn() } as unknown as HTMLInputElement;
  api.writeSourceInput.value = input;
  api.pickWriteSource();
  assert.equal(input.click.mock.calls.length, 1);

  api.loadWriteSource(
    [{ t: 1, slave: 1, fc: 3, addr: 0, type: 'uint16', value: 5 }],
    'source.bbreg',
  );
  assert.equal(api.writeSourceName.value, 'source.bbreg');
  api.clearWriteSource();
  assert.equal(api.writeSourceName.value, null);
  assert.equal(master.loadWriteSource.mock.calls.length, 1);
  assert.equal(master.clearWriteSource.mock.calls.length, 1);

  api.plotInWaveform(register);
  const updated = store.sessions[0].modbusRegisters.find((item) => item.id === register.id)!;
  assert.equal(updated.waveformChannel, 0);
  assert.equal(store.sessions[0].waveformSourceMode, 'register');
  assert.equal(showWaveform.mock.calls.length, 1);

  api.plotInWaveform(updated);
  assert.equal(showWaveform.mock.calls.length, 2, 'existing channel remains selectable');
  scope.stop();
});

test('session Modbus bridge clears busy state on failure and handles file-selection edge cases', async () => {
  const { api, id, master, scope, showWaveform, store } = setup();
  const register = addRegister(store, id);
  master.readAll.mockRejectedValueOnce(new Error('read failed'));
  await assert.rejects(api.readAll(), /read failed/);
  assert.equal(api.modbusBusy.value, false);

  master.sendRow.mockRejectedValueOnce(new Error('write failed'));
  await assert.rejects(api.sendRow(register), /write failed/);
  assert.equal(api.modbusBusy.value, false);

  api.onWriteSourcePicked({ target: {} } as unknown as Event);

  const originalReader = globalThis.FileReader;
  class FakeFileReader {
    static text: string | null = '';
    result: string | null = FakeFileReader.text;
    onload: (() => void) | null = null;
    readAsText(): void {
      this.onload?.();
    }
  }
  globalThis.FileReader = FakeFileReader as unknown as typeof FileReader;
  try {
    const input = {
      files: [{ name: 'empty.bbreg' }],
      value: 'selected',
    } as unknown as HTMLInputElement;
    api.onWriteSourcePicked({ target: input } as unknown as Event);
    assert.equal(input.value, '');
    assert.equal(mocked.message.warning.mock.calls.length, 1);

    FakeFileReader.text = null;
    api.onWriteSourcePicked({
      target: { files: [{ name: 'null.bbreg' }], value: 'selected' },
    } as unknown as Event);
    assert.equal(mocked.message.warning.mock.calls.length, 2);

    FakeFileReader.text = '{"t":1,"slave":1,"fc":3,"addr":0,"type":"uint16","value":9}';
    api.onWriteSourcePicked({
      target: { files: [{ name: 'loaded.bbreg' }], value: 'selected' },
    } as unknown as Event);
    assert.equal(master.loadWriteSource.mock.calls.length, 1);
  } finally {
    globalThis.FileReader = originalReader;
  }

  for (let channel = 0; channel < 8; channel += 1) {
    addRegister(store, id, { waveformChannel: channel, address: channel + 1 });
  }
  const unassigned = addRegister(store, id, { address: 99 });
  api.plotInWaveform(unassigned);
  assert.equal(showWaveform.mock.calls.length, 0, 'all waveform channels reject a new assignment');
  scope.stop();
});
