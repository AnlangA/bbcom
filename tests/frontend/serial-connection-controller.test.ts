import { describe, expect, test } from 'vitest';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import {
  createSerialConnectionController,
  type SerialConnectionDependencies,
  type SerialConnectionSink,
} from '../../src/features/serial/application/serial-connection-controller';
import { PortLeaseRegistry } from '../../src/features/serial/application/port-lease-registry';
import type { SerialPortAdapter, SerialWatchHandleAdapter } from '../../src/features/serial/index';
import type { DataFrame, PortConfig } from '../../src/types';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 1,
  dtr: false,
  rts: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeWatch implements SerialWatchHandleAdapter {
  async unwatch(): Promise<void> {}
}

class FakePort implements SerialPortAdapter {
  handlers: WatchHandlers | null = null;
  readonly writes: Uint8Array[] = [];
  openImpl: () => Promise<void> = async () => undefined;
  writeImpl: (data: Uint8Array) => Promise<number> = async (data) => data.length;
  closeCalls = 0;
  dtr = false;
  rts = false;
  breakActive = false;
  readonly controlEvents: string[] = [];
  readonly clearBufferCalls: string[] = [];
  pendingRxBytes = 7;
  pendingTxBytes = 3;
  inputLines = { cts: true, dsr: false, ri: true, cd: false };
  dtrImpl: (value: boolean) => Promise<void> = async () => undefined;
  rtsImpl: (value: boolean) => Promise<void> = async () => undefined;
  setBreakImpl: () => Promise<void> = async () => undefined;
  clearBreakImpl: () => Promise<void> = async () => undefined;

  open(): Promise<void> {
    return this.openImpl();
  }
  async watch(handlers: WatchHandlers, _options?: WatchOptions): Promise<SerialWatchHandleAdapter> {
    this.handlers = handlers;
    return new FakeWatch();
  }
  async writeBinary(data: Uint8Array): Promise<number> {
    this.writes.push(data.slice());
    return this.writeImpl(data);
  }
  async writeDataTerminalReady(value: boolean): Promise<void> {
    await this.dtrImpl(value);
    this.dtr = value;
    this.controlEvents.push(`dtr:${String(value)}`);
  }
  async writeRequestToSend(value: boolean): Promise<void> {
    await this.rtsImpl(value);
    this.rts = value;
    this.controlEvents.push(`rts:${String(value)}`);
  }
  async readClearToSend(): Promise<boolean> {
    return this.inputLines.cts;
  }
  async readDataSetReady(): Promise<boolean> {
    return this.inputLines.dsr;
  }
  async readRingIndicator(): Promise<boolean> {
    return this.inputLines.ri;
  }
  async readCarrierDetect(): Promise<boolean> {
    return this.inputLines.cd;
  }
  async setBreak(): Promise<void> {
    await this.setBreakImpl();
    this.breakActive = true;
    this.controlEvents.push('break:true');
  }
  async clearBreak(): Promise<void> {
    await this.clearBreakImpl();
    this.breakActive = false;
    this.controlEvents.push('break:false');
  }
  async bytesToRead(): Promise<number> {
    return this.pendingRxBytes;
  }
  async bytesToWrite(): Promise<number> {
    return this.pendingTxBytes;
  }
  async clearBuffer(selection: 'input' | 'output' | 'all'): Promise<void> {
    this.clearBufferCalls.push(selection);
    if (selection === 'input' || selection === 'all') this.pendingRxBytes = 0;
    if (selection === 'output' || selection === 'all') this.pendingTxBytes = 0;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  async drainNativeInput() {
    return { bytes: [], guaranteed: true, completion: 'idle-gap-observed' as const };
  }
  async yieldQueuedChannelEvents(): Promise<void> {}
  async forceClose(): Promise<void> {}
}

function harness(fake: FakePort, overrides: Partial<SerialConnectionDependencies> = {}) {
  const frames: DataFrame[] = [];
  const rawOrder: string[] = [];
  const sink: SerialConnectionSink = {
    setConnected: (_id, connected) => rawOrder.push(`connected:${connected}`),
    updateDroppedBytes: () => undefined,
    addFrame: (_id, input) => {
      const frame = {
        ...input,
        id: `frame-${frames.length}`,
        timestamp: frames.length,
      } as DataFrame;
      frames.push(frame);
      rawOrder.push(`frame:${input.direction}`);
      return frame;
    },
    publishFrames: () => rawOrder.push('publish'),
    appendAutoLogFrame: () => undefined,
  };
  const controller = createSerialConnectionController('session-a', 'COM1', config, undefined, {
    leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
    sessionName: 'Session A',
    createPort: () => fake,
    sink,
    visibilityPort: { isVisible: () => true },
    writeCloseGraceMs: 1,
    ...overrides,
  });
  return { controller, frames, rawOrder };
}

describe('SerialConnectionController (framework-free)', () => {
  test('owns open, raw-before-display RX, TX and proven stop without Vue or Tauri', async () => {
    const fake = new FakePort();
    const { controller, frames, rawOrder } = harness(fake);
    controller.rawBytes(() => rawOrder.push('raw'));

    await expect(controller.start()).resolves.toBe(true);
    fake.handlers?.onData(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rawOrder.indexOf('raw')).toBeLessThan(rawOrder.indexOf('frame:RX'));
    await expect(controller.sendBytes(new Uint8Array([4, 5]))).resolves.toMatchObject({
      outcome: 'complete',
      sentBytes: 2,
    });
    expect(frames.map((frame) => frame.direction)).toEqual(['RX', 'TX']);

    await expect(controller.stop()).resolves.toMatchObject({
      rxDrainGuarantee: 'guaranteed',
      portClose: 'close-acknowledged',
    });
    expect(controller.snapshot().isConnected).toBe(false);
  });

  test('transaction leases drain physical TX, gate every public writer, and mirror raw RX', async () => {
    const physical = deferred<number>();
    const fake = new FakePort();
    let writeCalls = 0;
    fake.writeImpl = async (data) => {
      writeCalls += 1;
      return writeCalls === 1 ? physical.promise : data.length;
    };
    const { controller } = harness(fake);
    const automationEvents: string[] = [];
    controller.serialTransactions.registerAutomation({
      id: 'test-automation',
      async pause() {
        automationEvents.push('pause');
        return {
          async restore() {
            automationEvents.push('restore');
          },
        };
      },
    });
    await expect(controller.start()).resolves.toBe(true);

    // The lease acquisition closes admission while the first physical chunk
    // is pending; every already-admitted suffix must still drain completely.
    const manual = controller.sendBytes(new Uint8Array(4097));
    const acquisition = controller.serialTransactions.acquire('plugin.test');
    await Promise.resolve();
    expect(controller.serialTransactions.snapshot().phase).toBe('acquiring');
    expect(automationEvents).toEqual([]);
    physical.resolve(4096);
    await expect(manual).resolves.toMatchObject({ outcome: 'complete' });
    const grant = await acquisition;
    expect(automationEvents).toEqual(['pause']);

    await expect(controller.send('manual', false)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'BUSY' },
    });
    await expect(controller.sendBytes(Uint8Array.of(2))).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'BUSY' },
    });
    await expect(controller.sendBreak()).resolves.toBe(false);
    await expect(
      controller.serialTransactions.write(grant.token, Uint8Array.of(3, 4)),
    ).resolves.toMatchObject({ outcome: 'complete', sentBytes: 2 });

    fake.handlers?.onData(Uint8Array.of(9, 8, 7));
    await expect(controller.serialTransactions.read(grant.token, { maxBytes: 2 })).resolves.toEqual(
      Uint8Array.of(9, 8),
    );
    await expect(controller.serialTransactions.read(grant.token, { maxBytes: 2 })).resolves.toEqual(
      Uint8Array.of(7),
    );

    await expect(controller.serialTransactions.release(grant.token)).resolves.toMatchObject({
      restoreSkipped: false,
      restoredAutomations: 1,
    });
    expect(automationEvents).toEqual(['pause', 'restore']);
    await expect(controller.sendBytes(Uint8Array.of(5))).resolves.toMatchObject({
      outcome: 'complete',
    });
    await controller.stop();
  });

  test('native disconnect revokes a transaction before teardown without restoring automation', async () => {
    const fake = new FakePort();
    const { controller } = harness(fake);
    let restored = false;
    controller.serialTransactions.registerAutomation({
      id: 'test-automation',
      async pause() {
        return {
          async restore() {
            restored = true;
          },
        };
      },
    });
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.test');
    const pendingRead = controller.serialTransactions.read(grant.token, { maxBytes: 1 });

    fake.handlers?.onDisconnect();
    await expect(pendingRead).rejects.toMatchObject({ code: 'disconnected' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.serialTransactions.snapshot().phase).toBe('idle');
    expect(restored).toBe(false);
    expect(controller.snapshot().isConnected).toBe(false);
  });

  test('plugin cancellation restores DTR, RTS and Break to the pre-lease state', async () => {
    const fake = new FakePort();
    const { controller } = harness(fake);
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.test');
    await controller.serialTransactions.setOutputLines(grant.token, {
      dtr: true,
      rts: true,
      breakActive: true,
    });
    expect({ dtr: fake.dtr, rts: fake.rts, breakActive: fake.breakActive }).toEqual({
      dtr: true,
      rts: true,
      breakActive: true,
    });

    await expect(controller.serialTransactions.cancel(grant.token)).resolves.toMatchObject({
      restoreFailures: [],
      restoreSkipped: false,
    });
    expect({ dtr: fake.dtr, rts: fake.rts, breakActive: fake.breakActive }).toEqual({
      dtr: false,
      rts: false,
      breakActive: false,
    });
    expect(fake.controlEvents.slice(-3)).toEqual(['dtr:false', 'rts:false', 'break:false']);
    await controller.stop();
  });

  test('exposes native buffer counts, clearing, and modem input lines only through an active lease', async () => {
    const fake = new FakePort();
    const { controller } = harness(fake);
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.mcumgr');

    fake.handlers?.onData(Uint8Array.of(1, 2));
    await expect(controller.serialTransactions.pendingBytes(grant.token)).resolves.toEqual({
      rx: 9,
      tx: 3,
    });
    await expect(controller.serialTransactions.readInputLines(grant.token)).resolves.toEqual({
      cts: true,
      dsr: false,
      ri: true,
      cd: false,
    });

    await controller.serialTransactions.clearBuffers(grant.token, 'output');
    await expect(controller.serialTransactions.pendingBytes(grant.token)).resolves.toEqual({
      rx: 9,
      tx: 0,
    });
    await controller.serialTransactions.clearBuffers(grant.token, 'input');
    await expect(controller.serialTransactions.pendingBytes(grant.token)).resolves.toEqual({
      rx: 0,
      tx: 0,
    });
    expect(fake.clearBufferCalls).toEqual(['output', 'input']);

    await controller.serialTransactions.setOutputLines(grant.token, {
      dtr: true,
      rts: true,
      breakActive: false,
    });
    await controller.serialTransactions.setOutputLines(grant.token, {
      dtr: false,
      rts: false,
      breakActive: true,
    });
    await expect(controller.serialTransactions.release(grant.token)).resolves.toMatchObject({
      restoreFailures: [],
      restoreSkipped: false,
    });
    await controller.stop();
  });

  test('fails closed when the serial backend does not expose optional transaction operations', async () => {
    const fake = new FakePort();
    Object.defineProperties(fake, {
      bytesToRead: { value: undefined },
      bytesToWrite: { value: undefined },
      clearBuffer: { value: undefined },
      readCarrierDetect: { value: undefined },
    });
    const { controller } = harness(fake);
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.mcumgr');

    await expect(controller.serialTransactions.clearBuffers(grant.token)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(controller.serialTransactions.pendingBytes(grant.token)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(controller.serialTransactions.readInputLines(grant.token)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await controller.serialTransactions.release(grant.token);
    await controller.stop();
  });

  test('keeps automation paused when restoring any physical output line fails', async () => {
    const fake = new FakePort();
    const { controller } = harness(fake);
    let restored = false;
    controller.serialTransactions.registerAutomation({
      id: 'test-automation',
      async pause() {
        return {
          async restore() {
            restored = true;
          },
        };
      },
    });
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.mcumgr');
    await controller.serialTransactions.setOutputLines(grant.token, {
      dtr: true,
      rts: true,
      breakActive: true,
    });
    fake.dtrImpl = async (value) => {
      if (!value) throw new Error('driver refused DTR restore');
    };

    await expect(controller.serialTransactions.cancel(grant.token)).resolves.toMatchObject({
      restoreFailures: ['serial.control-lines'],
      restoreSkipped: true,
    });
    expect(restored).toBe(false);
    expect(fake.controlEvents.slice(-2)).toEqual(['rts:false', 'break:false']);
    await controller.stop();
  });

  test('replacing a connected port revokes its transaction before opening the successor', async () => {
    const first = new FakePort();
    const replacement = new FakePort();
    const ports = [first, replacement];
    const automationEvents: string[] = [];
    const controller = createSerialConnectionController(
      'session-replace',
      'COM11',
      config,
      undefined,
      {
        leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
        sessionName: 'Replacement',
        createPort: () => ports.shift()!,
        sink: {
          setConnected: () => undefined,
          updateDroppedBytes: () => undefined,
          addFrame: () => undefined,
          publishFrames: () => undefined,
          appendAutoLogFrame: () => undefined,
        },
        writeCloseGraceMs: 1,
      },
    );
    controller.serialTransactions.registerAutomation({
      id: 'macro',
      async pause() {
        automationEvents.push('pause');
        return {
          async restore() {
            automationEvents.push('restore');
          },
        };
      },
    });

    expect(await controller.start()).toBe(true);
    await controller.serialTransactions.acquire('plugin.mcumgr');
    expect(await controller.start()).toBe(true);
    expect(automationEvents).toEqual(['pause']);
    expect(replacement.handlers).not.toBeNull();
    await controller.stop();
  });

  test('a break that finishes after stop never mutates the detached connection generation', async () => {
    const fake = new FakePort();
    const breakDelay = deferred<void>();
    const { controller } = harness(fake, {
      timerPort: {
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        delay: () => breakDelay.promise,
      },
    });
    await controller.start();

    const sendingBreak = controller.sendBreak(250);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.breakActive).toBe(true);
    await controller.stop();
    breakDelay.resolve();

    await expect(sendingBreak).resolves.toBe(false);
    expect(fake.breakActive).toBe(false);
  });

  test('RX mirror overflow revokes the lease but preserves terminal and capture bytes', async () => {
    const fake = new FakePort();
    const { controller, frames } = harness(fake);
    const raw: number[][] = [];
    controller.rawBytes((bytes) => raw.push(Array.from(bytes)));
    await controller.start();
    const grant = await controller.serialTransactions.acquire('plugin.test', {
      rxBufferBytes: 2,
    });

    fake.handlers?.onData(Uint8Array.of(1, 2, 3));
    await expect(
      controller.serialTransactions.read(grant.token, { maxBytes: 1 }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(raw).toEqual([[1, 2, 3]]);
    expect(
      frames.filter((frame) => frame.direction === 'RX').map((frame) => [...frame.data]),
    ).toEqual([[1, 2, 3]]);
    expect(controller.serialTransactions.snapshot()).toMatchObject({
      phase: 'idle',
      faultCode: 'limit-exceeded',
    });
    await controller.stop();
  });

  test('invalidates a pending open and never publishes a stale connected state', async () => {
    const opening = deferred<void>();
    const fake = new FakePort();
    fake.openImpl = () => opening.promise;
    const { controller, rawOrder } = harness(fake);
    const starting = controller.start();
    await Promise.resolve();

    await expect(controller.stop()).resolves.toMatchObject({ pendingOpen: 'unsettled' });
    opening.resolve();
    await expect(starting).resolves.toBe(false);
    expect(rawOrder).not.toContain('connected:true');
    expect(controller.snapshot().isConnected).toBe(false);
    expect(fake.closeCalls).toBe(1);
  });

  test('uses headless visibility defaults and tolerates sinks that decline RX and TX frames', async () => {
    const first = new FakePort();
    const replacement = new FakePort();
    const ports = [first, replacement];
    const connectionStates: boolean[] = [];
    const controller = createSerialConnectionController(
      'session-headless',
      'COM9',
      config,
      undefined,
      {
        leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
        sessionName: 'Headless',
        createPort: () => ports.shift()!,
        sink: {
          setConnected: (_id, connected) => {
            connectionStates.push(connected);
            // A native disconnect can arrive synchronously with replacement
            // teardown, before the shared shutdown task has been installed.
            if (!connected) first.handlers?.onDisconnect();
          },
          updateDroppedBytes: () => undefined,
          addFrame: (_id, input) =>
            input.direction === 'RX'
              ? ({ ...input, id: 'rx-headless', timestamp: 1 } as DataFrame)
              : undefined,
          publishFrames: () => undefined,
          appendAutoLogFrame: () => undefined,
        },
      },
    );
    const snapshots: boolean[] = [];
    const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot.isConnected));

    expect(await controller.start()).toBe(true);
    first.handlers?.onData('OK');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await controller.sendBytes(new Uint8Array([1]))).toMatchObject({
      outcome: 'complete',
      sentBytes: 1,
    });
    expect(await controller.start()).toBe(true);
    expect(await controller.stop()).toMatchObject({ portClose: 'close-acknowledged' });
    unsubscribe();
    expect(connectionStates).toContain(true);
    expect(snapshots).toContain(true);
  });

  test('ignores a reconnect timer callback delivered after explicit cancellation', async () => {
    const first = new FakePort();
    const replacement = new FakePort();
    const ports = [first, replacement];
    let scheduled: (() => void) | null = null;
    const controller = createSerialConnectionController(
      'session-reconnect-cancel',
      'COM10',
      config,
      { autoReconnect: () => true },
      {
        leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
        sessionName: 'Reconnect cancellation',
        createPort: () => ports.shift()!,
        sink: {
          setConnected: () => undefined,
          updateDroppedBytes: () => undefined,
          addFrame: () => undefined,
          publishFrames: () => undefined,
          appendAutoLogFrame: () => undefined,
        },
        timerPort: {
          schedule: (callback) => {
            scheduled = callback;
            return callback;
          },
          cancel: () => undefined,
          delay: async () => undefined,
        },
      },
    );

    expect(await controller.start()).toBe(true);
    first.handlers?.onDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).not.toBeNull();
    await controller.stop();
    scheduled?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement.handlers).toBeNull();
    expect(controller.snapshot().reconnecting).toBe(false);
  });
});
