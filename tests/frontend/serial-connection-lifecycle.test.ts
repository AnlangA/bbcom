import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import { useSerialConnection } from '../../src/composables/useSerialConnection.ts';
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
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeWatch implements SerialWatchHandleAdapter {
  unwatchCalls = 0;
  async unwatch(): Promise<void> {
    this.unwatchCalls += 1;
  }
}

class FakePort implements SerialPortAdapter {
  handlers: WatchHandlers | null = null;
  watchHandle = new FakeWatch();
  openCalls = 0;
  watchCalls = 0;
  closeCalls = 0;
  forceCloseCalls = 0;
  setBreakCalls = 0;
  clearBreakCalls = 0;
  writeCalls: Uint8Array[] = [];
  openImpl: () => Promise<void> = async () => undefined;
  watchImpl: () => Promise<SerialWatchHandleAdapter> = async () => this.watchHandle;
  writeImpl: (data: Uint8Array) => Promise<number> = async (data) => data.length;
  dtrImpl: () => Promise<void> = async () => undefined;
  rtsImpl: () => Promise<void> = async () => undefined;
  setBreakImpl: () => Promise<void> = async () => undefined;
  clearBreakImpl: () => Promise<void> = async () => undefined;

  async open(): Promise<void> {
    this.openCalls += 1;
    await this.openImpl();
  }

  async watch(handlers: WatchHandlers, _options?: WatchOptions): Promise<SerialWatchHandleAdapter> {
    this.watchCalls += 1;
    this.handlers = handlers;
    return this.watchImpl();
  }

  async writeBinary(data: Uint8Array): Promise<number> {
    this.writeCalls.push(data.slice());
    return this.writeImpl(data);
  }

  async writeDataTerminalReady(): Promise<void> {
    await this.dtrImpl();
  }
  async writeRequestToSend(): Promise<void> {
    await this.rtsImpl();
  }
  async setBreak(): Promise<void> {
    this.setBreakCalls += 1;
    await this.setBreakImpl();
  }
  async clearBreak(): Promise<void> {
    this.clearBreakCalls += 1;
    await this.clearBreakImpl();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async forceClose(): Promise<void> {
    this.forceCloseCalls += 1;
  }
}

function createConnection(
  ports: FakePort[],
  options: Parameters<typeof useSerialConnection>[3] = {},
  dependencies: Parameters<typeof useSerialConnection>[4] = {},
) {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM1', config);
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(sessionId, 'COM1', config, options, {
      ...dependencies,
      createPort: () => {
        const next = ports.shift();
        assert.ok(next, 'test port factory exhausted');
        return next;
      },
    }),
  );
  assert.ok(connection);
  return { connection, scope, store, sessionId };
}

test('stop during a pending open invalidates the generation and closes the late port', async () => {
  const opening = deferred<void>();
  const fake = new FakePort();
  fake.openImpl = () => opening.promise;
  const { connection, scope, store, sessionId } = createConnection([fake]);

  const starting = connection.start();
  await Promise.resolve();
  assert.equal(fake.openCalls, 1);
  await connection.stop();
  assert.ok(fake.closeCalls >= 1, 'stop requests close even while open is pending');

  opening.resolve();
  assert.equal(await starting, false);
  assert.equal(fake.watchCalls, 0, 'a stale open never installs a watch');
  assert.ok(fake.closeCalls >= 2, 'late open completion is closed again by transaction rollback');
  assert.equal(connection.port.value, null);
  assert.equal(connection.isConnected.value, false);
  assert.equal(store.sessions.find((session) => session.id === sessionId)?.isConnected, false);
  scope.stop();
});

test('watch installation failure rolls back the candidate port', async () => {
  const fake = new FakePort();
  fake.watchImpl = async () => {
    throw new Error('watch unavailable');
  };
  const { connection, scope } = createConnection([fake]);

  assert.equal(await connection.start(), false);
  assert.equal(fake.openCalls, 1);
  assert.equal(fake.watchCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.equal(connection.port.value, null);
  assert.match(connection.error.value ?? '', /watch unavailable/);
  scope.stop();
});

for (const stage of ['watch', 'dtr', 'rts'] as const) {
  test(`stop invalidates pending ${stage} transaction stage`, async () => {
    const gate = deferred<void>();
    const reached = deferred<void>();
    const fake = new FakePort();
    if (stage === 'watch') {
      fake.watchImpl = async () => {
        reached.resolve();
        await gate.promise;
        return fake.watchHandle;
      };
    } else if (stage === 'dtr') {
      fake.dtrImpl = async () => {
        reached.resolve();
        await gate.promise;
      };
    } else {
      fake.rtsImpl = async () => {
        reached.resolve();
        await gate.promise;
      };
    }
    const { connection, scope } = createConnection([fake]);
    const starting = connection.start();
    await reached.promise;

    await connection.stop();
    gate.resolve();
    assert.equal(await starting, false);
    assert.equal(connection.port.value, null);
    assert.equal(connection.isConnected.value, false);
    assert.ok(fake.closeCalls >= 2, 'stop request and stale transaction rollback both close');
    if (stage !== 'watch') assert.equal(fake.watchHandle.unwatchCalls, 1);
    scope.stop();
  });
}

test('a stale disconnect callback cannot tear down the replacement connection', async () => {
  const first = new FakePort();
  const second = new FakePort();
  const { connection, scope } = createConnection([first, second]);

  assert.equal(await connection.start(), true);
  assert.equal(await connection.start(), true);
  assert.equal(connection.port.value, second);
  first.handlers?.onDisconnect?.('late old event');
  await Promise.resolve();

  assert.equal(connection.port.value, second);
  assert.equal(connection.isConnected.value, true);
  assert.equal(first.watchHandle.unwatchCalls, 1);
  let staleRaw = 0;
  connection.rawBytes(() => {
    staleRaw += 1;
  });
  first.handlers?.onData(new Uint8Array([1]));
  first.handlers?.onError?.('old watch error');
  assert.equal(staleRaw, 0, 'stale data callbacks cannot enter the replacement runtime');
  await connection.stop();
  scope.stop();
});

test('a disconnect during watch setup invalidates the uncommitted candidate', async () => {
  const watchReady = deferred<void>();
  const releaseWatch = deferred<void>();
  const fake = new FakePort();
  fake.watchImpl = async () => {
    watchReady.resolve();
    await releaseWatch.promise;
    return fake.watchHandle;
  };
  const { connection, scope } = createConnection([fake]);

  const starting = connection.start();
  await watchReady.promise;
  fake.handlers?.onDisconnect?.('removed before watch commit');
  releaseWatch.resolve();

  assert.equal(await starting, false);
  assert.equal(connection.port.value, null);
  assert.equal(connection.isConnected.value, false);
  assert.equal(fake.watchHandle.unwatchCalls, 1);
  assert.equal(fake.closeCalls, 1);
  scope.stop();
});

test('disconnect rejects queued writes and force-closes one in-flight write', async () => {
  const writing = deferred<number>();
  const fake = new FakePort();
  fake.writeImpl = () => writing.promise;
  const { connection, scope } = createConnection([fake], {}, { writeCloseGraceMs: 5 });
  assert.equal(await connection.start(), true);

  const first = connection.sendBytes(new Uint8Array(32));
  const second = connection.sendBytes(new Uint8Array(32));
  const stopping = connection.stop();

  assert.equal((await second).reason, 'disconnecting');
  await stopping;
  assert.equal((await first).reason, 'disconnecting');
  assert.equal(fake.writeCalls.length, 1);
  assert.ok(fake.closeCalls >= 1);
  assert.equal(fake.forceCloseCalls, 1, 'a stalled driver write uses the v3 hard-close path');

  writing.resolve(32);
  await Promise.resolve();
  assert.equal(fake.writeCalls.length, 1, 'stale completion cannot start the next write');
  scope.stop();
});

test('RX capture drains without RAF while frame publication stays throttled', async () => {
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  const rxFrames: number[] = [];
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    { onRxFrame: (frame) => rxFrames.push(frame.data.length) },
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );
  assert.equal(await connection.start(), true);
  const versionBefore = store.getSessionFramesVersion(sessionId);

  fake.handlers?.onData(new Uint8Array(1024));
  assert.equal(store.sessions[0].frames.length, 0);
  assert.equal(clock.timers[0].delay, 5);
  clock.runTimer(0);

  assert.deepEqual(rxFrames, [1024]);
  assert.equal(store.sessions[0].frames.length, 1, 'capture happens at the drain, not at paint');
  assert.equal(
    store.getSessionFramesVersion(sessionId),
    versionBefore,
    'silent capture does not publish UI immediately',
  );
  assert.equal(clock.timers[1].delay, 17);
  clock.runTimer(1);
  assert.equal(store.getSessionFramesVersion(sessionId), versionBefore + 1);

  await connection.stop();
  scope.stop();
});

test('10 MiB RX capture stays lossless when paint never runs', async () => {
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  let observedFrames = 0;
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    { onRxFrame: () => (observedFrames += 1) },
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );
  assert.equal(await connection.start(), true);

  const chunk = new Uint8Array(64 * 1024);
  for (let index = 0; index < 160; index += 1) {
    fake.handlers?.onData(chunk);
    // Native watch callbacks are separate tasks, so their queued drain
    // microtask runs before the next callback arrives.
    clock.runMicrotasks();
  }

  assert.equal(observedFrames, 160);
  assert.equal(store.sessions[0].frames.length, 160);
  assert.equal(store.sessions[0].rxBytes, 10 * 1024 * 1024);
  assert.equal(connection.totalDroppedBytes.value, 0);
  assert.equal(clock.timers.length, 1, 'all capture drains coalesce to one UI publication');
  assert.equal(store.getSessionFramesVersion(sessionId), 0);
  clock.runTimer(0);
  assert.equal(store.getSessionFramesVersion(sessionId), 1);

  await connection.stop();
  scope.stop();
});

test('unsupported control lines remain non-fatal and auto-reconnect commits only the replacement port', async () => {
  vi.useFakeTimers();
  try {
    const first = new FakePort();
    const replacement = new FakePort();
    first.dtrImpl = async () => {
      throw new Error('DTR unsupported');
    };
    first.rtsImpl = async () => {
      throw new Error('RTS unsupported');
    };
    let reconnecting = 0;
    let reconnected = 0;
    const { connection, scope } = createConnection([first, replacement], {
      autoReconnect: () => true,
      onReconnecting: () => {
        reconnecting += 1;
      },
      onReconnected: () => {
        reconnected += 1;
      },
    });

    assert.equal(await connection.start(), true);
    first.handlers?.onDisconnect?.('device removed');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);

    assert.equal(reconnecting, 1);
    assert.equal(reconnected, 1);
    assert.equal(connection.port.value, replacement);
    assert.equal(connection.isConnected.value, true);
    await connection.stop();
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('an explicit stop cancels a scheduled reconnect before it can open another port', async () => {
  vi.useFakeTimers();
  try {
    const first = new FakePort();
    const replacement = new FakePort();
    const { connection, scope } = createConnection([first, replacement], {
      autoReconnect: () => true,
    });
    assert.equal(await connection.start(), true);

    first.handlers?.onDisconnect?.('device removed');
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(connection.reconnecting.value, true);

    await connection.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(connection.reconnecting.value, false);
    assert.equal(
      replacement.openCalls,
      0,
      'cancelled reconnect must not consume a replacement port',
    );
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('a newer start supersedes an opening candidate and reconnect exhaustion reports one final disconnect', async () => {
  vi.useFakeTimers();
  try {
    const gate = deferred<void>();
    const opening = new FakePort();
    opening.openImpl = () => gate.promise;
    const replacement = new FakePort();
    const failures = Array.from({ length: 10 }, () => {
      const failed = new FakePort();
      failed.openImpl = async () => {
        throw new Error('still unplugged');
      };
      return failed;
    });
    let disconnects = 0;
    const { connection, scope } = createConnection([opening, replacement, ...failures], {
      autoReconnect: () => true,
      onDisconnect: () => {
        disconnects += 1;
      },
    });

    const firstStart = connection.start();
    await Promise.resolve();
    assert.equal(await connection.start(), true);
    gate.resolve();
    assert.equal(await firstStart, false);

    replacement.handlers?.onDisconnect?.('device removed');
    await Promise.resolve();
    for (let index = 0; index <= 10; index += 1) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    assert.equal(connection.reconnecting.value, false);
    assert.equal(disconnects, 1);
    await connection.stop();
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('construction can retain default serial dependencies until an explicit connection attempt', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM-default', config);
  const scope = effectScope();
  const connection = scope.run(() => useSerialConnection(sessionId, 'COM-default', config));
  assert.ok(connection);
  assert.equal(connection.isConnected.value, false);
  scope.stop();
});

test('raw callbacks precede capture, overflow is explicit, and recovery clears the transient error', async () => {
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  const raw: number[] = [];
  const overflows: number[] = [];
  const { connection, scope } = createConnection(
    [fake],
    { onOverflow: (total) => overflows.push(total) },
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );
  assert.equal(await connection.start(), true);
  const removeRaw = connection.rawBytes((bytes) => raw.push(bytes.length));

  fake.handlers?.onData('text');
  fake.handlers?.onData(new Uint8Array(0));
  assert.deepEqual(raw, [4], 'raw observers receive bytes before queued capture');

  const maxQueue = 2 * 1024 * 1024;
  fake.handlers?.onData(new Uint8Array(maxQueue));
  fake.handlers?.onData(new Uint8Array(1));
  assert.equal(overflows.length, 1);
  assert.ok(connection.totalDroppedBytes.value >= maxQueue);
  assert.ok(connection.error.value);

  clock.runMicrotasks();
  fake.handlers?.onData(new Uint8Array([1]));
  assert.equal(
    connection.error.value,
    null,
    'a successful post-drain enqueue clears overflow state',
  );
  fake.handlers?.onError?.('watch warning');
  removeRaw();
  fake.handlers?.onData(new Uint8Array([2]));
  assert.equal(raw.at(-1), 1, 'removed raw observer is not called again');

  await connection.stop();
  scope.stop();
});

test('send and break boundaries report structured failures while retaining only confirmed TX prefixes', async () => {
  vi.useFakeTimers();
  try {
    const fake = new FakePort();
    const { connection, scope, store } = createConnection([fake]);

    assert.equal((await connection.send('', false)).code, 'INVALID_INPUT');
    assert.equal((await connection.send('ABC', true)).reason, 'bad-hex');
    assert.equal((await connection.sendBytes(new Uint8Array())).reason, 'empty');
    assert.equal((await connection.sendBytes(new Uint8Array(1024 * 1024 + 1))).reason, 'too-large');
    assert.equal((await connection.send('AT', false)).code, 'SERIAL_DISCONNECTED');
    assert.equal(await connection.sendBreak(), false);

    assert.equal(await connection.start(), true);
    const complete = await connection.send('OK', false);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.confirmedBytes, 2);
    assert.deepEqual(store.sessions[0].frames.at(-1)?.data, new Uint8Array([0x4f, 0x4b]));
    assert.equal(store.sessions[0].frames.at(-1)?.txStatus, 'complete');

    let writes = 0;
    fake.writeImpl = async (chunk) => {
      writes += 1;
      if (writes === 2) throw new Error('second chunk failed');
      return chunk.length;
    };
    const partial = await connection.sendBytes(new Uint8Array(5_000));
    assert.equal(partial.ok, false);
    assert.equal(partial.confirmedBytes, 4096);
    const frame = store.sessions[0].frames.at(-1);
    assert.equal(frame?.direction, 'TX');
    assert.equal(frame?.data.length, 4096);
    assert.equal(frame?.txStatus, 'partial-unknown');

    const inFlightBreak = connection.sendBreak(5);
    await Promise.resolve();
    assert.equal(await connection.sendBreak(5), false, 'only one hardware break is in flight');
    await vi.advanceTimersByTimeAsync(5);
    assert.equal(await inFlightBreak, true);
    fake.setBreakImpl = async () => {
      throw new Error('break unsupported');
    };
    assert.equal(await connection.sendBreak(1), false);

    await connection.stop();
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

function fakeTimerScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const microtasks: Array<() => void> = [];
  const scheduler: SerialTimerScheduler = {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) {
      (handle as (typeof timers)[number]).cancelled = true;
    },
    microtask(callback) {
      microtasks.push(callback);
    },
  };
  return {
    scheduler,
    timers,
    runTimer(index: number) {
      const timer = timers[index];
      if (timer && !timer.cancelled) timer.callback();
    },
    runMicrotasks() {
      while (microtasks.length > 0) microtasks.shift()?.();
    },
  };
}
