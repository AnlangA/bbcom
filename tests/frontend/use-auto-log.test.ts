import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { useAppStore } from '../../src/stores/app.ts';
import { useAutoLog } from '../../src/composables/useAutoLog.ts';
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
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  const restore = () => {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        },
      );
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
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

function setup(deps?: { appendLog?: (path: string, line: string) => Promise<void> }) {
  setActivePinia(createPinia());
  const sessions = useSessionStore();
  const app = useAppStore();
  const sessionId = sessions.createSession('COM1', cfg);
  const writes: Array<{ path: string; line: string }> = [];
  const auto = useAutoLog({
    appendLog:
      deps?.appendLog ??
      (async (path, line) => {
        writes.push({ path, line });
      }),
  });
  return { sessions, app, sessionId, writes, auto };
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

test('useAutoLog: appendFrame is a no-op until a log target is set', async () => {
  await withLocalStorageMock(async () => {
    const { sessionId, writes, auto } = setup();

    auto.appendFrame(sessionId, frame('RX', [0x41]));
    await flush();

    assert.equal(writes.length, 0, 'nothing appended when auto-log disabled');
  });
});

test('useAutoLog: after enable, frames are formatted and appended in arrival order', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, app, sessionId, writes, auto } = setup();
    sessions.setAutoLogTarget(sessionId, '/tmp/log.txt');
    app.setDisplayMode('ASCII');

    auto.appendFrame(sessionId, frame('RX', [0x41, 0x42], 1));
    auto.appendFrame(sessionId, frame('TX', [0x43], 2));
    await flush();

    assert.equal(writes.length, 2, 'both frames appended');
    assert.equal(writes[0].path, '/tmp/log.txt');
    assert.equal(writes[1].path, '/tmp/log.txt');
    // ASCII representation of 0x41 0x42 is "AB".
    assert.equal(writes[0].line.includes('AB'), true, 'RX frame formatted as ASCII');
    assert.equal(writes[1].line.includes('C'), true, 'TX frame formatted as ASCII');
    // Each line is timestamped and tagged with direction then terminated by \n.
    assert.equal(writes[0].line.endsWith('\n'), true, 'line terminated');
    // Ordering: the RX frame lands before the TX frame (serialized chain).
    assert.equal(writes[0].line.includes('RX'), true);
    assert.equal(writes[1].line.includes('TX'), true);
  });
});

test('useAutoLog: disable stops further appends (queued writes still drain)', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId, writes, auto } = setup();
    sessions.setAutoLogTarget(sessionId, '/tmp/log.txt');

    auto.appendFrame(sessionId, frame('RX', [0x41]));
    auto.disable(sessionId);
    auto.appendFrame(sessionId, frame('RX', [0x42], 2));
    await flush();

    assert.equal(writes.length, 1, 'only the frame before disable is appended');
    assert.equal(sessions.sessions[0].autoLogEnabled, false, 'flag cleared');
    assert.equal(sessions.sessions[0].logPath, null, 'path cleared');
  });
});

test('useAutoLog: a failing append does not break the chain (subsequent appends still land)', async () => {
  await withLocalStorageMock(async () => {
    let first = true;
    const { sessions, sessionId, writes, auto } = setup({
      appendLog: async () => {
        if (first) {
          first = false;
          throw new Error('disk full');
        }
        writes.push({ path: 'recovered', line: 'ok' });
      },
    });
    sessions.setAutoLogTarget(sessionId, '/tmp/log.txt');

    auto.appendFrame(sessionId, frame('RX', [0x41]));
    auto.appendFrame(sessionId, frame('RX', [0x42], 2));
    await flush();
    await flush();

    // The first append failed (caught), but the second still ran — the chain
    // must not get stuck on a rejected promise.
    assert.equal(writes.length, 1, 'recovery append landed after a failure');
  });
});

test('useAutoLog: appends for different sessions are independent chains', async () => {
  await withLocalStorageMock(async () => {
    const { sessions, sessionId: s1, writes, auto } = setup();
    const s2 = sessions.createSession('COM2', cfg);
    sessions.setAutoLogTarget(s1, '/tmp/a.txt');
    sessions.setAutoLogTarget(s2, '/tmp/b.txt');

    auto.appendFrame(s1, frame('RX', [1]));
    auto.appendFrame(s2, frame('RX', [2]));
    await flush();

    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((w) => w.path).sort(),
      ['/tmp/a.txt', '/tmp/b.txt'],
      'each session wrote to its own path',
    );
  });
});
