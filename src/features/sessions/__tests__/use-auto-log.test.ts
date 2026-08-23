import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import { useAppStore } from '@/features/settings/store/app-store.ts';
import {
  AUTO_LOG_DEBOUNCE_MS,
  AUTO_LOG_IMMEDIATE_FLUSH_BYTES,
  AUTO_LOG_MAX_BATCH_BYTES,
  AUTO_LOG_MAX_BATCH_FRAMES,
  AUTO_LOG_MAX_QUEUED_ENTRIES,
  AutoLogShutdownError,
  autoLogFormatForDisplayMode,
  useAutoLog,
  type AutoLogSessionClient,
  type UseAutoLogDeps,
} from '@/features/sessions/application/use-auto-log.ts';
import type { AutoLogFormat, ExportFramePayload } from '@/features/platform/native/index.ts';
import type { DataFrame, PortConfig } from '@/types/index.ts';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

function withLocalStorageMock<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  const restore = () => {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function frame(direction: 'RX' | 'TX', size: number, id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: new Uint8Array(size).fill(id & 0xff),
  };
}

interface Calls {
  begins: Array<{ token: string; format: AutoLogFormat }>;
  appends: Array<{ logId: string; frames: ExportFramePayload[] }>;
  finishes: string[];
  aborts: string[];
  revoked: string[];
}

type SetupOptions = Omit<UseAutoLogDeps, 'sessionClient'> & {
  client?: Partial<AutoLogSessionClient>;
};

function setup(options: SetupOptions = {}) {
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  const app = useAppStore();
  const sessionId = sessions.createSession('COM1', cfg);
  const calls: Calls = { begins: [], appends: [], finishes: [], aborts: [], revoked: [] };
  let frames = 0;
  let rawBytes = 0;
  const client: AutoLogSessionClient = {
    async begin(token, format) {
      calls.begins.push({ token, format });
      if (options.client?.begin) return options.client.begin(token, format);
      return { logId: `log-${sessionId}` };
    },
    async append(logId, batch) {
      calls.appends.push({ logId, frames: batch });
      if (options.client?.append) return options.client.append(logId, batch);
      frames += batch.length;
      rawBytes += batch.reduce((total, item) => total + item.data.length, 0);
      return { frames, rawBytes };
    },
    async finish(logId) {
      calls.finishes.push(logId);
      await options.client?.finish?.(logId);
    },
    async abort(logId) {
      calls.aborts.push(logId);
      await options.client?.abort?.(logId);
    },
  };
  const auto = useAutoLog({
    ...options,
    sessionClient: client,
    requestTarget:
      options.requestTarget ?? (async (id) => ({ token: `grant-${id}`, displayName: `${id}.txt` })),
    revokeTarget:
      options.revokeTarget ??
      (async (token) => {
        calls.revoked.push(token);
      }),
  });
  return { sessions, app, sessionId, calls, auto };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('useAutoLog: fixed debounce/threshold constants and display format mapping', () => {
  assert.equal(AUTO_LOG_DEBOUNCE_MS, 100);
  assert.equal(AUTO_LOG_IMMEDIATE_FLUSH_BYTES, 64 * 1024);
  assert.equal(autoLogFormatForDisplayMode('HEX'), 'hex');
  assert.equal(autoLogFormatForDisplayMode('HEXASCII'), 'hex');
  assert.equal(autoLogFormatForDisplayMode('ASCII'), 'text');
  assert.equal(autoLogFormatForDisplayMode('UTF8'), 'text');
  assert.equal(autoLogFormatForDisplayMode('ANSI'), 'text');
});

test('useAutoLog: begin consumes the grant once and freezes the selected format', async () => {
  await withLocalStorageMock(async () => {
    const { app, sessionId, calls, auto } = setup({ debounceMs: 10 });
    app.setDisplayMode('HEX');
    assert.equal(await auto.enable(sessionId), `${sessionId}.txt`);
    app.setDisplayMode('ASCII');
    auto.appendFrame(sessionId, frame('RX', 1));
    await auto.disable(sessionId);

    assert.deepEqual(calls.begins, [{ token: `grant-${sessionId}`, format: 'hex' }]);
    assert.equal(calls.appends.length, 1);
    assert.deepEqual(calls.finishes, [`log-${sessionId}`]);
    assert.deepEqual(calls.aborts, []);
    assert.deepEqual(calls.revoked, [], 'a consumed grant is not sent again');
  });
});

test('useAutoLog: a small burst waits for the debounce window', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 30 });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));
    await delay(10);
    assert.equal(calls.appends.length, 0);
    await delay(30);
    assert.equal(calls.appends.length, 1);
    await auto.disable(sessionId);
  });
});

test('useAutoLog: reaching 64 KiB flushes immediately without waiting for debounce', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 1_000 });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', AUTO_LOG_IMMEDIATE_FLUSH_BYTES));
    await flush();
    assert.equal(calls.appends.length, 1);
    await auto.disable(sessionId);
  });
});

test('useAutoLog: batches preserve order and obey frame and raw-byte limits', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 1_000 });
    await auto.enable(sessionId);
    for (let index = 0; index < 5; index += 1) {
      auto.appendFrame(sessionId, frame(index % 2 ? 'TX' : 'RX', 60 * 1024, index));
    }
    await auto.disable(sessionId);

    assert.deepEqual(
      calls.appends.flatMap((call) => call.frames.map((item) => item.id)),
      ['f0', 'f1', 'f2', 'f3', 'f4'],
    );
    assert.ok(calls.appends.every((call) => call.frames.length <= AUTO_LOG_MAX_BATCH_FRAMES));
    assert.ok(
      calls.appends.every(
        (call) =>
          call.frames.reduce((total, item) => total + item.data.length, 0) <=
          AUTO_LOG_MAX_BATCH_BYTES,
      ),
    );
  });
});

test('useAutoLog: appended frames cross IPC over the base64 channel only', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 10 });
    await auto.enable(sessionId);
    const first = frame('RX', 3, 1);
    const second = frame('TX', 2, 2);
    auto.appendFrame(sessionId, first);
    auto.appendFrame(sessionId, second);
    await auto.disable(sessionId);

    const payloads = calls.appends.flatMap((call) => call.frames);
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.deepEqual(payload.data, [], 'legacy number-array channel stays empty');
      assert.equal(typeof payload.dataB64, 'string');
    }
    assert.deepEqual(
      payloads.map((item) => item.dataB64),
      [bytesToBase64(first.data), bytesToBase64(second.data)],
    );
    assert.deepEqual(
      payloads.flatMap((item) => Array.from(base64ToBytes(item.dataB64 ?? ''))),
      [1, 1, 1, 2, 2],
    );
  });
});

test('useAutoLog: the 256-frame cap splits even zero-byte frames', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 1_000 });
    await auto.enable(sessionId);
    for (let index = 0; index <= AUTO_LOG_MAX_BATCH_FRAMES; index += 1) {
      auto.appendFrame(sessionId, frame('RX', 0, index));
    }
    await auto.disable(sessionId);
    assert.deepEqual(
      calls.appends.map((call) => call.frames.length),
      [AUTO_LOG_MAX_BATCH_FRAMES, 1],
    );
  });
});

test('useAutoLog: entry overflow aborts and clears the bounded queue once', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId, calls, auto } = setup({ debounceMs: 1_000 });
    await auto.enable(sessionId);
    for (let index = 0; index <= AUTO_LOG_MAX_QUEUED_ENTRIES; index += 1) {
      auto.appendFrame(sessionId, frame('RX', 0, index));
    }
    await flush();
    assert.equal(calls.appends.length, 0);
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
  });
});

test('useAutoLog: append failure disables and aborts the backend session once', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId, calls, auto } = setup({
      debounceMs: 1,
      client: { append: async () => Promise.reject(new Error('disk full')) },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));
    await delay(10);
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
    assert.deepEqual(calls.finishes, []);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
  });
});

test('useAutoLog: append timeout is terminal and remains bounded', async () => {
  await withLocalStorageMock(async () => {
    const never = new Promise<never>(() => undefined);
    const { sessionId, calls, auto } = setup({
      debounceMs: 1,
      appendTimeoutMs: 5,
      client: { append: async () => never },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));
    await delay(15);
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
    assert.deepEqual(calls.finishes, []);
  });
});

test('useAutoLog: a frame over the backend batch limit aborts before IPC', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({ debounceMs: 1_000 });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', AUTO_LOG_MAX_BATCH_BYTES + 1));
    await flush();
    assert.equal(calls.appends.length, 0);
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
  });
});

test('useAutoLog: graceful disable stops new frames, drains, then finishes', async () => {
  await withLocalStorageMock(async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sessionId, calls, auto } = setup({
      debounceMs: 1_000,
      client: {
        append: async (_logId, batch) => {
          await blocked;
          return {
            frames: batch.length,
            rawBytes: batch.reduce((total, item) => total + item.data.length, 0),
          };
        },
      },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));
    const disabling = auto.disable(sessionId);
    await flush();
    assert.deepEqual(calls.finishes, []);
    auto.appendFrame(sessionId, frame('TX', 1, 2));
    release();
    await disabling;
    assert.equal(calls.appends.length, 1);
    assert.deepEqual(calls.finishes, [`log-${sessionId}`]);
  });
});

test('useAutoLog: strict shutdown propagates native footer, flush, or sync failure', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({
      client: {
        finish: async () => {
          throw new Error('native sync failed');
        },
      },
    });
    await auto.enable(sessionId);

    await assert.rejects(auto.prepareShutdown(sessionId), (error: unknown) => {
      assert.ok(error instanceof AutoLogShutdownError);
      assert.equal(error.stage, 'terminal');
      assert.match(String(error.cause), /native sync failed/);
      return true;
    });
    assert.deepEqual(calls.finishes, [`log-${sessionId}`]);
  });
});

test('useAutoLog: strict shutdown propagates a terminal timeout', async () => {
  await withLocalStorageMock(async () => {
    const never = new Promise<never>(() => undefined);
    const { sessionId, auto } = setup({
      drainTimeoutMs: 50,
      terminalTimeoutMs: 10,
      client: { finish: async () => never },
    });
    await auto.enable(sessionId);

    await assert.rejects(auto.prepareShutdown(sessionId), (error: unknown) => {
      assert.ok(error instanceof AutoLogShutdownError);
      assert.equal(error.stage, 'terminal');
      assert.match(String(error.cause), /operation timed out/);
      return true;
    });
  });
});

test('useAutoLog: strict shutdown propagates queued append failure', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, calls, auto } = setup({
      debounceMs: 1_000,
      client: {
        append: async () => {
          throw new Error('append failed');
        },
      },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));

    await assert.rejects(auto.prepareShutdown(sessionId), (error: unknown) => {
      assert.ok(error instanceof AutoLogShutdownError);
      assert.equal(error.stage, 'append');
      assert.match(String(error.cause), /append failed/);
      return true;
    });
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
  });
});

test('useAutoLog: graceful drain is bounded and late append rejection stays observed', async () => {
  await withLocalStorageMock(async () => {
    const never = new Promise<never>(() => undefined);
    const { sessionId, calls, auto } = setup({
      debounceMs: 1_000,
      drainTimeoutMs: 10,
      client: { append: async () => never },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', 1));
    const started = Date.now();
    await auto.disable(sessionId);
    assert.ok(Date.now() - started < 200, 'disable must honor the configured drain deadline');
    await flush();
    assert.deepEqual(calls.aborts, [`log-${sessionId}`]);
    assert.deepEqual(calls.finishes, []);
  });
});

test('useAutoLog: stale dialog grants are revoked, while stale begun sessions are aborted', async () => {
  await withLocalStorageMock(async () => {
    let resolveDialog!: (grant: SaveTargetGrant) => void;
    const dialog = new Promise<SaveTargetGrant>((resolve) => {
      resolveDialog = resolve;
    });
    const first = setup({ requestTarget: async () => dialog });
    const enabling = first.auto.enable(first.sessionId);
    await first.auto.disable(first.sessionId);
    resolveDialog({ token: 'late-grant', displayName: 'late.txt' });
    assert.equal(await enabling, null);
    assert.deepEqual(first.calls.revoked, ['late-grant']);

    let releaseBegin!: () => void;
    const beginBlocked = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const second = setup({
      client: {
        begin: async () => {
          await beginBlocked;
          return { logId: 'late-log' };
        },
      },
    });
    const secondEnable = second.auto.enable(second.sessionId);
    await flush();
    const disabling = second.auto.disable(second.sessionId);
    releaseBegin();
    assert.equal(await secondEnable, null);
    await disabling;
    assert.deepEqual(second.calls.aborts, ['late-log']);
  });
});

test('useAutoLog: failed grant revocation is contained and never resurrects a stale log', async () => {
  await withLocalStorageMock(async () => {
    let resolveDialog!: (grant: SaveTargetGrant) => void;
    const dialog = new Promise<SaveTargetGrant>((resolve) => {
      resolveDialog = resolve;
    });
    const { sessionId, calls, auto } = setup({
      requestTarget: async () => dialog,
      revokeTarget: async () => {
        throw new Error('revoke unavailable');
      },
      terminalTimeoutMs: 20,
    });
    const enabling = auto.enable(sessionId);
    await auto.disable(sessionId);
    resolveDialog({ token: 'stale-grant', displayName: 'stale.txt' });

    assert.equal(await enabling, null);
    assert.deepEqual(calls.begins, []);
  });
});

test('useAutoLog: a begin failure revokes its unused grant and leaves the store disabled', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId, calls, auto } = setup({
      client: {
        begin: async () => {
          throw new Error('disk unavailable');
        },
      },
    });

    assert.equal(await auto.enable(sessionId), null);
    assert.deepEqual(calls.revoked, [`grant-${sessionId}`]);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
  });
});

test('useAutoLog: external toggle-off drains the active log, and inactive disable just clears the target', async () => {
  await withLocalStorageMock(async () => {
    const active = setup({ debounceMs: 1 });
    await active.auto.enable(active.sessionId);
    active.sessions.setAutoLogTarget(active.sessionId, null);
    active.auto.appendFrame(active.sessionId, frame('RX', 1));
    await delay(10);
    assert.deepEqual(active.calls.finishes, [`log-${active.sessionId}`]);

    const inactive = setup();
    inactive.sessions.setAutoLogTarget(inactive.sessionId, 'old.txt');
    await inactive.auto.disable(inactive.sessionId);
    assert.equal(inactive.sessions.sessions[0].autoLogEnabled, false);
    assert.deepEqual(inactive.calls.finishes, []);
  });
});

test('useAutoLog: a replacement enable that becomes stale during previous cleanup revokes only its new grant', async () => {
  await withLocalStorageMock(async () => {
    let releaseFinish!: () => void;
    const finishBlocked = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    let grantCount = 0;
    const { sessionId, calls, auto } = setup({
      requestTarget: async () => ({ token: `grant-${grantCount++}`, displayName: 'capture.txt' }),
      client: { finish: async () => finishBlocked },
      terminalTimeoutMs: 50,
    });
    await auto.enable(sessionId);
    const replacing = auto.enable(sessionId);
    await flush();
    const disabling = auto.disable(sessionId);
    releaseFinish();

    assert.equal(await replacing, null);
    await disabling;
    assert.deepEqual(calls.revoked, ['grant-1']);
  });
});
