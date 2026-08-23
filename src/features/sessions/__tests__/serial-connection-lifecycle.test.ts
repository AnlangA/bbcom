import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import { useSerialConnection } from '@/features/sessions/application/use-serial-connection.ts';
import type { SerialPortAdapter, SerialWatchHandleAdapter } from '@/features/serial/index.ts';
import type { SerialTimerScheduler } from '@/lib/serial-rx-scheduler.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import type { PortConfig } from '@/types/serial.ts';
import {
  PortLeaseRegistry,
  type FrozenPortLeaseGrant,
  type HeldPortLeaseState,
  type PortLeaseClient,
} from '@/features/serial/application/port-lease-registry.ts';
import type { SerialDrainResponse } from '@/generated/ipc-contracts.ts';

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
  unwatchImpl: () => Promise<void> = async () => undefined;
  async unwatch(): Promise<void> {
    this.unwatchCalls += 1;
    await this.unwatchImpl();
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
  nativeDrainCalls = 0;
  channelYieldCalls = 0;
  writeCalls: Uint8Array[] = [];
  openImpl: () => Promise<void> = async () => undefined;
  watchImpl: () => Promise<SerialWatchHandleAdapter> = async () => this.watchHandle;
  writeImpl: (data: Uint8Array) => Promise<number> = async (data) => data.length;
  dtrImpl: () => Promise<void> = async () => undefined;
  rtsImpl: () => Promise<void> = async () => undefined;
  setBreakImpl: () => Promise<void> = async () => undefined;
  clearBreakImpl: () => Promise<void> = async () => undefined;
  nativeDrainImpl: () => Promise<SerialDrainResponse> = async () => ({
    bytes: [],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  channelYieldImpl: () => Promise<void> = async () => undefined;
  closeImpl: () => Promise<void> = async () => undefined;
  forceCloseImpl: () => Promise<void> = async () => undefined;

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
    await this.closeImpl();
  }

  async drainNativeInput(): Promise<SerialDrainResponse> {
    this.nativeDrainCalls += 1;
    return this.nativeDrainImpl();
  }

  async yieldQueuedChannelEvents(): Promise<void> {
    this.channelYieldCalls += 1;
    await this.channelYieldImpl();
  }

  async forceClose(): Promise<void> {
    this.forceCloseCalls += 1;
    await this.forceCloseImpl();
  }
}

function createConnection(
  ports: FakePort[],
  options: Parameters<typeof useSerialConnection>[3] = {},
  dependencies: Partial<Parameters<typeof useSerialConnection>[4]> = {},
  target: {
    portName?: string | (() => string);
    config?: PortConfig | (() => PortConfig);
  } = {},
) {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM1', config);
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(sessionId, target.portName ?? 'COM1', target.config ?? config, options, {
      leaseClient: dependencies.leaseClient ?? new PortLeaseRegistry({ platform: 'windows' }),
      sessionName: dependencies.sessionName ?? 'COM1',
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

class FaultingLeaseClient implements PortLeaseClient {
  readonly registry = new PortLeaseRegistry({ platform: 'windows' });
  connectedTransitions = 0;
  failConnectedTransitionAt: number | null = null;
  failReconnectTransition = false;

  acquire(portName: string, sessionId: string, sessionName: string): FrozenPortLeaseGrant {
    return this.registry.acquire(portName, sessionId, sessionName);
  }

  transition(leaseId: string, sessionId: string, state: HeldPortLeaseState): FrozenPortLeaseGrant {
    if (state === 'connected') {
      this.connectedTransitions += 1;
      if (this.connectedTransitions === this.failConnectedTransitionAt) {
        throw new Error('connected transition rejected');
      }
    }
    if (state === 'reconnecting' && this.failReconnectTransition) {
      throw new Error('reconnect transition rejected');
    }
    return this.registry.transition(leaseId, sessionId, state);
  }

  release(leaseId: string, sessionId: string): boolean {
    return this.registry.release(leaseId, sessionId);
  }
}

test('stop during a pending open invalidates the generation and closes the late port', async () => {
  const opening = deferred<void>();
  const fake = new FakePort();
  fake.openImpl = () => opening.promise;
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    {},
    { writeCloseGraceMs: 5 },
  );

  const starting = connection.start();
  await Promise.resolve();
  assert.equal(fake.openCalls, 1);
  const firstStop = await connection.stop();
  assert.equal(firstStop.pendingOpen, 'unsettled');
  assert.equal(firstStop.rxDrainGuarantee, 'not-guaranteed');
  assert.equal(fake.closeCalls, 0, 'an unresolved open is not closed before it settles');

  opening.resolve();
  assert.equal(await starting, false);
  assert.equal(fake.watchCalls, 0, 'a stale open never installs a watch');
  assert.equal(fake.closeCalls, 1, 'the settled stale transaction performs its final close');
  assert.equal(connection.port.value, null);
  assert.equal(connection.isConnected.value, false);
  assert.equal(store.sessions.find((session) => session.id === sessionId)?.isConnected, false);
  scope.stop();
});

test('watch installation failure rolls back the candidate port', async () => {
  const fake = new FakePort();
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  fake.watchImpl = async () => {
    throw new Error('watch unavailable');
  };
  const { connection, scope } = createConnection([fake], {}, { leaseClient: leases });

  assert.equal(await connection.start(), false);
  assert.equal(fake.openCalls, 1);
  assert.equal(fake.watchCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.equal(connection.port.value, null);
  assert.equal(connection.error.value, 'BUSY');
  assert.equal(connection.connectionFailure.value?.category, 'backend-failure');
  assert.equal(leases.getByPort('COM1'), undefined);
  scope.stop();
});

test('port lease conflict blocks native open and exposes stable owner navigation metadata', async () => {
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const owner = leases.acquire('COM1', 'owner-session', 'Owner session');
  const fake = new FakePort();
  const { connection, scope } = createConnection([fake], {}, { leaseClient: leases });

  assert.equal(await connection.start(), false);
  assert.equal(fake.openCalls, 0);
  assert.equal(connection.error.value, 'PORT_IN_USE');
  assert.equal(connection.connectionFailure.value?.error.code, 'PORT_IN_USE');
  assert.deepEqual(connection.connectionFailure.value?.conflict, {
    ownerSessionId: 'owner-session',
    ownerSessionName: 'Owner session',
    canonicalPort: 'COM1',
  });
  assert.doesNotMatch(JSON.stringify(connection.connectionFailure.value), /stack|payload/);

  assert.equal(leases.release(owner.leaseId, 'owner-session'), true);
  assert.equal(await connection.start(), true);
  assert.equal(leases.getByPort('COM1')?.state, 'connected');
  await connection.stop();
  assert.equal(leases.getByPort('COM1'), undefined);
  scope.stop();
});

for (const stage of ['watch', 'dtr', 'rts'] as const) {
  test(`stop invalidates pending ${stage} transaction stage`, async () => {
    const gate = deferred<void>();
    const reached = deferred<void>();
    const unwatchStarted = deferred<void>();
    const releaseUnwatch = deferred<void>();
    const fake = new FakePort();
    const clock = fakeTimerScheduler();
    const shutdownOrder: string[] = [];
    fake.watchHandle.unwatchImpl = async () => {
      shutdownOrder.push('unwatch');
      unwatchStarted.resolve();
      await releaseUnwatch.promise;
    };
    fake.nativeDrainImpl = async () => {
      shutdownOrder.push('drain');
      return { bytes: [0x5a], guaranteed: true, completion: 'idle-gap-observed' };
    };
    fake.channelYieldImpl = async () => {
      shutdownOrder.push('yield');
      fake.handlers?.onData(new Uint8Array([0x5b]));
    };
    fake.closeImpl = async () => {
      shutdownOrder.push('close');
    };
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
    const { connection, scope, store, sessionId } = createConnection(
      [fake],
      {},
      {
        writeCloseGraceMs: 5,
        timerScheduler: clock.scheduler,
        isDocumentVisible: () => true,
      },
    );
    const starting = connection.start();
    await reached.promise;

    const stopped = await connection.stop();
    assert.equal(stopped.pendingOpen, 'unsettled');
    assert.equal(stopped.rxDrainGuarantee, 'not-guaranteed');
    assert.equal(fake.closeCalls, 0, 'pending setup is not closed ahead of its RX barrier');
    gate.resolve();
    await unwatchStarted.promise;
    fake.handlers?.onData(new Uint8Array([0x59]));
    assert.equal(
      store.sessions.find((session) => session.id === sessionId)?.frames.length,
      0,
      'pending-watch cleanup keeps queued RX unpublished until its explicit barrier',
    );
    releaseUnwatch.resolve();
    assert.equal(await starting, false);
    assert.equal(connection.port.value, null);
    assert.equal(connection.isConnected.value, false);
    assert.equal(fake.closeCalls, 1);
    assert.equal(fake.watchHandle.unwatchCalls, 1);
    assert.deepEqual(shutdownOrder, ['unwatch', 'drain', 'yield', 'close']);
    assert.deepEqual(
      store.sessions
        .find((session) => session.id === sessionId)
        ?.frames.map((frame) => [...frame.data]),
      [[0x59, 0x5a, 0x5b]],
      'the uncommitted watch tail remains receivable through unwatch, native drain, and Channel yield',
    );
    scope.stop();
  });
}

test('replacement start drains the old RX boundary before committing and ignores later stale callbacks', async () => {
  const unwatchStarted = deferred<void>();
  const releaseUnwatch = deferred<void>();
  const first = new FakePort();
  const second = new FakePort();
  const clock = fakeTimerScheduler();
  first.watchHandle.unwatchImpl = async () => {
    unwatchStarted.resolve();
    await releaseUnwatch.promise;
  };
  first.nativeDrainImpl = async () => ({
    bytes: [0x42],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  first.channelYieldImpl = async () => {
    first.handlers?.onData(new Uint8Array([0x43]));
  };
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const { connection, scope, store, sessionId } = createConnection(
    [first, second],
    {},
    {
      leaseClient: leases,
      timerScheduler: clock.scheduler,
      isDocumentVisible: () => true,
    },
  );

  assert.equal(await connection.start(), true);
  const firstLeaseId = leases.getByPort('COM1')?.leaseId;
  first.handlers?.onData(new Uint8Array([0x40]));
  const replacing = connection.start();
  await unwatchStarted.promise;
  assert.equal(second.openCalls, 0, 'the replacement cannot open ahead of the old RX barrier');
  first.handlers?.onDisconnect?.('watch ended during replacement barrier');
  first.handlers?.onData(new Uint8Array([0x41]));
  releaseUnwatch.resolve();
  assert.equal(await replacing, true);
  assert.equal(leases.getByPort('COM1')?.leaseId, firstLeaseId);
  assert.equal(leases.getByPort('COM1')?.state, 'connected');
  assert.equal(connection.port.value, second);
  assert.deepEqual(
    store.sessions
      .find((session) => session.id === sessionId)
      ?.frames.map((frame) => [...frame.data]),
    [[0x40, 0x41, 0x42, 0x43]],
    'old RX remains admissible until unwatch, native drain, Channel yield, and renderer flush finish',
  );
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
  assert.equal(leases.getByPort('COM1'), undefined);
  scope.stop();
});

test('a disconnect during watch setup invalidates the uncommitted candidate', async () => {
  const watchReady = deferred<void>();
  const releaseWatch = deferred<void>();
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  fake.watchImpl = async () => {
    watchReady.resolve();
    await releaseWatch.promise;
    return fake.watchHandle;
  };
  fake.nativeDrainImpl = async () => ({
    bytes: [0x72],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  fake.channelYieldImpl = async () => {
    fake.handlers?.onData(new Uint8Array([0x73]));
  };
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    {},
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );

  const starting = connection.start();
  await watchReady.promise;
  fake.handlers?.onData(new Uint8Array([0x71]));
  fake.handlers?.onDisconnect?.('removed before watch commit');
  releaseWatch.resolve();

  assert.equal(await starting, false);
  assert.equal(connection.port.value, null);
  assert.equal(connection.isConnected.value, false);
  assert.equal(fake.watchHandle.unwatchCalls, 1);
  assert.equal(fake.nativeDrainCalls, 1);
  assert.equal(fake.channelYieldCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.deepEqual(
    store.sessions
      .find((session) => session.id === sessionId)
      ?.frames.map((frame) => [...frame.data]),
    [[0x71, 0x72, 0x73]],
    'pending-watch disconnect keeps RX open through native drain and queued Channel yield',
  );
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

  assert.equal((await second).outcome, 'cancelled');
  assert.equal((await second).error?.code, 'CANCELLED');
  await stopping;
  assert.equal((await first).outcome, 'cancelled');
  assert.equal((await first).error?.code, 'CANCELLED');
  assert.equal(fake.writeCalls.length, 1);
  assert.equal(fake.forceCloseCalls, 1, 'a stalled driver write uses the v3 hard-close path');

  writing.resolve(32);
  await Promise.resolve();
  assert.equal(fake.writeCalls.length, 1, 'stale completion cannot start the next write');
  scope.stop();
});

test('stop keeps the closing generation receivable until unwatch and publishes final RX before close', async () => {
  const unwatching = deferred<void>();
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  fake.watchHandle.unwatchImpl = () => unwatching.promise;
  fake.nativeDrainImpl = async () => ({
    bytes: [0x33],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  fake.channelYieldImpl = async () => {
    fake.handlers?.onData(new Uint8Array([0x44]));
  };
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    {},
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );
  assert.equal(await connection.start(), true);

  fake.handlers?.onData(new Uint8Array([0x11]));
  const stopping = connection.stop();
  await Promise.resolve();
  assert.equal(connection.isClosing.value, true);
  assert.equal(fake.watchHandle.unwatchCalls, 1);
  assert.equal(fake.nativeDrainCalls, 0, 'native drain waits for unwatch acknowledgement');
  assert.equal(fake.closeCalls, 0, 'native close waits for the watch boundary');

  const blockedSend = await connection.sendBytes(new Uint8Array([0xff]));
  assert.equal(blockedSend.outcome, 'failed', 'closing rejects new sends');
  assert.equal(await connection.start(), false, 'closing rejects a replacement connection');
  fake.handlers?.onData(new Uint8Array([0x22]));
  assert.equal(
    store.sessions.find((session) => session.id === sessionId)?.frames.length,
    0,
    'the final RX batch is not published before unwatch resolves',
  );

  unwatching.resolve();
  const result = await stopping;
  const frames = store.sessions.find((session) => session.id === sessionId)?.frames ?? [];
  assert.equal(connection.isClosing.value, false);
  assert.equal(fake.closeCalls, 1);
  assert.deepEqual(
    frames.map((frame) => Array.from(frame.data)),
    [[0x11, 0x22, 0x33, 0x44]],
  );
  assert.equal(fake.nativeDrainCalls, 1);
  assert.equal(fake.channelYieldCalls, 1);
  assert.deepEqual(result, {
    watch: 'unwatch-acknowledged',
    rxDrainGuarantee: 'guaranteed',
    rxDrainStatus: 'idle-gap-observed',
    nativeDrainedBytes: 1,
    pendingOpen: 'none',
    portClose: 'close-acknowledged',
  });
  scope.stop();
});

test('native drain command failure is explicit and still closes the port', async () => {
  const fake = new FakePort();
  fake.nativeDrainImpl = async () => {
    throw new Error('native detail must not cross the stop result');
  };
  const { connection, scope } = createConnection([fake]);
  assert.equal(await connection.start(), true);

  const result = await connection.stop();

  assert.equal(fake.nativeDrainCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.deepEqual(result, {
    watch: 'unwatch-acknowledged',
    rxDrainGuarantee: 'not-guaranteed',
    rxDrainStatus: 'native-command-failed',
    nativeDrainedBytes: 0,
    pendingOpen: 'none',
    portClose: 'close-acknowledged',
  });
  assert.doesNotMatch(JSON.stringify(result), /native detail/i);
  const repeated = await connection.stop();
  assert.equal(repeated.portClose, 'no-active-port');
  assert.equal(repeated.rxDrainGuarantee, 'not-guaranteed');
  assert.equal(
    repeated.rxDrainStatus,
    'native-command-failed',
    'an empty retry cannot wash away an unproven historical RX boundary',
  );
  scope.stop();
});

test('disconnect and stop share one shutdown task and retain the failed attempt for retry', async () => {
  const unwatchStarted = deferred<void>();
  const releaseUnwatch = deferred<void>();
  const fake = new FakePort();
  const clock = fakeTimerScheduler();
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  fake.watchHandle.unwatchImpl = async () => {
    unwatchStarted.resolve();
    await releaseUnwatch.promise;
  };
  fake.nativeDrainImpl = async () => ({
    bytes: [0x22],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  fake.channelYieldImpl = async () => {
    fake.handlers?.onData(new Uint8Array([0x23]));
  };
  fake.closeImpl = async () => {
    throw new Error('close failed');
  };
  fake.forceCloseImpl = async () => {
    throw new Error('force close failed');
  };
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    {},
    {
      leaseClient: leases,
      writeCloseGraceMs: 5,
      timerScheduler: clock.scheduler,
      isDocumentVisible: () => true,
    },
  );
  assert.equal(await connection.start(), true);
  const leaseId = leases.getByPort('COM1')?.leaseId;

  fake.handlers?.onDisconnect?.('device removed');
  await unwatchStarted.promise;
  const stopping = connection.stop();
  assert.equal(
    leases.getByPort('COM1')?.leaseId,
    leaseId,
    'a concurrent stop retains the disconnect-owned lease until the shared shutdown task settles',
  );
  assert.equal(leases.getByPort('COM1')?.state, 'closing');
  fake.handlers?.onData(new Uint8Array([0x21]));
  assert.equal(
    store.sessions.find((session) => session.id === sessionId)?.frames.length,
    0,
    'disconnect does not end RX admission while its shared shutdown barrier is blocked',
  );
  releaseUnwatch.resolve();
  const result = await stopping;

  assert.equal(result.portClose, 'close-failed');
  assert.equal(result.rxDrainGuarantee, 'guaranteed');
  assert.equal(fake.watchHandle.unwatchCalls, 1);
  assert.equal(fake.nativeDrainCalls, 1);
  assert.equal(fake.channelYieldCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.forceCloseCalls, 1);
  assert.deepEqual(
    store.sessions
      .find((session) => session.id === sessionId)
      ?.frames.map((frame) => [...frame.data]),
    [[0x21, 0x22, 0x23]],
  );
  assert.equal(leases.getByPort('COM1')?.state, 'closing');
  assert.equal(leases.getByPort('COM1')?.leaseId, leaseId);
  assert.equal(
    await connection.start(),
    false,
    'an unclosed attempt blocks replacement open and remains available to stop retry',
  );

  fake.closeImpl = async () => undefined;
  const retried = await connection.stop();
  assert.equal(retried.portClose, 'close-acknowledged');
  assert.equal(retried.rxDrainGuarantee, 'guaranteed');
  assert.equal(retried.rxDrainStatus, 'idle-gap-observed');
  assert.equal(fake.watchHandle.unwatchCalls, 1, 'the close retry reuses the first watch barrier');
  assert.equal(fake.nativeDrainCalls, 1, 'the close retry reuses the first positive RX barrier');
  assert.equal(fake.channelYieldCalls, 1, 'the close retry reuses the first Channel barrier');
  assert.equal(fake.closeCalls, 2);
  assert.equal(leases.getByPort('COM1'), undefined);
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
    const leases = new PortLeaseRegistry({ platform: 'windows' });
    const { connection, scope } = createConnection(
      [opening, replacement, ...failures],
      {
        autoReconnect: () => true,
        onDisconnect: () => {
          disconnects += 1;
        },
      },
      { leaseClient: leases },
    );

    const firstStart = connection.start();
    await Promise.resolve();
    assert.equal(
      await connection.start(),
      false,
      'an unresolved native open cannot be superseded by another handle',
    );
    gate.resolve();
    assert.equal(await firstStart, true);
    assert.equal(await connection.start(), true);
    assert.equal(
      leases.getByPort('COM1')?.state,
      'connected',
      'the stale opening generation cannot release its replacement lease',
    );

    replacement.handlers?.onDisconnect?.('device removed');
    await Promise.resolve();
    for (let index = 0; index <= 10; index += 1) {
      await vi.advanceTimersByTimeAsync(1500);
    }
    assert.equal(connection.reconnecting.value, false);
    assert.equal(disconnects, 1);
    assert.equal(leases.getByPort('COM1'), undefined, 'reconnect exhaustion releases the lease');
    await connection.stop();
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('construction retains native dependencies until an explicit leased connection attempt', () => {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const sessionId = store.createSession('COM-default', config);
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(sessionId, 'COM-default', config, undefined, {
      leaseClient: new PortLeaseRegistry({
        canonicalizer: (portName) => portName.toUpperCase(),
      }),
      sessionName: 'COM-default',
    }),
  );
  assert.ok(connection);
  assert.equal(connection.isConnected.value, false);
  scope.stop();
});

test('default visibility policy reads a live document when scheduling RX publication', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const listeners = new Map<string, EventListener>();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'hidden',
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Document,
  });
  const fake = new FakePort();
  try {
    const { connection, scope } = createConnection([fake]);
    assert.equal(await connection.start(), true);
    fake.handlers?.onData(new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(listeners.has('visibilitychange'), true);
    await connection.stop();
    scope.stop();
    assert.equal(listeners.has('visibilitychange'), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
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

    const emptyText = await connection.send('', false);
    assert.equal(emptyText.outcome, 'failed');
    assert.equal(emptyText.error?.code, 'INVALID_INPUT');
    assert.equal(emptyText.error?.field, 'payload');
    const badHex = await connection.send('ABC', true);
    assert.equal(badHex.outcome, 'failed');
    assert.equal(badHex.error?.code, 'INVALID_INPUT');
    const emptyBytes = await connection.sendBytes(new Uint8Array());
    assert.equal(emptyBytes.outcome, 'failed');
    assert.equal(emptyBytes.error?.code, 'INVALID_INPUT');
    const tooLarge = await connection.sendBytes(new Uint8Array(1024 * 1024 + 1));
    assert.equal(tooLarge.outcome, 'failed');
    assert.equal(tooLarge.error?.code, 'LIMIT_EXCEEDED');
    assert.equal(tooLarge.error?.actual, 1024 * 1024 + 1);
    const disconnected = await connection.send('AT', false);
    assert.equal(disconnected.outcome, 'failed');
    assert.equal(disconnected.error?.code, 'SERIAL_DISCONNECTED');
    assert.equal(await connection.sendBreak(), false);

    assert.equal(await connection.start(), true);
    const complete = await connection.send('OK', false);
    assert.equal(complete.outcome, 'complete');
    assert.equal(complete.sentBytes, 2);
    assert.deepEqual(store.sessions[0].frames.at(-1)?.data, new Uint8Array([0x4f, 0x4b]));
    assert.equal(store.sessions[0].frames.at(-1)?.txStatus, 'complete');

    let writes = 0;
    fake.writeImpl = async (chunk) => {
      writes += 1;
      if (writes === 2) throw new Error('second chunk failed');
      return chunk.length;
    };
    const partial = await connection.sendBytes(new Uint8Array(5_000));
    assert.equal(partial.outcome, 'partial');
    assert.equal(partial.sentBytes, 4096);
    assert.equal(partial.error?.code, 'SERIAL_PARTIAL_WRITE');
    assert.equal(partial.error?.messageKey, 'error.serial_partial_write');
    assert.doesNotMatch(JSON.stringify(partial), /second chunk failed/);
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

test('invalid dynamic port targets fail before lease acquisition or native open', async () => {
  for (const invalidPortName of ['', 'A\u0000B', 'P'.repeat(1025)]) {
    const fake = new FakePort();
    const { connection, scope } = createConnection(
      [fake],
      {},
      {},
      { portName: () => invalidPortName },
    );

    assert.equal(await connection.start(), false);
    assert.equal(connection.connectionFailure.value?.category, 'invalid-port');
    assert.equal(connection.error.value, 'INVALID_INPUT');
    assert.equal(fake.openCalls, 0);
    scope.stop();
  }
});

test('terminal or unavailable lease registries fail closed before opening a driver handle', async () => {
  const terminalLeaseClient: PortLeaseClient = {
    acquire(portName, sessionId, sessionName) {
      return Object.freeze({
        leaseId: 'terminal-lease',
        owner: Object.freeze({ sessionId, sessionName, canonicalPort: portName }),
        state: 'closing',
      });
    },
    transition() {
      throw new Error('terminal lease cannot transition');
    },
    release() {
      return true;
    },
  };
  const terminalPort = new FakePort();
  const terminal = createConnection([terminalPort], {}, { leaseClient: terminalLeaseClient });
  assert.equal(await terminal.connection.start(), false);
  assert.equal(terminal.connection.connectionFailure.value?.category, 'backend-failure');
  assert.equal(terminalPort.openCalls, 0);
  terminal.scope.stop();

  const shutDownRegistry = new PortLeaseRegistry({ platform: 'windows' });
  shutDownRegistry.shutdown();
  const unavailablePort = new FakePort();
  const unavailable = createConnection([unavailablePort], {}, { leaseClient: shutDownRegistry });
  assert.equal(await unavailable.connection.start(), false);
  assert.equal(unavailable.connection.connectionFailure.value?.category, 'invalid-port');
  assert.equal(unavailablePort.openCalls, 0);
  unavailable.scope.stop();
});

test('a connected lease transition failure rolls back a newly opened port and releases ownership', async () => {
  const leases = new FaultingLeaseClient();
  leases.failConnectedTransitionAt = 1;
  const fake = new FakePort();
  const { connection, scope } = createConnection([fake], {}, { leaseClient: leases });

  assert.equal(await connection.start(), false);
  assert.equal(fake.openCalls, 1);
  assert.equal(fake.watchCalls, 1);
  assert.equal(fake.watchHandle.unwatchCalls, 1);
  assert.equal(fake.closeCalls, 1);
  assert.equal(connection.isConnected.value, false);
  assert.equal(leases.registry.size, 0);
  scope.stop();
});

test('a failed connected transition retains an unclosed handle for an explicit close retry', async () => {
  const leases = new FaultingLeaseClient();
  leases.failConnectedTransitionAt = 1;
  const fake = new FakePort();
  fake.closeImpl = async () => {
    throw new Error('close failed');
  };
  fake.forceCloseImpl = async () => {
    throw new Error('force close failed');
  };
  const { connection, scope } = createConnection(
    [fake],
    {},
    { leaseClient: leases, writeCloseGraceMs: 5 },
  );

  assert.equal(await connection.start(), false);
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.forceCloseCalls, 1);
  assert.equal(leases.registry.getByPort('COM1')?.state, 'closing');
  assert.equal(
    await connection.start(),
    false,
    'the concrete unclosed handle blocks a replacement',
  );

  fake.closeImpl = async () => undefined;
  const stopped = await connection.stop();
  assert.equal(stopped.portClose, 'close-acknowledged');
  assert.equal(leases.registry.size, 0);
  scope.stop();
});

test('replacement start refuses an unsafe RX boundary and releases the old lease', async () => {
  const first = new FakePort();
  const replacement = new FakePort();
  first.nativeDrainImpl = async () => {
    throw new Error('native drain unavailable');
  };
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const { connection, scope } = createConnection([first, replacement], {}, { leaseClient: leases });

  assert.equal(await connection.start(), true);
  assert.equal(await connection.start(), false);
  assert.equal(replacement.openCalls, 0);
  assert.equal(connection.isConnected.value, false);
  assert.equal(leases.size, 0);
  const stopped = await connection.stop();
  assert.equal(stopped.rxDrainGuarantee, 'not-guaranteed');
  assert.equal(stopped.rxDrainStatus, 'native-command-failed');
  scope.stop();
});

test('replacement start retains a physically unclosed old handle until stop retries it', async () => {
  const first = new FakePort();
  const replacement = new FakePort();
  first.closeImpl = async () => {
    throw new Error('close failed');
  };
  first.forceCloseImpl = async () => {
    throw new Error('force close failed');
  };
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const { connection, scope } = createConnection(
    [first, replacement],
    {},
    { leaseClient: leases, writeCloseGraceMs: 5 },
  );

  assert.equal(await connection.start(), true);
  assert.equal(await connection.start(), false);
  assert.equal(replacement.openCalls, 0);
  assert.equal(leases.getByPort('COM1')?.state, 'closing');

  first.closeImpl = async () => undefined;
  assert.equal((await connection.stop()).portClose, 'close-acknowledged');
  assert.equal(leases.size, 0);
  scope.stop();
});

test('failed-open rollback keeps an unclosed candidate reachable for retry', async () => {
  const fake = new FakePort();
  fake.openImpl = async () => {
    throw new Error('open failed');
  };
  fake.closeImpl = async () => {
    throw new Error('close failed');
  };
  fake.forceCloseImpl = async () => {
    throw new Error('force close failed');
  };
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const { connection, scope } = createConnection(
    [fake],
    {},
    { leaseClient: leases, writeCloseGraceMs: 5 },
  );

  assert.equal(await connection.start(), false);
  assert.equal(connection.error.value, 'BUSY');
  assert.equal(fake.closeCalls, 1);
  assert.equal(fake.forceCloseCalls, 1);
  assert.equal(leases.getByPort('COM1')?.state, 'closing');

  fake.closeImpl = async () => undefined;
  assert.equal((await connection.stop()).portClose, 'close-acknowledged');
  assert.equal(leases.size, 0);
  scope.stop();
});

test('disconnect without auto-reconnect releases ownership and reports the terminal event', async () => {
  const fake = new FakePort();
  const disconnected = deferred<void>();
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  const { connection, scope } = createConnection(
    [fake],
    { onDisconnect: () => disconnected.resolve(), autoReconnect: () => false },
    { leaseClient: leases },
  );
  assert.equal(await connection.start(), true);

  fake.handlers?.onDisconnect?.('device removed');
  await disconnected.promise;
  assert.equal(connection.isConnected.value, false);
  assert.equal(leases.size, 0);
  scope.stop();
});

test('disconnect records each native RX barrier failure mode without reconnecting', async () => {
  for (const mode of ['unwatch', 'native-unavailable', 'yield'] as const) {
    const fake = new FakePort();
    if (mode === 'unwatch') {
      fake.watchHandle.unwatchImpl = async () => {
        throw new Error('unwatch failed');
      };
    } else if (mode === 'native-unavailable') {
      Object.defineProperty(fake, 'drainNativeInput', { configurable: true, value: undefined });
    } else {
      fake.channelYieldImpl = async () => {
        throw new Error('channel yield failed');
      };
    }
    const disconnected = deferred<void>();
    const { connection, scope } = createConnection([fake], {
      onDisconnect: () => disconnected.resolve(),
    });
    assert.equal(await connection.start(), true);

    fake.handlers?.onDisconnect?.('device removed');
    await disconnected.promise;
    const result = await connection.stop();
    assert.equal(result.rxDrainGuarantee, 'not-guaranteed');
    assert.equal(
      result.rxDrainStatus,
      mode === 'unwatch'
        ? 'unwatch-failed'
        : mode === 'native-unavailable'
          ? 'native-command-unavailable'
          : 'channel-yield-failed',
    );
    scope.stop();
  }
});

test('RX overflow during the final Channel yield invalidates otherwise positive drain evidence', async () => {
  const fake = new FakePort();
  fake.channelYieldImpl = async () => {
    fake.handlers?.onData(new Uint8Array(2 * 1024 * 1024 + 1));
  };
  const disconnected = deferred<void>();
  const { connection, scope } = createConnection([fake], {
    onDisconnect: () => disconnected.resolve(),
  });
  assert.equal(await connection.start(), true);

  fake.handlers?.onDisconnect?.('device removed');
  await disconnected.promise;
  const result = await connection.stop();
  assert.equal(result.rxDrainGuarantee, 'not-guaranteed');
  assert.equal(result.rxDrainStatus, 'renderer-overflow');
  assert.ok(connection.totalDroppedBytes.value > 0);
  scope.stop();
});

test('a reconnect lease transition failure stops before opening a replacement port', async () => {
  const leases = new FaultingLeaseClient();
  leases.failReconnectTransition = true;
  const first = new FakePort();
  const replacement = new FakePort();
  const disconnected = deferred<void>();
  const { connection, scope } = createConnection(
    [first, replacement],
    {
      autoReconnect: () => true,
      onDisconnect: () => disconnected.resolve(),
    },
    { leaseClient: leases },
  );
  assert.equal(await connection.start(), true);

  first.handlers?.onDisconnect?.('device removed');
  await disconnected.promise;
  assert.equal(connection.reconnecting.value, false);
  assert.equal(replacement.openCalls, 0);
  assert.equal(leases.registry.size, 0);
  scope.stop();
});

test('a reconnect connected-transition failure closes the replacement and reports disconnect', async () => {
  vi.useFakeTimers();
  try {
    const leases = new FaultingLeaseClient();
    leases.failConnectedTransitionAt = 2;
    const first = new FakePort();
    const replacement = new FakePort();
    const disconnected = deferred<void>();
    const { connection, scope } = createConnection(
      [first, replacement],
      {
        autoReconnect: () => true,
        onDisconnect: () => disconnected.resolve(),
      },
      { leaseClient: leases },
    );
    assert.equal(await connection.start(), true);

    first.handlers?.onDisconnect?.('device removed');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    await disconnected.promise;
    assert.equal(replacement.openCalls, 1);
    assert.equal(replacement.closeCalls, 1);
    assert.equal(connection.reconnecting.value, false);
    assert.equal(connection.isConnected.value, false);
    assert.equal(leases.registry.size, 0);
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('a reconnect open failure with an unclosed candidate stops retrying until explicit cleanup', async () => {
  vi.useFakeTimers();
  try {
    const first = new FakePort();
    const failed = new FakePort();
    failed.openImpl = async () => {
      throw new Error('still unplugged');
    };
    failed.closeImpl = async () => {
      throw new Error('close failed');
    };
    failed.forceCloseImpl = async () => {
      throw new Error('force close failed');
    };
    const disconnected = deferred<void>();
    const { connection, scope } = createConnection(
      [first, failed],
      {
        autoReconnect: () => true,
        onDisconnect: () => disconnected.resolve(),
      },
      { writeCloseGraceMs: 5 },
    );
    assert.equal(await connection.start(), true);

    first.handlers?.onDisconnect?.('device removed');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    await disconnected.promise;
    assert.equal(connection.reconnecting.value, false);
    assert.equal(failed.closeCalls, 1);
    assert.equal(failed.forceCloseCalls, 1);

    failed.closeImpl = async () => undefined;
    assert.equal((await connection.stop()).portClose, 'close-acknowledged');
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('stop can join a pending open that settles inside grace and shares the closing task', async () => {
  const opening = deferred<void>();
  const fake = new FakePort();
  fake.openImpl = () => opening.promise;
  const { connection, scope } = createConnection([fake], {}, { writeCloseGraceMs: 50 });

  const starting = connection.start();
  await Promise.resolve();
  const firstStop = connection.stop();
  const joinedStop = connection.stop();
  opening.resolve();

  assert.equal(await starting, false);
  const [firstResult, joinedResult] = await Promise.all([firstStop, joinedStop]);
  assert.deepEqual(joinedResult, firstResult);
  assert.equal(firstResult.pendingOpen, 'settled');
  assert.equal(firstResult.portClose, 'close-acknowledged');
  scope.stop();
});

test('the default document visibility policy publishes RX in a headless runtime', async () => {
  const fake = new FakePort();
  const { connection, scope, store } = createConnection([fake]);
  assert.equal(await connection.start(), true);

  fake.handlers?.onData(new Uint8Array([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(store.sessions[0].frames.length, 1);

  await connection.stop();
  scope.stop();
});

test('replacement releases the prior port lease and exercises the visible-document publisher', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let visibilityChanged: (() => void) | undefined;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener: (_name: string, callback: () => void) => {
        visibilityChanged = callback;
      },
      removeEventListener: vi.fn(),
    },
  });
  try {
    let portName = 'COM1';
    const first = new FakePort();
    const replacement = new FakePort();
    const leases = new PortLeaseRegistry({ platform: 'windows' });
    const { connection, scope } = createConnection(
      [first, replacement],
      {},
      { leaseClient: leases },
      { portName: () => portName },
    );

    assert.equal(await connection.start(), true);
    visibilityChanged?.();
    portName = 'COM2';
    assert.equal(await connection.start(), true);
    assert.equal(leases.getByPort('COM1'), undefined);
    assert.equal(leases.getByPort('COM2')?.state, 'connected');
    await connection.stop();
    scope.stop();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('stop force-closes after a close timeout', async () => {
  vi.useFakeTimers();
  try {
    const fake = new FakePort();
    fake.closeImpl = () => new Promise<void>(() => undefined);
    const { connection, scope } = createConnection([fake], {}, { writeCloseGraceMs: 5 });
    assert.equal(await connection.start(), true);

    const stopping = connection.stop();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5);
    const result = await stopping;
    assert.equal(result.portClose, 'force-close-acknowledged');
    assert.equal(fake.forceCloseCalls, 1);
    scope.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('a null watch handle and removed session fail closed without losing shutdown evidence', async () => {
  const fake = new FakePort();
  fake.watchImpl = async () => null as unknown as SerialWatchHandleAdapter;
  const clock = fakeTimerScheduler();
  const { connection, scope, store, sessionId } = createConnection(
    [fake],
    {},
    { timerScheduler: clock.scheduler, isDocumentVisible: () => true },
  );
  assert.equal(await connection.start(), true);
  assert.ok(await store.removeSession(sessionId));

  fake.handlers?.onData(new Uint8Array([0x41]));
  clock.runTimer(0);
  const result = await connection.stop();
  assert.equal(result.watch, 'not-installed');
  assert.equal(result.portClose, 'close-acknowledged');
  scope.stop();
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
