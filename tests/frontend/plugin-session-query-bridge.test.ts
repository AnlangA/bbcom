// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  PluginSessionQueryBridge,
  type PluginSessionSnapshotSource,
} from '../../src/features/plugins/plugin-session-query-bridge';
import { PLUGIN_SESSION_QUERY_RESULT_COMMAND } from '../../src/features/plugins/plugin-session-query-bridge';
import type { PluginSessionSummary } from '../../src/generated/ipc-contracts';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }));
    return () => listeners.delete(event);
  },
}));

function emitQuery(payload: unknown): void {
  listeners.get('plugin-session-query')?.(payload);
}

const sessions: PluginSessionSummary[] = [
  {
    sessionId: 'session-1',
    name: '/dev/ttyUSB0',
    kind: 'serial',
    connected: true,
    rxBytes: 100,
    txBytes: 40,
  },
];

function sourceWith(
  frames: Array<{ sequence: number; timestampMs: number; tx: boolean; bytes: number[] }>,
  knownSession = true,
): PluginSessionSnapshotSource {
  return {
    listSessions: () => sessions,
    readCapture: ({ maxFrames, maxBytes }) => {
      if (!knownSession) return null;
      const taken: typeof frames = [];
      let budget = maxBytes;
      for (const frame of frames) {
        if (taken.length >= maxFrames || frame.bytes.length > budget) break;
        budget -= frame.bytes.length;
        taken.push(frame);
      }
      const next = taken.length < frames.length ? (frames[taken.length]?.sequence ?? null) : null;
      return { frames: taken, nextSequence: next };
    },
  };
}

test('answers session-list queries with the catalog snapshot', async () => {
  invokeMock.mockClear();
  const bridge = new PluginSessionQueryBridge(sourceWith([]));
  await bridge.start();
  emitQuery({
    queryId: 'session-list-1',
    pluginId: 'dev.bbcom.fixture',
    kind: 'list',
  });
  await vi.waitFor(() => assert.ok(invokeMock.mock.calls.length > 0));
  const [command, { result }] = invokeMock.mock.calls[0]!;
  assert.equal(command, PLUGIN_SESSION_QUERY_RESULT_COMMAND);
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].name, '/dev/ttyUSB0');
  bridge.stop();
});

test('capture pages honor frame and byte budgets and report continuation', async () => {
  invokeMock.mockClear();
  const frames = [
    { sequence: 0, timestampMs: 1, tx: false, bytes: [1, 2] },
    { sequence: 1, timestampMs: 2, tx: true, bytes: [3] },
    { sequence: 2, timestampMs: 3, tx: false, bytes: [4, 5, 6] },
  ];
  const bridge = new PluginSessionQueryBridge(sourceWith(frames));
  await bridge.start();
  emitQuery({
    queryId: 'capture-1',
    pluginId: 'dev.bbcom.fixture',
    kind: 'capture',
    sessionId: 'session-1',
    fromSequence: 0,
    maxFrames: 2,
    maxBytes: 512 * 1024,
  });
  await vi.waitFor(() => assert.ok(invokeMock.mock.calls.length > 0));
  const { result } = invokeMock.mock.calls[0]![1] as { result: never };
  assert.equal(result.frames.length, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextSequence, 2);
  bridge.stop();
});

test('unknown sessions and invalid payloads answer with domain errors', async () => {
  invokeMock.mockClear();
  const bridge = new PluginSessionQueryBridge(sourceWith([], false));
  await bridge.start();
  emitQuery({
    queryId: 'capture-2',
    pluginId: 'dev.bbcom.fixture',
    kind: 'capture',
    sessionId: 'missing',
    fromSequence: 0,
    maxFrames: 4,
    maxBytes: 1024,
  });
  emitQuery({ queryId: 'bad', kind: 'nonsense' });
  await vi.waitFor(() => assert.equal(invokeMock.mock.calls.length, 1));
  const { result } = invokeMock.mock.calls[0]![1] as { result: never };
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not-found');
  bridge.stop();
});
