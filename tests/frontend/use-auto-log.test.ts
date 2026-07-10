import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { useAppStore } from '../../src/stores/app.ts';
import {
  AUTO_LOG_MAX_BATCH_BYTES,
  AUTO_LOG_MAX_QUEUED_ENTRIES,
  useAutoLog,
  type UseAutoLogDeps,
} from '../../src/composables/useAutoLog.ts';
import type { DataFrame, PortConfig } from '../../src/types/index.ts';

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
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          restore();
          return value;
        },
        (error) => {
          restore();
          throw error;
        },
      );
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function frame(direction: 'RX' | 'TX', data: number[], id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction,
    data: new Uint8Array(data),
  };
}

function setup(deps: UseAutoLogDeps = {}) {
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  const app = useAppStore();
  const sessionId = sessions.createSession('COM1', cfg);
  const writes: Array<{ token: string; line: string }> = [];
  const revoked: string[] = [];
  const auto = useAutoLog({
    ...deps,
    appendLog:
      deps.appendLog ??
      (async (token, line) => {
        writes.push({ token, line });
      }),
    requestTarget:
      deps.requestTarget ??
      (async (id) => ({ token: `grant-${id}`, displayPath: `/tmp/${id}.txt` })),
    revokeTarget:
      deps.revokeTarget ??
      (async (token) => {
        revoked.push(token);
      }),
  });
  return { sessions, app, sessionId, writes, revoked, auto };
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test('useAutoLog: appendFrame is a no-op until a log target is set', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, writes, auto } = setup();
    auto.appendFrame(sessionId, frame('RX', [0x41]));
    await flush();
    assert.equal(writes.length, 0);
  });
});

test('useAutoLog: synchronous frames are batched in original order', async () => {
  await withLocalStorageMock(async () => {
    const { app, sessionId, writes, auto } = setup();
    await auto.enable(sessionId);
    app.setDisplayMode('ASCII');

    auto.appendFrame(sessionId, frame('RX', [0x41, 0x42], 1));
    auto.appendFrame(sessionId, frame('TX', [0x43], 2));
    await auto.disable(sessionId);

    assert.equal(writes.length, 1, 'one synchronous burst becomes one IPC batch');
    assert.equal(writes[0].token, `grant-${sessionId}`);
    assert.equal(writes[0].line.includes('AB'), true);
    assert.equal(writes[0].line.includes('C'), true);
    assert.ok(writes[0].line.indexOf('RX') < writes[0].line.indexOf('TX'));
  });
});

test('useAutoLog: disable stops new frames and drains accepted frames before revoke', async () => {
  await withLocalStorageMock(async () => {
    let finishAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => {
      finishAppend = resolve;
    });
    const { sessions, sessionId, revoked, auto } = setup({
      appendLog: async () => appendBlocked,
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', [0x41]));

    let disableResolved = false;
    const disabling = auto.disable(sessionId).then(() => {
      disableResolved = true;
    });
    auto.appendFrame(sessionId, frame('RX', [0x42], 2));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(disableResolved, false);
    assert.deepEqual(revoked, []);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);

    finishAppend();
    await disabling;
    assert.deepEqual(revoked, [`grant-${sessionId}`]);
  });
});

test('useAutoLog: permanent append failure disables, clears, and revokes once', async () => {
  await withLocalStorageMock(async () => {
    let appendAttempts = 0;
    const { sessions, sessionId, revoked, auto } = setup({
      appendLog: async () => {
        appendAttempts += 1;
        throw new Error('disk full');
      },
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', [0x41]));
    auto.appendFrame(sessionId, frame('RX', [0x42], 2));
    await auto.disable(sessionId);
    auto.appendFrame(sessionId, frame('RX', [0x43], 3));

    assert.equal(appendAttempts, 1);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
    assert.equal(sessions.sessions[0].logPath, null);
    assert.deepEqual(revoked, [`grant-${sessionId}`]);
  });
});

test('useAutoLog: independent sessions have independent workers', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId: firstId, writes, auto } = setup();
    const secondId = sessions.createSession('COM2', cfg);
    await auto.enable(firstId);
    await auto.enable(secondId);
    auto.appendFrame(firstId, frame('RX', [1]));
    auto.appendFrame(secondId, frame('RX', [2]));
    await Promise.all([auto.disable(firstId), auto.disable(secondId)]);

    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((write) => write.token).sort(),
      [`grant-${firstId}`, `grant-${secondId}`].sort(),
    );
  });
});

test('useAutoLog: opaque token is used for writes while only display path reaches the store', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId, writes, auto } = setup();
    const displayPath = await auto.enable(sessionId);
    assert.equal(displayPath, `/tmp/${sessionId}.txt`);
    assert.equal(sessions.sessions[0].logPath, displayPath);
    auto.appendFrame(sessionId, frame('RX', [0x41]));
    await auto.disable(sessionId);
    assert.equal(writes[0].token, `grant-${sessionId}`);
    assert.notEqual(writes[0].token, displayPath);
  });
});

test('useAutoLog: disable invalidates deferred dialog and revokes its late grant', async () => {
  await withLocalStorageMock(async () => {
    let resolveDialog!: (grant: { token: string; displayPath: string }) => void;
    const dialog = new Promise<{ token: string; displayPath: string }>((resolve) => {
      resolveDialog = resolve;
    });
    const { sessions, sessionId, revoked, auto } = setup({
      requestTarget: async () => dialog,
    });

    const enabling = auto.enable(sessionId);
    await auto.disable(sessionId);
    resolveDialog({ token: 'late-grant', displayPath: '/tmp/late.txt' });

    assert.equal(await enabling, null);
    assert.deepEqual(revoked, ['late-grant']);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
  });
});

test('useAutoLog: newer enable revokes an older dialog result that arrives late', async () => {
  await withLocalStorageMock(async () => {
    const resolvers: Array<(grant: { token: string; displayPath: string }) => void> = [];
    const { sessionId, revoked, auto } = setup({
      requestTarget: async () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });

    const first = auto.enable(sessionId);
    const second = auto.enable(sessionId);
    resolvers[1]({ token: 'new-grant', displayPath: '/tmp/new.txt' });
    assert.equal(await second, '/tmp/new.txt');
    resolvers[0]({ token: 'old-grant', displayPath: '/tmp/old.txt' });
    assert.equal(await first, null);
    assert.deepEqual(revoked, ['old-grant']);
    await auto.disable(sessionId);
    assert.deepEqual(revoked, ['old-grant', 'new-grant']);
  });
});

test('useAutoLog: a grant arriving after session removal is revoked without setting target', async () => {
  await withLocalStorageMock(async () => {
    let resolveDialog!: (grant: { token: string; displayPath: string }) => void;
    const dialog = new Promise<{ token: string; displayPath: string }>((resolve) => {
      resolveDialog = resolve;
    });
    const { sessions, sessionId, revoked, auto } = setup({
      requestTarget: async () => dialog,
    });
    let setTargetCalls = 0;
    const originalSetTarget = sessions.setAutoLogTarget;
    sessions.setAutoLogTarget = ((...args: Parameters<typeof originalSetTarget>) => {
      setTargetCalls += 1;
      return originalSetTarget(...args);
    }) as typeof originalSetTarget;

    const enabling = auto.enable(sessionId);
    await sessions.removeSession(sessionId);
    resolveDialog({ token: 'orphan-grant', displayPath: '/tmp/orphan.txt' });

    assert.equal(await enabling, null);
    assert.equal(setTargetCalls, 0);
    assert.deepEqual(revoked, ['orphan-grant']);
  });
});

test('useAutoLog: entry-count overflow clears the bounded queue and revokes once', async () => {
  await withLocalStorageMock(async () => {
    let appendAttempts = 0;
    const { sessions, sessionId, revoked, auto } = setup({
      appendLog: async () => {
        appendAttempts += 1;
      },
    });
    await auto.enable(sessionId);
    for (let index = 0; index <= AUTO_LOG_MAX_QUEUED_ENTRIES; index += 1) {
      auto.appendFrame(sessionId, frame('RX', [0x41], index));
    }
    await auto.disable(sessionId);

    assert.equal(appendAttempts, 0);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
    assert.deepEqual(revoked, [`grant-${sessionId}`]);
  });
});

test('useAutoLog: batches preserve order and stay below the IPC batch limit', async () => {
  await withLocalStorageMock(async () => {
    const { app, sessionId, writes, auto } = setup();
    await auto.enable(sessionId);
    app.setDisplayMode('ASCII');
    const first = frame('RX', [], 1);
    first.data = new Uint8Array(140 * 1024).fill(0x41);
    const second = frame('TX', [], 2);
    second.data = new Uint8Array(140 * 1024).fill(0x42);
    auto.appendFrame(sessionId, first);
    auto.appendFrame(sessionId, second);
    await auto.disable(sessionId);

    assert.equal(writes.length, 2);
    assert.ok(
      writes.every(
        (write) => new TextEncoder().encode(write.line).byteLength <= AUTO_LOG_MAX_BATCH_BYTES,
      ),
    );
    assert.equal(writes[0].line.includes('AAAA'), true);
    assert.equal(writes[1].line.includes('BBBB'), true);
  });
});

test('useAutoLog: grant keeps the append and revoke deps of its enabling instance', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, writes, revoked, auto: owner } = setup();
    await owner.enable(sessionId);
    let foreignAppendCalls = 0;
    let foreignRevokeCalls = 0;
    const foreign = useAutoLog({
      appendLog: async () => {
        foreignAppendCalls += 1;
      },
      revokeTarget: async () => {
        foreignRevokeCalls += 1;
      },
    });
    foreign.appendFrame(sessionId, frame('RX', [0x41]));
    await foreign.disable(sessionId);

    assert.equal(writes.length, 1);
    assert.deepEqual(revoked, [`grant-${sessionId}`]);
    assert.equal(foreignAppendCalls, 0);
    assert.equal(foreignRevokeCalls, 0);
  });
});

test('useAutoLog: append timeout disables and revoke timeout cannot block cleanup forever', async () => {
  await withLocalStorageMock(async () => {
    const never = new Promise<void>(() => undefined);
    let revokeAttempts = 0;
    const { sessions, sessionId, auto } = setup({
      appendLog: async () => never,
      revokeTarget: async () => {
        revokeAttempts += 1;
        return never;
      },
      appendTimeoutMs: 5,
      revokeTimeoutMs: 5,
    });
    await auto.enable(sessionId);
    auto.appendFrame(sessionId, frame('RX', [0x41]));

    await Promise.race([
      auto.disable(sessionId),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('cleanup remained pending')), 250);
      }),
    ]);

    assert.equal(revokeAttempts, 1);
    assert.equal(sessions.sessions[0].autoLogEnabled, false);
    assert.equal(sessions.sessions[0].logPath, null);
  });
});
