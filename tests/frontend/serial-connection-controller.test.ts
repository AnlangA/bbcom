import { describe, expect, test } from 'vitest';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import {
  createSerialConnectionController,
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
  closeCalls = 0;

  open(): Promise<void> {
    return this.openImpl();
  }
  async watch(handlers: WatchHandlers, _options?: WatchOptions): Promise<SerialWatchHandleAdapter> {
    this.handlers = handlers;
    return new FakeWatch();
  }
  async writeBinary(data: Uint8Array): Promise<number> {
    this.writes.push(data.slice());
    return data.length;
  }
  async writeDataTerminalReady(): Promise<void> {}
  async writeRequestToSend(): Promise<void> {}
  async setBreak(): Promise<void> {}
  async clearBreak(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  async drainNativeInput() {
    return { bytes: [], guaranteed: true, completion: 'idle-gap-observed' as const };
  }
  async yieldQueuedChannelEvents(): Promise<void> {}
  async forceClose(): Promise<void> {}
}

function harness(fake: FakePort) {
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
