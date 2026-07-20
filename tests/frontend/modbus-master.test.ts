import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { computed, effectScope, ref, type EffectScope } from 'vue';
import { useModbusMaster, type ModbusMasterStatus } from '../../src/composables/useModbusMaster.ts';
import { frameRequest, readRequest, writeSingleRegisterRequest } from '../../src/lib/modbus';
import { useSessionStore } from '../../src/stores/sessions.ts';
import type {
  ModbusFunctionCode,
  ModbusMasterConfig,
  ModbusRegister,
  ModbusValueType,
  PortConfig,
} from '../../src/types/index.ts';

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

interface Harness {
  store: ReturnType<typeof useSessionStore>;
  sessionId: string;
  master: ReturnType<typeof useModbusMaster>;
  sent: Uint8Array[];
  statuses: ModbusMasterStatus[];
  scope: EffectScope;
  emitRx: (bytes: Uint8Array) => void;
  setConnected: (connected: boolean) => void;
  listenerCount: () => number;
  unlistenCount: () => number;
}

type SendHandler = (
  payload: Uint8Array,
  reply: (bytes: Uint8Array) => void,
  index: number,
) => Promise<boolean> | boolean;

function createHarness(
  handler: SendHandler,
  configPatch: Partial<ModbusMasterConfig> = {},
): Harness {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM1', cfg);
  store.setModbusConfig(sessionId, { enabled: false, timeoutMs: 80, ...configPatch });

  let rx: ((bytes: Uint8Array) => void) | null = null;
  let listens = 0;
  let unlistens = 0;
  const sent: Uint8Array[] = [];
  const statuses: ModbusMasterStatus[] = [];
  const isConnected = ref(true);

  const scope = effectScope();
  let master: ReturnType<typeof useModbusMaster> | null = null;
  scope.run(() => {
    master = useModbusMaster({
      sessionId,
      config: computed(() => store.sessions[0].modbusConfig),
      registers: computed(() => store.sessions[0].modbusRegisters),
      sendBytes(payload, options) {
        const index = sent.length;
        sent.push(payload);
        options?.onWriteStarted?.();
        return Promise.resolve(handler(payload, (bytes) => rx?.(bytes), index)).then((ok) =>
          ok
            ? {
                status: 'complete' as const,
                ok: true as const,
                requestedBytes: payload.length,
                confirmedBytes: payload.length,
                bytesWritten: payload.length,
                reason: null,
              }
            : {
                status: 'partial-unknown' as const,
                ok: false as const,
                requestedBytes: payload.length,
                confirmedBytes: 0,
                bytesWritten: 0,
                reason: 'write-error' as const,
                code: 'SERIAL_PARTIAL_WRITE' as const,
              },
        );
      },
      rawBytes(cb) {
        listens += 1;
        rx = cb;
        return () => {
          unlistens += 1;
          if (rx === cb) rx = null;
        };
      },
      isConnected,
      onStatus(status) {
        statuses.push(status);
      },
    });
  });

  assert.ok(master);
  return {
    store,
    sessionId,
    master,
    sent,
    statuses,
    scope,
    emitRx: (bytes) => rx?.(bytes),
    setConnected: (connected) => {
      isConnected.value = connected;
    },
    listenerCount: () => listens,
    unlistenCount: () => unlistens,
  };
}

function addRegister(
  h: Harness,
  patch: {
    id?: string;
    name?: string;
    slaveAddress?: number;
    fc?: ModbusFunctionCode;
    address?: number;
    type?: ModbusValueType;
    value?: number | null;
    waveformChannel?: number | null;
    periodicRead?: boolean;
    periodicWrite?: boolean;
  },
): ModbusRegister {
  const id = h.store.addModbusRegister(h.sessionId, {
    name: patch.name ?? patch.id ?? 'Register',
    slaveAddress: patch.slaveAddress ?? 1,
    functionCode: patch.fc ?? 0x03,
    address: patch.address ?? 0,
    quantity: 1,
    type: patch.type ?? 'uint16',
    waveformChannel: patch.waveformChannel ?? null,
    periodicRead: patch.periodicRead ?? true,
    periodicWrite: patch.periodicWrite ?? false,
  });
  assert.ok(id);
  if (patch.value !== undefined) {
    h.store.updateModbusRegister(h.sessionId, id, {
      value: patch.value,
      valueTs: patch.value === null ? null : 1,
    });
  }
  return h.store.sessions[0].modbusRegisters.find((reg) => reg.id === id)!;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function rtuReadRegs(slave: number, fc: number, regs: number[]): Uint8Array {
  const pdu = new Uint8Array(2 + regs.length * 2);
  pdu[0] = fc;
  pdu[1] = regs.length * 2;
  regs.forEach((value, i) => {
    pdu[2 + i * 2] = (value >>> 8) & 0xff;
    pdu[2 + i * 2 + 1] = value & 0xff;
  });
  return frameRequest('rtu', slave, pdu);
}

function rtuWriteSingleAck(slave: number, addr: number, value: number): Uint8Array {
  return frameRequest(
    'rtu',
    slave,
    new Uint8Array([0x06, (addr >>> 8) & 0xff, addr & 0xff, (value >>> 8) & 0xff, value & 0xff]),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = Symbol('timeout');
  const result = await Promise.race([promise, delay(ms).then(() => timeout)]);
  assert.notEqual(result, timeout, `promise did not resolve within ${ms}ms`);
  return result as T;
}

async function waitFor(predicate: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), message);
}

test('readOnce sends an RTU read request and updates the target register', async () => {
  const h = createHarness((payload, reply) => {
    assert.equal(hex(payload), hex(readRequest('rtu', 1, 0x03, 100, 1)));
    reply(rtuReadRegs(1, 0x03, [42]));
    return true;
  });
  try {
    const reg = addRegister(h, { id: 'temp', address: 100 });
    const value = await h.master.readOnce(reg);
    assert.equal(value, 42);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 42);
    assert.equal(h.listenerCount(), 1);
  } finally {
    h.scope.stop();
  }
  assert.equal(h.unlistenCount(), 1);
});

test('readAll batches contiguous read rows and emits waveform samples', async () => {
  const samples: Array<{ registerId: string; channel: number | null; value: number }> = [];
  const h = createHarness((payload, reply) => {
    assert.equal(hex(payload), hex(readRequest('rtu', 1, 0x03, 10, 2)));
    reply(rtuReadRegs(1, 0x03, [10, 11]));
    return true;
  });
  h.master.setOnSamples((batch) => {
    samples.push(
      ...batch.map((sample) => ({
        registerId: sample.registerId,
        channel: sample.channel,
        value: sample.value,
      })),
    );
  });

  try {
    addRegister(h, { id: 'a', address: 10, waveformChannel: 0 });
    addRegister(h, { id: 'b', address: 11, waveformChannel: 1 });
    await h.master.readAll();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(
      h.store.sessions[0].modbusRegisters.map((reg) => reg.value),
      [10, 11],
    );
    assert.deepEqual(
      samples.map((sample) => [sample.channel, sample.value]),
      [
        [0, 10],
        [1, 11],
      ],
    );
    assert.deepEqual(
      h.statuses.map((status) => status.kind),
      ['polling', 'idle'],
    );
  } finally {
    h.scope.stop();
  }
});

test('sendRow writes FC06 values and accepts a matching acknowledgement', async () => {
  const h = createHarness((payload, reply) => {
    assert.equal(hex(payload), hex(writeSingleRegisterRequest('rtu', 1, 5, 0x1234)));
    reply(rtuWriteSingleAck(1, 5, 0x1234));
    return true;
  });

  try {
    const reg = addRegister(h, {
      id: 'setpoint',
      fc: 0x06,
      address: 5,
      value: 0x1234,
      periodicRead: false,
    });
    assert.equal(await h.master.sendRow(reg), true);
    assert.equal(h.sent.length, 1);
  } finally {
    h.scope.stop();
  }
});

test('PDU exception responses surface as exception status without waiting for timeout', async () => {
  const h = createHarness(
    (payload, reply) => {
      assert.equal(hex(payload), '03 00 00 00 01');
      reply(new Uint8Array([0x83, 0x02]));
      return true;
    },
    { transport: 'pdu', timeoutMs: 200 },
  );

  try {
    const reg = addRegister(h, { id: 'pdu', address: 0 });
    const value = await h.master.readOnce(reg);
    assert.equal(value, null);
    assert.deepEqual(h.statuses.at(-1), { kind: 'exception', code: 0x02 });
  } finally {
    h.scope.stop();
  }
});

test('send failures clear the pending transaction and emit error status', async () => {
  const h = createHarness(() => {
    throw new Error('port closed');
  });

  try {
    const reg = addRegister(h, { id: 'fail', address: 1 });
    const value = await h.master.readOnce(reg);
    assert.equal(value, null);
    assert.deepEqual(h.statuses.at(-1), { kind: 'error', message: 'port closed' });
  } finally {
    h.scope.stop();
  }
});

test('readOnce timeout clears pending state and emits timeout status', async () => {
  const h = createHarness(() => true, { timeoutMs: 20 });
  try {
    const reg = addRegister(h, { id: 'timeout', address: 3 });
    assert.equal(await h.master.readOnce(reg), null);
    assert.deepEqual(h.statuses.at(-1), { kind: 'timeout' });
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, null);
  } finally {
    h.scope.stop();
  }
});

test('concurrent on-demand reads are serialized onto one outstanding request', async () => {
  const h = createHarness(() => true, { timeoutMs: 500 });
  try {
    const firstReg = addRegister(h, { id: 'first', address: 1 });
    const secondReg = addRegister(h, { id: 'second', address: 2 });

    const first = h.master.readOnce(firstReg);
    const second = h.master.readOnce(secondReg);
    await delay(20);
    assert.equal(h.sent.length, 1, 'second request waits while the bus is busy');

    h.emitRx(rtuReadRegs(1, 0x03, [100]));
    assert.equal(await first, 100);

    await delay(20);
    assert.equal(h.sent.length, 2, 'second request starts after the first resolves');
    h.emitRx(rtuReadRegs(1, 0x03, [200]));
    assert.equal(await second, 200);
    assert.deepEqual(
      h.store.sessions[0].modbusRegisters.map((reg) => reg.value),
      [100, 200],
    );
  } finally {
    h.scope.stop();
  }
});

test('periodic write source advances rows on the write loop cadence', async () => {
  const h = createHarness(
    (payload, reply) => {
      assert.equal(hex(payload), hex(writeSingleRegisterRequest('rtu', 1, 5, 77)));
      reply(rtuWriteSingleAck(1, 5, 77));
      return true;
    },
    { enabled: true, writeIntervalMs: 100 },
  );

  try {
    addRegister(h, {
      id: 'periodic-write',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 }],
      'setpoints.bbreg',
    );
    h.master.start();

    await delay(140);
    h.master.stop();

    assert.equal(h.sent.length, 1);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 77);
    assert.equal(h.master.writing.value, false);
    assert.equal(h.master.getWriteSourceName(), 'setpoints.bbreg');
    assert.ok(h.statuses.some((status) => status.kind === 'writing'));
  } finally {
    h.scope.stop();
  }
});

test('stop resolves an in-flight transaction and releases the RX listener', async () => {
  const h = createHarness(() => true, { timeoutMs: 1000 });

  try {
    const reg = addRegister(h, { id: 'pending-stop', address: 9 });
    const pending = h.master.readOnce(reg);
    await delay(20);
    assert.equal(h.sent.length, 1);

    h.master.stop();

    assert.equal(await resolvesWithin(pending, 80), null);
    assert.equal(h.master.status.value.kind, 'idle');
    assert.equal(h.unlistenCount(), 1);
  } finally {
    h.scope.stop();
  }
});

test('connection loss cancels a pending transaction immediately', async () => {
  const h = createHarness(() => true, { timeoutMs: 1000 });

  try {
    const reg = addRegister(h, { id: 'disconnect-read', address: 7 });
    const pending = h.master.readOnce(reg);
    await delay(20);
    assert.equal(h.sent.length, 1);

    h.setConnected(false);

    assert.equal(await resolvesWithin(pending, 80), null);
    assert.deepEqual(h.statuses.at(-1), { kind: 'error', message: 'connection closed' });
    assert.equal(h.unlistenCount(), 1);
  } finally {
    h.scope.stop();
  }
});

test('periodic read loop resumes after an on-demand operation holds the bus', async () => {
  let releaseManual: ((bytes: Uint8Array) => void) | null = null;
  const h = createHarness(
    (_payload, reply, index) => {
      if (index === 0) {
        releaseManual = reply;
        return true;
      }
      reply(rtuReadRegs(1, 0x03, [200 + index]));
      return true;
    },
    { enabled: true, pollIntervalMs: 100, timeoutMs: 1000 },
  );

  try {
    const reg = addRegister(h, { id: 'periodic-after-busy', address: 4 });
    h.master.start();

    const manual = h.master.readOnce(reg);
    await delay(140);
    assert.equal(h.sent.length, 1, 'poll timer must not send while the manual read is pending');

    assert.ok(releaseManual);
    releaseManual(rtuReadRegs(1, 0x03, [123]));
    assert.equal(await resolvesWithin(manual, 80), 123);

    await waitFor(() => h.sent.length >= 2, 80, 'poll loop should re-arm after busy resolves');
    assert.equal(h.sent.length, 2);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 201);
  } finally {
    h.scope.stop();
  }
});

test('replay skips a timed-out record and continues with the next value', async () => {
  const h = createHarness(
    (_payload, reply, index) => {
      if (index > 0) reply(rtuWriteSingleAck(1, 5, 88));
      return true;
    },
    { timeoutMs: 20 },
  );

  try {
    addRegister(h, {
      id: 'replay-timeout',
      fc: 0x06,
      address: 5,
      periodicRead: false,
    });

    h.master.startReplay([
      { t: 0, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 },
      { t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 88 },
    ]);

    await delay(90);

    assert.equal(h.sent.length, 2);
    assert.equal(h.master.replaying.value, false);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 88);
    assert.ok(h.statuses.some((status) => status.kind === 'timeout'));
    assert.equal(h.statuses.at(-1)?.kind, 'idle');
  } finally {
    h.scope.stop();
  }
});

test('stopReplay cancels queued replay records after the current acknowledgement', async () => {
  const h = createHarness((_payload, reply) => {
    reply(rtuWriteSingleAck(1, 5, 11));
    return true;
  });

  try {
    addRegister(h, {
      id: 'replay-stop',
      fc: 0x06,
      address: 5,
      periodicRead: false,
    });

    h.master.startReplay([
      { t: 0, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 11 },
      { t: 80, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 12 },
    ]);

    await delay(30);
    assert.equal(h.sent.length, 1);

    h.master.stopReplay();
    await delay(100);

    assert.equal(h.sent.length, 1);
    assert.equal(h.master.replaying.value, false);
  } finally {
    h.scope.stop();
  }
});

test('connection loss stops replay and cancels queued replay records', async () => {
  const h = createHarness(() => true, { timeoutMs: 1000 });

  try {
    addRegister(h, {
      id: 'replay-disconnect',
      fc: 0x06,
      address: 5,
      periodicRead: false,
    });

    h.master.startReplay([
      { t: 0, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 21 },
      { t: 40, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 22 },
    ]);

    await delay(20);
    assert.equal(h.sent.length, 1);
    assert.equal(h.master.replaying.value, true);

    h.setConnected(false);
    await delay(80);

    assert.equal(h.sent.length, 1);
    assert.equal(h.master.replaying.value, false);
    assert.deepEqual(h.statuses.at(-1), { kind: 'error', message: 'connection closed' });
  } finally {
    h.scope.stop();
  }
});

test('starting a new replay replaces queued records from an in-flight replay', async () => {
  let releaseOld: (() => void) | null = null;
  const h = createHarness(
    (_payload, reply, index) => {
      if (index === 0) {
        releaseOld = () => reply(rtuWriteSingleAck(1, 5, 11));
        return true;
      }
      reply(rtuWriteSingleAck(1, 5, 99));
      return true;
    },
    { timeoutMs: 1000 },
  );

  try {
    addRegister(h, {
      id: 'replay-restart',
      fc: 0x06,
      address: 5,
      periodicRead: false,
    });

    h.master.startReplay([
      { t: 0, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 11 },
      { t: 20, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 12 },
    ]);

    await waitFor(() => h.sent.length === 1, 80, 'first replay should send one write');

    h.master.startReplay([{ t: 0, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 99 }]);
    await delay(30);

    assert.equal(h.sent.length, 1, 'replacement replay waits for the current write to finish');
    assert.ok(releaseOld);
    releaseOld();

    await waitFor(() => h.sent.length === 2, 120, 'replacement replay should send after ack');
    assert.equal(hex(h.sent[1]), hex(writeSingleRegisterRequest('rtu', 1, 5, 99)));

    await delay(80);
    assert.equal(h.sent.length, 2, 'old queued replay record must not be sent');
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 99);
    assert.equal(h.master.replaying.value, false);
  } finally {
    h.scope.stop();
  }
});

test('periodic read loop pauses while disconnected and resumes once after reconnect', async () => {
  const h = createHarness(
    (_payload, reply, index) => {
      reply(rtuReadRegs(1, 0x03, [10 + index]));
      return true;
    },
    { enabled: true, pollIntervalMs: 100, timeoutMs: 500 },
  );

  try {
    addRegister(h, { id: 'read-reconnect', address: 2 });
    h.master.start();

    await delay(140);
    assert.equal(h.sent.length, 1);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 10);

    h.setConnected(false);
    await delay(140);

    assert.equal(h.sent.length, 1, 'periodic reads must pause while disconnected');
    assert.equal(h.unlistenCount(), 1);

    h.setConnected(true);
    await delay(140);

    assert.equal(h.sent.length, 2, 'periodic reads should resume after reconnect');
    assert.equal(h.listenerCount(), 2);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 11);
  } finally {
    h.scope.stop();
  }
});

test('periodic write loop pauses while disconnected and resumes its cursor after reconnect', async () => {
  const h = createHarness(
    (_payload, reply, index) => {
      const value = index === 0 ? 77 : 88;
      reply(rtuWriteSingleAck(1, 5, value));
      return true;
    },
    { enabled: true, writeIntervalMs: 100, timeoutMs: 500 },
  );

  try {
    addRegister(h, {
      id: 'write-reconnect',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [
        { t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 },
        { t: 2, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 88 },
      ],
      'setpoints.bbreg',
    );
    h.master.start();

    await delay(140);
    assert.equal(h.sent.length, 1);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 77);

    h.setConnected(false);
    await delay(140);

    assert.equal(h.sent.length, 1, 'periodic writes must pause while disconnected');
    assert.equal(h.unlistenCount(), 1);

    h.setConnected(true);
    await delay(140);

    assert.equal(h.sent.length, 2, 'periodic writes should resume after reconnect');
    assert.equal(h.listenerCount(), 2);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 88);
    assert.equal(h.master.writing.value, false);
  } finally {
    h.scope.stop();
  }
});

test('periodic read and write loops share the bus without starving either loop', async () => {
  let releaseFirst: (() => void) | null = null;
  const seenFunctionCodes: number[] = [];
  const h = createHarness(
    (payload, reply, index) => {
      const fc = payload[1];
      seenFunctionCodes.push(fc);
      const respond = () => {
        if (fc === 0x03) reply(rtuReadRegs(1, 0x03, [100 + index]));
        else if (fc === 0x06) reply(rtuWriteSingleAck(1, 5, index === 0 ? 77 : 88));
        else assert.fail(`unexpected FC ${fc}`);
      };
      if (index === 0) {
        releaseFirst = respond;
        return true;
      }
      respond();
      return true;
    },
    { enabled: true, pollIntervalMs: 100, writeIntervalMs: 100, timeoutMs: 1000 },
  );

  try {
    addRegister(h, { id: 'read-and-write-read', address: 2 });
    addRegister(h, {
      id: 'read-and-write-write',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 }],
      'setpoints.bbreg',
    );
    h.master.start();

    await delay(140);
    assert.equal(h.sent.length, 1, 'only one transaction should be outstanding');

    await delay(140);
    assert.equal(
      h.sent.length,
      1,
      'the other loop must wait while the first transaction is pending',
    );

    assert.ok(releaseFirst);
    releaseFirst();

    await waitFor(
      () => seenFunctionCodes.includes(0x03) && seenFunctionCodes.includes(0x06),
      350,
      `expected read and write loops to both send, saw FCs: ${seenFunctionCodes.join(', ')}`,
    );
  } finally {
    h.scope.stop();
  }
});

test('periodic write due during a slow read runs before the next read interval', async () => {
  const readReplies: Array<() => void> = [];
  const seenFunctionCodes: number[] = [];
  const h = createHarness(
    (payload, reply, index) => {
      const fc = payload[1];
      seenFunctionCodes.push(fc);
      if (fc === 0x03) {
        readReplies.push(() => reply(rtuReadRegs(1, 0x03, [100 + index])));
      } else if (fc === 0x06) {
        reply(rtuWriteSingleAck(1, 5, 77));
      } else {
        assert.fail(`unexpected FC ${fc}`);
      }
      return true;
    },
    { enabled: true, pollIntervalMs: 100, writeIntervalMs: 100, timeoutMs: 1000 },
  );

  try {
    addRegister(h, { id: 'slow-read', address: 2 });
    addRegister(h, {
      id: 'overdue-write',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 }],
      'setpoints.bbreg',
    );
    h.master.start();

    await delay(140);
    assert.deepEqual(seenFunctionCodes, [0x03]);

    await delay(140);
    assert.equal(h.sent.length, 1, 'write timer should not send while read is pending');

    readReplies.shift()?.();

    await waitFor(() => h.sent.length >= 2, 80, 'overdue write did not run after read resolved');
    assert.equal(seenFunctionCodes[1], 0x06);
  } finally {
    h.scope.stop();
  }
});

test('periodic read loop backs off after consecutive timeouts and resets after a response', async () => {
  const sentAt: number[] = [];
  const h = createHarness(
    (_payload, reply, index) => {
      sentAt[index] = Date.now();
      if (index >= 2) reply(rtuReadRegs(1, 0x03, [300 + index]));
      return true;
    },
    { enabled: true, pollIntervalMs: 100, timeoutMs: 20 },
  );

  try {
    addRegister(h, { id: 'read-backoff', address: 2 });
    h.master.start();

    await waitFor(
      () => h.statuses.some((status) => status.kind === 'backoff'),
      400,
      'read loop should enter backoff after consecutive timeouts',
    );

    const backoff = h.statuses.find((status) => status.kind === 'backoff');
    if (!backoff || backoff.kind !== 'backoff') assert.fail('missing backoff status');
    assert.equal(backoff.scope, 'read');
    assert.equal(backoff.consecutiveFailures, 2);
    assert.equal(backoff.delayMs, 200);

    await waitFor(() => h.sent.length >= 4, 900, 'read loop should recover after a response');
    assert.ok(
      sentAt[2] - sentAt[1] >= 180,
      `expected backed-off gap after second timeout, got ${sentAt[2] - sentAt[1]}ms`,
    );
    assert.ok(
      sentAt[3] - sentAt[2] < 180,
      `expected normal cadence after success, got ${sentAt[3] - sentAt[2]}ms`,
    );
    assert.notEqual(h.store.sessions[0].modbusRegisters[0].value, null);
  } finally {
    h.scope.stop();
  }
});

test('periodic read backoff skips only the failing batch while healthy slaves continue', async () => {
  const seenSlaves: number[] = [];
  const h = createHarness(
    (payload, reply) => {
      const slave = payload[0];
      seenSlaves.push(slave);
      if (slave === 2) reply(rtuReadRegs(2, 0x03, [200 + seenSlaves.length]));
      return true;
    },
    { enabled: true, pollIntervalMs: 100, timeoutMs: 20 },
  );

  try {
    addRegister(h, { id: 'offline-slave', slaveAddress: 1, address: 2 });
    addRegister(h, { id: 'healthy-slave', slaveAddress: 2, address: 2 });
    h.master.start();

    await waitFor(
      () => h.statuses.some((status) => status.kind === 'backoff'),
      500,
      'offline slave should enter keyed backoff after consecutive timeouts',
    );

    const offlineAttemptsAtBackoff = seenSlaves.filter((slave) => slave === 1).length;
    const healthyAttemptsAtBackoff = seenSlaves.filter((slave) => slave === 2).length;

    await waitFor(
      () => seenSlaves.filter((slave) => slave === 2).length > healthyAttemptsAtBackoff,
      180,
      'healthy slave should continue while offline slave is cooling down',
    );

    assert.equal(
      seenSlaves.filter((slave) => slave === 1).length,
      offlineAttemptsAtBackoff,
      'offline slave should be skipped during its keyed cooldown',
    );
    assert.notEqual(h.store.sessions[0].modbusRegisters[1].value, null);
  } finally {
    h.scope.stop();
  }
});

test('periodic write loop backs off after consecutive send failures', async () => {
  const sentAt: number[] = [];
  const h = createHarness(
    (_payload, _reply, index) => {
      sentAt[index] = Date.now();
      return false;
    },
    { enabled: true, writeIntervalMs: 100, timeoutMs: 500 },
  );

  try {
    addRegister(h, {
      id: 'write-backoff',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 77 }],
      'setpoints.bbreg',
    );
    h.master.start();

    await waitFor(
      () => h.statuses.some((status) => status.kind === 'backoff'),
      400,
      'write loop should enter backoff after consecutive send failures',
    );

    const backoff = h.statuses.find((status) => status.kind === 'backoff');
    if (!backoff || backoff.kind !== 'backoff') assert.fail('missing backoff status');
    assert.equal(backoff.scope, 'write');
    assert.equal(backoff.consecutiveFailures, 2);
    assert.equal(backoff.delayMs, 200);

    await waitFor(() => h.sent.length >= 3, 700, 'write loop should keep retrying slowly');
    assert.ok(
      sentAt[2] - sentAt[1] >= 180,
      `expected backed-off write gap, got ${sentAt[2] - sentAt[1]}ms`,
    );
  } finally {
    h.scope.stop();
  }
});

test('reconnect uses register and transport changes made while disconnected', async () => {
  const h = createHarness(
    (payload, reply, index) => {
      if (index === 0) {
        assert.equal(hex(payload), hex(readRequest('rtu', 1, 0x03, 2, 1)));
        reply(rtuReadRegs(1, 0x03, [21]));
      } else {
        assert.equal(hex(payload), '03 00 09 00 01');
        reply(new Uint8Array([0x03, 0x02, 0x00, 0x63]));
      }
      return true;
    },
    { enabled: true, pollIntervalMs: 100, timeoutMs: 500 },
  );

  try {
    const oldReg = addRegister(h, { id: 'old-rtu-read', address: 2 });
    h.master.start();

    await delay(140);
    assert.equal(h.sent.length, 1);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, 21);

    h.setConnected(false);
    h.store.updateModbusRegister(h.sessionId, oldReg.id, { periodicRead: false });
    addRegister(h, { id: 'new-pdu-read', address: 9 });
    h.store.setModbusConfig(h.sessionId, { transport: 'pdu' });
    await delay(140);

    assert.equal(h.sent.length, 1, 'no requests should be sent while disconnected');

    h.setConnected(true);
    await delay(140);

    assert.equal(h.sent.length, 2);
    assert.equal(h.listenerCount(), 2);
    assert.deepEqual(
      h.store.sessions[0].modbusRegisters.map((reg) => reg.value),
      [21, 99],
    );
  } finally {
    h.scope.stop();
  }
});

test('imperative Modbus no-op paths leave the half-duplex runtime idle and bounded', async () => {
  const h = createHarness(() => true);
  try {
    const read = addRegister(h, {
      id: 'read-only',
      fc: 0x03,
      periodicRead: false,
    });
    const write = addRegister(h, {
      id: 'write-only',
      fc: 0x06,
      periodicRead: false,
      periodicWrite: false,
    });

    assert.equal(await h.master.readOnce(write), null);
    assert.equal(await h.master.sendRow(read), false);
    await h.master.readAll();
    assert.deepEqual(await h.master.sendAll(), { sent: 0, ok: 0 });
    assert.equal(h.sent.length, 0);

    h.master.clearWriteSource();
    h.master.startReplay([]);
    assert.equal(h.master.replaying.value, false);

    h.master.start();
    h.master.start();
    assert.equal(h.master.running.value, true);
    h.master.stop();
    assert.equal(h.master.running.value, false);
  } finally {
    h.scope.stop();
  }
});

test('periodic batches relay protocol exceptions through the batch-status sink', async () => {
  vi.useFakeTimers();
  let h: Harness | null = null;
  try {
    h = createHarness(
      (_payload, reply) => {
        reply(frameRequest('rtu', 1, new Uint8Array([0x83, 0x02])));
        return true;
      },
      { enabled: true, pollIntervalMs: 100, timeoutMs: 500 },
    );
    addRegister(h, { id: 'periodic-exception', address: 0 });
    h.master.start();
    await vi.advanceTimersByTimeAsync(100);
    assert.deepEqual(
      h.statuses.find((status) => status.kind === 'exception'),
      { kind: 'exception', code: 0x02 },
    );
  } finally {
    h?.scope.stop();
    vi.useRealTimers();
  }
});

test('a read response with a valid but incompatible shape does not mutate a register', async () => {
  let request = 0;
  const h = createHarness((_payload, reply) => {
    request += 1;
    if (request === 1) {
      reply(frameRequest('rtu', 1, new Uint8Array([0x83, 0x02])));
    } else {
      // This is a valid RTU write acknowledgement, but not a readable payload
      // for the outstanding FC03 row. It must produce no value update.
      reply(rtuWriteSingleAck(1, 0, 1));
    }
    return true;
  });

  try {
    const reg = addRegister(h, { id: 'shape-check', address: 0 });
    assert.equal(await h.master.readOnce(reg), null);
    assert.deepEqual(h.statuses.at(-1), { kind: 'exception', code: 0x02 });

    assert.equal(await h.master.readOnce(reg), null);
    assert.equal(h.store.sessions[0].modbusRegisters[0].value, null);
  } finally {
    h.scope.stop();
  }
});

test('an empty periodic write source returns writing state to idle without transmitting', async () => {
  vi.useFakeTimers();
  let h: Harness | null = null;
  try {
    h = createHarness(() => true, { enabled: true, writeIntervalMs: 100 });
    addRegister(h, {
      id: 'empty-write-source',
      fc: 0x06,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.status.value = { kind: 'writing', count: 1 };
    h.master.start();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(h.master.status.value.kind, 'idle');
    assert.equal(h.sent.length, 0);
  } finally {
    h?.scope.stop();
    vi.useRealTimers();
  }
});

test('stopping a pending periodic write clears its visible in-flight state', async () => {
  vi.useFakeTimers();
  let h: Harness | null = null;
  try {
    h = createHarness(() => true, {
      enabled: true,
      writeIntervalMs: 100,
      timeoutMs: 1000,
    });
    addRegister(h, {
      id: 'stop-pending-write',
      fc: 0x06,
      address: 5,
      periodicRead: false,
      periodicWrite: true,
    });
    h.master.loadWriteSource(
      [{ t: 1, slave: 1, fc: 0x03, addr: 5, type: 'uint16', value: 7 }],
      'pending.bbreg',
    );
    h.master.start();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(h.master.writing.value, true);
    assert.equal(h.sent.length, 1);
    h.master.stop();

    assert.equal(h.master.writing.value, false);
    assert.equal(h.master.status.value.kind, 'idle');
  } finally {
    h?.scope.stop();
    vi.useRealTimers();
  }
});
