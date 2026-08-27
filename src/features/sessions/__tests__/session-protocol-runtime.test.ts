import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import { useSerialConnection } from '@/features/sessions/application/use-serial-connection.ts';
import {
  SessionProtocolRuntime,
  type SessionProtocolExpiryScheduler,
  type SessionProtocolReplayScheduler,
} from '@/features/sessions/runtime/session-protocol-runtime.ts';
import type { SerialPortAdapter, SerialWatchHandleAdapter } from '@/features/serial/index.ts';
import type { SerialTimerScheduler } from '@/lib/serial-rx-scheduler.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import type { PortConfig } from '@/types/serial.ts';
import { PortLeaseRegistry } from '@/features/serial/application/port-lease-registry.ts';
import type { ByteParserConfig } from '@/lib/protocol-parser.ts';

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

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function parsedText(runtime: SessionProtocolRuntime): string[] {
  return runtime.snapshot().frames.map((frame) => new TextDecoder().decode(frame.data));
}

function rawSmpMessage(op: 0 | 1 | 2 | 3, sequence: number): Uint8Array {
  // SMP v2, OS group / echo command, with an empty-map CBOR payload.
  return Uint8Array.of(0x08 | op, 0, 0, 1, 0, 0, sequence, 0, 0xa0);
}

function fakeReplayScheduler() {
  const queued: Array<{ callback: () => void; cancelled: boolean }> = [];
  const scheduler: SessionProtocolReplayScheduler = {
    schedule(callback) {
      const entry = { callback, cancelled: false };
      queued.push(entry);
      return entry;
    },
    cancel(handle) {
      (handle as (typeof queued)[number]).cancelled = true;
    },
    now: () => 0,
  };
  return {
    scheduler,
    queued,
    drain() {
      while (queued.length > 0) {
        const entry = queued.shift();
        if (entry && !entry.cancelled) entry.callback();
      }
    },
  };
}

function fakeExpiryScheduler() {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  let now = 0;
  const scheduler: SessionProtocolExpiryScheduler = {
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) {
      (handle as (typeof timers)[number]).cancelled = true;
    },
    now: () => now,
  };
  return {
    scheduler,
    timers,
    fireNext(extraDelay = 0) {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer);
      timer.cancelled = true;
      now += timer.delay + extraDelay;
      timer.callback();
    },
  };
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
      leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
      sessionName: 'COM1',
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

  // The configurable capture drain remains pending. No frame was materialized for a
  // terminal component, but the long-lived raw-byte parser already emitted a
  // complete protocol frame.
  assert.equal(store.sessions[0].frames.length, 0);
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].delay, 5);
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

test('legacy byte parsers expose the shared protocol record fields', () => {
  const parser = new SessionProtocolRuntime();
  parser.configure({ kind: 'fixed', frameSize: 2 });
  parser.feed(bytes('ABCD'), 1_234);

  const records = parser.snapshot().frames;
  assert.deepEqual(
    records.map((record) => ({
      kind: record.kind,
      parserKind: record.kind === 'bytes' ? record.parserKind : undefined,
      id: record.id,
      direction: record.direction,
      timestamp: record.timestamp,
      length: record.length,
      offset: record.offset,
      endOffset: record.endOffset,
      status: record.status,
      diagnostics: record.diagnostics,
    })),
    [
      {
        kind: 'bytes',
        parserKind: 'fixed',
        id: 'bytes-1',
        direction: 'RX',
        timestamp: 1_234,
        length: 2,
        offset: 0,
        endOffset: 2,
        status: 'ok',
        diagnostics: [],
      },
      {
        kind: 'bytes',
        parserKind: 'fixed',
        id: 'bytes-2',
        direction: 'RX',
        timestamp: 1_234,
        length: 2,
        offset: 2,
        endOffset: 4,
        status: 'ok',
        diagnostics: [],
      },
    ],
  );
});

test('delimiter, fixed, and length modes all replay RX history without consuming TX', () => {
  const cases: Array<{
    config: ByteParserConfig;
    first: Uint8Array;
    second: Uint8Array;
    expected: number[][];
  }> = [
    {
      config: { kind: 'delimiter', delimiter: [0x0a], includeDelimiter: false },
      first: bytes('A'),
      second: bytes('\nB\n'),
      expected: [[0x41], [0x42]],
    },
    {
      config: { kind: 'fixed', frameSize: 2 },
      first: Uint8Array.of(1),
      second: Uint8Array.of(2, 3, 4),
      expected: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      config: {
        kind: 'length',
        lengthOffset: 0,
        lengthSize: 1,
        bigEndian: true,
        lengthAdjust: 1,
      },
      first: Uint8Array.of(1),
      second: Uint8Array.of(0x41, 1, 0x42),
      expected: [
        [1, 0x41],
        [1, 0x42],
      ],
    },
  ];

  for (const scenario of cases) {
    const runtime = new SessionProtocolRuntime();
    runtime.configure(scenario.config, [
      { direction: 'RX', data: scenario.first, timestamp: 100, captureSeq: 1 },
      { direction: 'TX', data: bytes('ignored\n'), timestamp: 150, captureSeq: 2 },
      { direction: 'RX', data: scenario.second, timestamp: 200, captureSeq: 3 },
    ]);

    const records = runtime.snapshot().frames;
    assert.deepEqual(
      records.map((record) => Array.from(record.data)),
      scenario.expected,
      scenario.config.kind,
    );
    assert.deepEqual(
      records.map((record) => record.offset),
      [0, 2],
      scenario.config.kind,
    );
    assert.ok(records.every((record) => record.kind === 'bytes'));
    assert.ok(
      records.every(
        (record) => record.kind === 'bytes' && record.parserKind === scenario.config.kind,
      ),
    );
    assert.ok(records.every((record) => record.captureSeq === 3 && record.timestamp === 200));
  }
});

test('resident protocol parser can explicitly Apply an unchanged configuration', () => {
  const parser = new SessionProtocolRuntime();
  const fixed = { kind: 'fixed' as const, frameSize: 2 };
  parser.configure(fixed);
  parser.feed(bytes('AB'), 1_000);
  assert.deepEqual(parsedText(parser), ['AB']);

  assert.equal(
    parser.configure(fixed, [{ direction: 'RX', data: bytes('CD') }], {
      replayHistory: false,
      force: true,
    }),
    true,
  );
  assert.deepEqual(parsedText(parser), [], 'forced Apply clears without replay when disabled');

  parser.configure(fixed, [{ direction: 'RX', data: bytes('EF') }], {
    replayHistory: true,
    force: true,
  });
  assert.deepEqual(parsedText(parser), ['EF']);
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

test('resident protocol parser bounds retained frames and preserves immutable tail snapshots', () => {
  const parser = new SessionProtocolRuntime({ maxFrames: 3, maxBytes: 64 });
  parser.configure({ kind: 'fixed', frameSize: 1 });

  parser.feed(new Uint8Array([1, 2, 3]), 1_000);
  const firstSnapshot = parser.snapshot();
  parser.feed(new Uint8Array([4, 5]), 1_100);
  const boundedSnapshot = parser.snapshot();

  assert.deepEqual(
    firstSnapshot.frames.map((frame) => frame.data[0]),
    [1, 2, 3],
    'a published snapshot must not be mutated by later eviction',
  );
  assert.deepEqual(
    boundedSnapshot.frames.map((frame) => frame.data[0]),
    [3, 4, 5],
  );
  assert.equal(boundedSnapshot.droppedFrames, 2);
  assert.equal(boundedSnapshot.droppedBytes, 2);

  // Drive multiple head-prefix compactions; retention and counters must remain
  // correct after the backing array is sliced in batches.
  parser.feed(
    Uint8Array.from({ length: 20 }, (_, index) => index + 6),
    1_200,
  );
  const compactedSnapshot = parser.snapshot();
  assert.deepEqual(
    compactedSnapshot.frames.map((frame) => frame.data[0]),
    [23, 24, 25],
  );
  assert.equal(compactedSnapshot.droppedFrames, 22);
  assert.equal(compactedSnapshot.droppedBytes, 22);
});

test('resident protocol parser applies a byte limit and resets drop accounting', () => {
  const parser = new SessionProtocolRuntime({ maxFrames: 10, maxBytes: 5 });
  parser.configure({ kind: 'fixed', frameSize: 3 });
  parser.feed(new Uint8Array([1, 2, 3, 4, 5, 6]), 1_000);

  assert.deepEqual(
    parser.snapshot().frames.map((frame) => Array.from(frame.data)),
    [[4, 5, 6]],
  );
  assert.equal(parser.snapshot().droppedFrames, 1);
  assert.equal(parser.snapshot().droppedBytes, 3);

  parser.configure({ kind: 'fixed', frameSize: 2 });
  assert.deepEqual(parser.snapshot(), {
    frames: [],
    droppedFrames: 0,
    droppedBytes: 0,
    throughputBps: 0,
    resetVersion: 2,
  });

  parser.feed(new Uint8Array([7, 8, 9, 10, 11, 12]), 1_100);
  assert.equal(parser.snapshot().droppedFrames, 1);
  parser.clear();
  const cleared = parser.snapshot();
  assert.deepEqual(cleared.frames, []);
  assert.equal(cleared.droppedFrames, 0);
  assert.equal(cleared.droppedBytes, 0);
});

test('resident protocol parser rejects invalid injected limits', () => {
  assert.throws(() => new SessionProtocolRuntime({ maxFrames: 0 }), RangeError);
  assert.throws(
    () => new SessionProtocolRuntime({ maxBytes: Number.POSITIVE_INFINITY }),
    RangeError,
  );
});

test('SMP history replay is asynchronous, capture ordered, and excludes MCUmgr trace', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({
    replayScheduler: replay.scheduler,
    replayFramesPerSlice: 1,
  });
  let changes = 0;
  parser.onChange(() => {
    changes += 1;
  });

  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [
      {
        id: 'legacy-without-origin',
        captureSeq: 0,
        direction: 'RX',
        timestamp: 5,
        data: rawSmpMessage(1, 0),
      },
      {
        id: 'late-tx',
        captureSeq: 3,
        direction: 'TX',
        origin: 'serial-tx',
        timestamp: 30,
        data: rawSmpMessage(0, 3),
      },
      {
        id: 'trace',
        captureSeq: 2,
        direction: 'RX',
        origin: 'mcumgr-trace',
        timestamp: 20,
        data: rawSmpMessage(1, 2),
      },
      {
        id: 'early-rx',
        captureSeq: 1,
        direction: 'RX',
        origin: 'serial-rx',
        timestamp: 10,
        data: rawSmpMessage(1, 1),
      },
    ],
  );

  assert.deepEqual(parser.snapshot().frames, [], 'history must not block Apply');
  replay.drain();

  const records = parser.snapshot().frames;
  const diagnostics = records.filter((record) => !('header' in record) || !record.header);
  assert.equal(diagnostics.length, 1, 'originless history produces one aggregated warning');
  assert.equal(diagnostics[0].diagnostics[0]?.code, 'smp.runtime.untrusted-origin');
  const messages = records.filter((record) => 'header' in record && record.header);
  assert.deepEqual(
    messages.map((record) => record.captureSeq),
    [1, 3],
  );
  assert.deepEqual(
    messages.map((record) => ('direction' in record ? record.direction : undefined)),
    ['RX', 'TX'],
  );
  assert.ok(changes > 0, 'time-sliced replay publishes progress');
});

test('SMP ignores a cancelled replay callback after a newer generation is scheduled', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({
    replayScheduler: replay.scheduler,
    replayFramesPerSlice: 1,
  });
  const config = {
    kind: 'mcumgr-smp' as const,
    transport: 'raw-uart' as const,
    maxPacketBytes: 1024,
    reassemblyTimeoutMs: 3000,
  };
  parser.configure(config, [
    {
      captureSeq: 1,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 10,
      data: rawSmpMessage(1, 1),
    },
  ]);
  const stale = replay.queued[0];
  assert.ok(stale);

  parser.configure(
    config,
    [
      {
        captureSeq: 2,
        direction: 'TX',
        origin: 'serial-tx',
        timestamp: 20,
        data: rawSmpMessage(0, 2),
      },
    ],
    { force: true },
  );
  stale.callback();
  replay.drain();

  assert.deepEqual(
    parser.snapshot().frames.map((record) => record.captureSeq),
    [2],
  );
});

test('SMP wall timer flushes a silent partial transport without waiting for another frame', () => {
  const expiry = fakeExpiryScheduler();
  const parser = new SessionProtocolRuntime({ expiryScheduler: expiry.scheduler });
  let changes = 0;
  parser.onChange(() => {
    changes += 1;
  });
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 100,
    },
    [],
    { replayHistory: false },
  );
  const packet = rawSmpMessage(1, 8);
  parser.syncCaptureTimeline([
    {
      captureSeq: 0,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 1_000,
      data: packet.subarray(0, 5),
    },
  ]);
  assert.equal(expiry.timers.at(-1)?.delay, 100);
  expiry.fireNext();
  const records = parser.snapshot().frames;
  assert.equal(records.length, 1);
  assert.equal(records[0].diagnostics?.[0]?.code, 'smp.raw.timeout');
  assert.ok(changes > 0);
});

test('SMP delayed wall timer expires every parser state already past its deadline', () => {
  const expiry = fakeExpiryScheduler();
  const parser = new SessionProtocolRuntime({ expiryScheduler: expiry.scheduler });
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 100,
    },
    [],
    { replayHistory: false },
  );
  const response = rawSmpMessage(1, 9);
  parser.syncCaptureTimeline([
    {
      captureSeq: 0,
      direction: 'TX',
      origin: 'serial-tx',
      timestamp: 1_000,
      data: rawSmpMessage(0, 9),
    },
    {
      captureSeq: 1,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 1_000,
      data: response.subarray(0, 5),
    },
  ]);

  expiry.fireNext(30_000);
  const records = parser.snapshot().frames;
  const request = records.find((record) => 'header' in record && record.header?.op === 0);
  assert.equal(request?.status, 'warning');
  assert.ok(
    request?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'smp.transaction.unmatched-request',
    ),
  );
  assert.ok(records.some((record) => record.diagnostics?.[0]?.code === 'smp.raw.timeout'));
});

test('SMP ignores a cancelled expiry callback after a newer timer is armed', () => {
  const expiry = fakeExpiryScheduler();
  const parser = new SessionProtocolRuntime({ expiryScheduler: expiry.scheduler });
  const config = {
    kind: 'mcumgr-smp' as const,
    transport: 'raw-uart' as const,
    maxPacketBytes: 1024,
    reassemblyTimeoutMs: 100,
  };
  const packet = rawSmpMessage(1, 5);
  parser.configure(config, [], { replayHistory: false });
  parser.syncCaptureTimeline([
    {
      captureSeq: 0,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 1_000,
      data: packet.subarray(0, 4),
    },
  ]);
  const stale = expiry.timers[0];
  assert.ok(stale);

  parser.configure(config, [], { replayHistory: false, force: true });
  parser.syncCaptureTimeline([
    {
      captureSeq: 1,
      direction: 'TX',
      origin: 'serial-tx',
      timestamp: 2_000,
      data: packet.subarray(0, 4),
    },
  ]);
  stale.callback();
  expiry.fireNext();

  const records = parser.snapshot().frames;
  assert.equal(records.length, 1);
  assert.equal(records[0].direction, 'TX');
  assert.equal(records[0].diagnostics?.[0]?.code, 'smp.raw.timeout');
});

test('SMP keeps TX and RX reassembly independent while consuming the capture timeline', () => {
  const parser = new SessionProtocolRuntime();
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [],
    { replayHistory: false },
  );
  const tx = rawSmpMessage(0, 7);
  const rx = rawSmpMessage(1, 7);

  parser.syncCaptureTimeline([
    { captureSeq: 0, direction: 'TX', origin: 'serial-tx', timestamp: 100, data: tx.slice(0, 4) },
    { captureSeq: 1, direction: 'RX', origin: 'serial-rx', timestamp: 101, data: rx.slice(0, 5) },
    { captureSeq: 2, direction: 'TX', origin: 'serial-tx', timestamp: 102, data: tx.slice(4) },
    { captureSeq: 3, direction: 'RX', origin: 'serial-rx', timestamp: 103, data: rx.slice(5) },
  ]);

  assert.deepEqual(
    parser.snapshot().frames.map((record) => ({
      captureSeq: record.captureSeq,
      direction: 'direction' in record ? record.direction : undefined,
    })),
    [
      { captureSeq: 0, direction: 'TX' },
      { captureSeq: 1, direction: 'RX' },
    ],
  );
});

test('SMP disabled history replay records the current boundary and only consumes newer capture', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({ replayScheduler: replay.scheduler });
  const oldFrame = {
    id: 'old',
    captureSeq: 4,
    direction: 'RX' as const,
    origin: 'serial-rx' as const,
    timestamp: 100,
    data: rawSmpMessage(1, 4),
  };
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [oldFrame],
    { replayHistory: false },
  );
  replay.drain();
  assert.deepEqual(parser.snapshot().frames, []);

  parser.syncCaptureTimeline([
    oldFrame,
    {
      id: 'new',
      captureSeq: 5,
      direction: 'TX',
      origin: 'serial-tx',
      timestamp: 110,
      data: rawSmpMessage(0, 5),
    },
  ]);
  assert.deepEqual(
    parser.snapshot().frames.map((record) => record.captureSeq),
    [5],
  );
});

test('SMP capture sequence discontinuity starts a fresh cancellable generation', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({ replayScheduler: replay.scheduler });
  const first = {
    id: 'first',
    captureSeq: 0,
    direction: 'RX' as const,
    origin: 'serial-rx' as const,
    timestamp: 100,
    data: rawSmpMessage(1, 0),
  };
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [first],
    { replayHistory: false },
  );

  parser.syncCaptureTimeline([
    first,
    {
      id: 'after-gap',
      captureSeq: 2,
      direction: 'TX',
      origin: 'serial-tx',
      timestamp: 120,
      data: rawSmpMessage(0, 2),
    },
  ]);
  assert.deepEqual(parser.snapshot().frames, []);
  replay.drain();
  assert.deepEqual(
    parser.snapshot().frames.map((record) => record.captureSeq),
    [0, 2],
  );
});

test('SMP detects a capture sequence gap inside one appended batch', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({ replayScheduler: replay.scheduler });
  const first = {
    id: 'first',
    captureSeq: 0,
    direction: 'RX' as const,
    origin: 'serial-rx' as const,
    timestamp: 100,
    data: rawSmpMessage(1, 0),
  };
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [first],
    { replayHistory: false },
  );
  const beforeReset = parser.snapshot().resetVersion;
  parser.syncCaptureTimeline([
    first,
    {
      id: 'one',
      captureSeq: 1,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 110,
      data: rawSmpMessage(1, 1),
    },
    {
      id: 'three',
      captureSeq: 3,
      direction: 'RX',
      origin: 'serial-rx',
      timestamp: 130,
      data: rawSmpMessage(1, 3),
    },
  ]);
  assert.ok(parser.snapshot().resetVersion > beforeReset);
  replay.drain();
  assert.deepEqual(
    parser.snapshot().frames.map((record) => record.captureSeq),
    [0, 1, 3],
  );
});

test('SMP abandons a replay that exceeds the bounded live backlog and cancels stale work', () => {
  const replay = fakeReplayScheduler();
  const parser = new SessionProtocolRuntime({
    replayScheduler: replay.scheduler,
    replayFramesPerSlice: 1,
    maxLiveReplayBacklogBytes: 8,
  });
  const history = {
    id: 'history',
    captureSeq: 1,
    direction: 'RX' as const,
    origin: 'serial-rx' as const,
    timestamp: 100,
    data: rawSmpMessage(1, 1),
  };
  parser.configure(
    {
      kind: 'mcumgr-smp',
      transport: 'raw-uart',
      maxPacketBytes: 1024,
      reassemblyTimeoutMs: 3000,
    },
    [history],
  );
  parser.syncCaptureTimeline([
    history,
    {
      id: 'live',
      captureSeq: 2,
      direction: 'TX',
      origin: 'serial-tx',
      timestamp: 110,
      data: rawSmpMessage(0, 2),
    },
  ]);
  replay.drain();

  const records = parser.snapshot().frames;
  assert.equal(records.length, 1);
  assert.equal(records[0].diagnostics?.[0]?.code, 'smp.runtime.replay-backlog');
  assert.equal(
    records.some(
      (record) =>
        'header' in record && record.header && (record.captureSeq === 1 || record.captureSeq === 2),
    ),
    false,
    'cancelled history and over-limit live backlog must not be synchronously replayed',
  );
});
