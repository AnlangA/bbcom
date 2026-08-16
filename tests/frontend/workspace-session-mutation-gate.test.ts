import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  useSessionCoreStore,
  type WorkspaceSessionChangeEvent,
} from '../../src/stores/session-core.ts';
import { createSessionCaptureController } from '../../src/features/sessions/capture/session-capture-controller.ts';
import { createSessionRecord } from '../../src/lib/session-persistence.ts';
import type { PortConfig } from '../../src/types/index.ts';
import type { HydratedWorkspaceSession } from '../../src/features/workspace/adapters/index.ts';

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

function createStore() {
  setActivePinia(createPinia());
  return useSessionCoreStore();
}

test('workspace mutation gate rejects persisted user changes before touching memory', async () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const firstId = store.createSession('COM1', config);
  const secondId = store.createSession('COM2', config);
  assert.ok(firstId);
  assert.ok(secondId);
  store.addFrame(firstId, { direction: 'RX', data: new Uint8Array([1]) });

  const before = {
    ids: store.sessions.map((session) => session.id),
    activeSessionId: store.activeSessionId,
    first: {
      frames: store.sessions[0].frames.map((frame) => Array.from(frame.data)),
      capturePaused: store.sessions[0].capturePaused,
      sendDraft: store.sessions[0].sendDraft,
      modbusEnabled: store.sessions[0].modbusConfig.enabled,
      quickCommands: [...store.sessions[0].quickCommands],
    },
  };
  const events: WorkspaceSessionChangeEvent[] = [];
  const detach = persistence.subscribeWorkspaceChanges((event) => events.push(event));
  persistence.setWorkspaceMutationPermissions({ userMutations: false, runtimeCapture: true });

  assert.equal(store.createSession('COM3', config), null);
  assert.equal(await store.removeSession(firstId), null);
  assert.deepEqual(store.undoLastRemovedSession(), {
    ok: false,
    reason: 'mutation-rejected',
  });
  assert.deepEqual(store.completeWorkspaceRebind(firstId, 'COM9', config), {
    ok: false,
    reason: 'mutation-rejected',
  });
  store.setActiveSession(firstId);
  store.reorderSessions(0, 1);
  store.clearFrames(firstId);
  store.setCapturePaused(firstId, true);
  store.setSendDraft(firstId, 'blocked');
  store.setModbusConfig(firstId, { enabled: true });
  store.addQuickCommand(firstId, { name: 'blocked', data: '41', isHex: true });

  assert.deepEqual(
    store.sessions.map((session) => session.id),
    before.ids,
  );
  assert.equal(store.activeSessionId, before.activeSessionId);
  assert.deepEqual(
    {
      frames: store.sessions[0].frames.map((frame) => Array.from(frame.data)),
      capturePaused: store.sessions[0].capturePaused,
      sendDraft: store.sessions[0].sendDraft,
      modbusEnabled: store.sessions[0].modbusConfig.enabled,
      quickCommands: [...store.sessions[0].quickCommands],
    },
    before.first,
  );
  assert.deepEqual(events, []);

  const finalFrame = store.addFrame(firstId, {
    direction: 'RX',
    data: new Uint8Array([2, 3]),
  });
  assert.ok(finalFrame, 'runtime drain may still accept the final RX frame');
  store.setConnected(firstId, false);
  assert.equal(store.sessions[0].isConnected, false, 'runtime disconnect bypasses the user gate');

  persistence.setWorkspaceMutationPermissions({ userMutations: false, runtimeCapture: false });
  const frameCount = store.sessions[0].frames.length;
  assert.equal(store.addFrame(firstId, { direction: 'RX', data: new Uint8Array([4]) }), undefined);
  assert.equal(store.sessions[0].frames.length, frameCount);

  persistence.setWorkspaceMutationPermissions({
    userMutations: true,
    runtimeCapture: true,
    preflightRuntimeCapture: () => false,
  });
  assert.equal(store.addFrame(firstId, { direction: 'RX', data: new Uint8Array([5]) }), undefined);
  assert.equal(store.sessions[0].frames.length, frameCount);
  detach();
});

test('undo emits a restoration event distinct from ordinary catalog changes', async () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const sessionId = store.createSession('COM-undo', config);
  assert.ok(sessionId);
  const events: WorkspaceSessionChangeEvent[] = [];
  const detach = persistence.subscribeWorkspaceChanges((event) => events.push(event));

  await store.removeSession(sessionId);
  const result = store.undoLastRemovedSession();

  assert.deepEqual(result, { ok: true, sessionId });
  assert.equal(events[0]?.kind, 'catalog-changed');
  assert.deepEqual(events[1], { kind: 'session-restored', sessionId });
  detach();
});

test('AI history emits append and clear deltas instead of a destructive session rewrite', () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const sessionId = store.createSession('COM-ai', config);
  assert.ok(sessionId);
  const events: WorkspaceSessionChangeEvent[] = [];
  persistence.subscribeWorkspaceChanges((event) => events.push(event));

  store.addLogAiMessage(sessionId, { role: 'user', content: 'first' });
  store.addLogAiMessage(sessionId, { role: 'assistant', content: 'second' });
  store.clearLogAiMessages(sessionId);

  assert.equal(events[0]?.kind, 'ai-message-appended');
  assert.equal(events[1]?.kind, 'ai-message-appended');
  if (events[0]?.kind === 'ai-message-appended') assert.equal(events[0].startPosition, 0);
  if (events[1]?.kind === 'ai-message-appended') assert.equal(events[1].startPosition, 1);
  assert.deepEqual(events[2], { kind: 'ai-messages-cleared', sessionId });
});

test('workspace waveform hydrate, append, replace, and cursor are session-owned', () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const waveform = useSessionCoreStore();
  const session = createSessionRecord('waveform-session', '', config, {
    frames: [
      {
        id: 'persisted-frame',
        direction: 'RX',
        timestamp: 50,
        data: new Uint8Array([49]),
      },
    ],
  });
  const entry: HydratedWorkspaceSession = {
    session,
    sortOrder: 0,
    rebind: {
      required: true,
      displayName: 'Waveform device',
      kind: 'live',
      lastPortHint: null,
    },
    waveform: {
      channels: [{ channelIndex: 0, config: { color: '#123456', visible: true } }],
      samples: [{ channelIndex: 0, seq: 7, timestampMs: 40, value: 1.5 }],
      frameCursor: { consumed: 1, lastFrameId: 'persisted-frame' },
    },
  };
  const events: WorkspaceSessionChangeEvent[] = [];
  persistence.subscribeWorkspaceChanges((event) => events.push(event));

  store.replaceWorkspaceSessions([entry], 'waveform-session');
  assert.deepEqual(events, [], 'hydrate is a replacement boundary, not a new mutation');
  assert.deepEqual(waveform.workspaceWaveformBySessionId['waveform-session'], {
    channels: [{ channelIndex: 0, config: { color: '#123456', visible: true } }],
    samples: [{ channelIndex: 0, seq: 7, timestampMs: 40, value: 1.5 }],
    frameCursor: { consumed: 1, lastFrameId: 'persisted-frame' },
  });

  assert.equal(
    waveform.appendSessionWaveformSamples('waveform-session', [
      { channelIndex: 0, group: 0, timestampMs: 60, value: 2 },
      { channelIndex: 1, group: 0, timestampMs: 60, value: 3 },
    ]),
    true,
  );
  assert.equal(
    events.at(-1)?.kind,
    'waveform-frame-ingested',
    'new channels and their samples persist in one replacement transaction',
  );
  assert.deepEqual(waveform.workspaceWaveformBySessionId['waveform-session']?.samples.slice(-2), [
    { channelIndex: 0, seq: 8, timestampMs: 60, value: 2 },
    { channelIndex: 1, seq: 8, timestampMs: 60, value: 3 },
  ]);

  assert.equal(
    waveform.appendSessionWaveformSamples('waveform-session', [
      { channelIndex: 1, group: 0, timestampMs: 70, value: 4 },
    ]),
    true,
  );
  assert.equal(events.at(-1)?.kind, 'waveform-samples-appended');
  assert.equal(
    waveform.setSessionWaveformFrameCursor('waveform-session', {
      consumed: 2,
      lastFrameId: 'new-frame',
    }),
    true,
  );
  assert.deepEqual(waveform.workspaceWaveformBySessionId['waveform-session']?.frameCursor, {
    consumed: 2,
    lastFrameId: 'new-frame',
  });

  const eventCount = events.length;
  assert.equal(
    waveform.commitSessionWaveformFrameIngest(
      'waveform-session',
      'append',
      [{ channelIndex: 1, group: 0, timestampMs: 80, value: 5 }],
      { consumed: 3, lastFrameId: 'atomic-frame' },
    ),
    true,
  );
  assert.equal(events.length, eventCount + 1, 'samples and cursor publish one persistence event');
  const ingest = events.at(-1);
  assert.equal(ingest?.kind, 'waveform-frame-ingested');
  if (ingest?.kind === 'waveform-frame-ingested') {
    assert.equal(ingest.mode, 'append');
    assert.deepEqual(ingest.samples, [{ channelIndex: 1, seq: 10, timestampMs: 80, value: 5 }]);
    assert.deepEqual(ingest.waveform.frameCursor, {
      consumed: 3,
      lastFrameId: 'atomic-frame',
    });
  }

  const samplesBeforeVisibility =
    waveform.workspaceWaveformBySessionId['waveform-session']?.samples;
  assert.equal(waveform.setSessionWaveformChannelVisible('waveform-session', 0, false), true);
  assert.equal(events.at(-1)?.kind, 'waveform-channel-config-changed');
  assert.deepEqual(
    waveform.workspaceWaveformBySessionId['waveform-session']?.samples,
    samplesBeforeVisibility,
    'display configuration must not replace or delete durable sample rows',
  );

  const resetEventCount = events.length;
  assert.equal(
    waveform.resetSessionWaveform('waveform-session', {
      consumed: 3,
      lastFrameId: 'atomic-frame',
    }),
    true,
  );
  assert.equal(events.length, resetEventCount + 1, 'clear publishes one atomic reset event');
  const reset = events.at(-1);
  assert.equal(reset?.kind, 'waveform-frame-ingested');
  if (reset?.kind === 'waveform-frame-ingested') {
    assert.equal(reset.mode, 'replace');
    assert.deepEqual(reset.waveform, {
      channels: [],
      samples: [],
      frameCursor: { consumed: 3, lastFrameId: 'atomic-frame' },
    });
  }

  const sourceModeEventCount = events.length;
  store.setWaveformSourceMode('waveform-session', 'register');
  assert.equal(
    events.length,
    sourceModeEventCount + 1,
    'source mode change publishes only its atomic reset event',
  );
  assert.equal(events.at(-1)?.kind, 'waveform-frame-ingested');
  assert.equal(store.sessions[0]?.waveformSourceMode, 'register');
});

test('workspace waveform retains exactly the latest 600 complete sample groups', () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const waveform = useSessionCoreStore();
  const sessionId = store.createSession('COM-waveform-bound', config);
  assert.ok(sessionId);
  const events: WorkspaceSessionChangeEvent[] = [];
  persistence.subscribeWorkspaceChanges((event) => events.push(event));

  assert.equal(
    waveform.appendSessionWaveformSamples(
      sessionId,
      Array.from({ length: 601 }, (_, group) => ({
        channelIndex: group % 2,
        group,
        timestampMs: group,
        value: group,
      })),
    ),
    true,
  );

  const state = waveform.workspaceWaveformBySessionId[sessionId];
  assert.equal(new Set(state?.samples.map((sample) => sample.seq)).size, 600);
  assert.equal(state?.samples[0]?.seq, 1);
  const event = events.at(-1);
  assert.equal(event?.kind, 'waveform-frame-ingested');
  if (event?.kind === 'waveform-frame-ingested') {
    assert.equal(event.mode, 'replace');
    assert.deepEqual(event.samples, event.waveform.samples);
    assert.deepEqual(event.waveform.frameCursor, { consumed: 0, lastFrameId: null });
  }
});

test('workspace waveform trims incrementally accumulated groups and stays exact after the trim', () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  const waveform = useSessionCoreStore();
  const sessionId = store.createSession('COM-waveform-incremental', config);
  assert.ok(sessionId);
  const events: WorkspaceSessionChangeEvent[] = [];
  persistence.subscribeWorkspaceChanges((event) => events.push(event));

  // Fill to exactly the 600-group bound across many register-style ticks
  // (one new group per tick) so every append lands on the incremental
  // no-overflow fast path first.
  for (let tick = 0; tick < 600; tick += 1) {
    assert.equal(
      waveform.appendSessionWaveformSamples(sessionId, [
        { channelIndex: tick % 2, group: 0, timestampMs: tick, value: tick },
      ]),
      true,
    );
  }
  let state = waveform.workspaceWaveformBySessionId[sessionId];
  assert.equal(state?.samples.length, 600);
  assert.equal(new Set(state?.samples.map((sample) => sample.seq)).size, 600);
  assert.equal(events.at(-1)?.kind, 'waveform-samples-appended');

  // The 601st group overflows the bound: the oldest group is dropped, the
  // newest group stays complete, and the append publishes a replacement.
  assert.equal(
    waveform.appendSessionWaveformSamples(sessionId, [
      { channelIndex: 0, group: 0, timestampMs: 601, value: 601 },
      { channelIndex: 1, group: 0, timestampMs: 601, value: 602 },
    ]),
    true,
  );
  state = waveform.workspaceWaveformBySessionId[sessionId];
  assert.equal(new Set(state?.samples.map((sample) => sample.seq)).size, 600);
  assert.equal(state?.samples.length, 601, 'the newest group is complete');
  assert.equal(state?.samples[0]?.seq, 1, 'the oldest group was dropped after overflow');
  assert.deepEqual(state?.samples.slice(-2), [
    { channelIndex: 0, seq: 600, timestampMs: 601, value: 601 },
    { channelIndex: 1, seq: 600, timestampMs: 601, value: 602 },
  ]);
  assert.equal(events.at(-1)?.kind, 'waveform-frame-ingested');

  // After the trim the retention counters must be rebuilt exactly right:
  // subsequent single-group appends keep sliding the 600-group window.
  for (let tick = 602; tick < 610; tick += 1) {
    assert.equal(
      waveform.appendSessionWaveformSamples(sessionId, [
        { channelIndex: 0, group: 0, timestampMs: tick, value: tick },
      ]),
      true,
    );
  }
  state = waveform.workspaceWaveformBySessionId[sessionId];
  assert.equal(new Set(state?.samples.map((sample) => sample.seq)).size, 600);
  assert.equal(state?.samples.length, 601);
  assert.equal(state?.samples[0]?.seq, 9, 'the window keeps sliding one group per tick');
  assert.deepEqual(state?.samples.at(-1), {
    channelIndex: 0,
    seq: 608,
    timestampMs: 609,
    value: 609,
  });
});

test('create and undo are rejected before memory mutation when workspace limits fail preflight', async () => {
  const store = createStore();
  const persistence = useSessionCoreStore();
  persistence.setWorkspaceMutationPermissions({
    userMutations: true,
    runtimeCapture: true,
    preflightSessionRegistration: () => true,
  });
  const sessionId = store.createSession('COM-limit', config);
  assert.ok(sessionId);
  await store.removeSession(sessionId);

  persistence.setWorkspaceMutationPermissions({
    userMutations: true,
    runtimeCapture: true,
    preflightSessionRegistration: () => false,
  });
  assert.deepEqual(store.undoLastRemovedSession(), { ok: false, reason: 'limit-exceeded' });
  assert.equal(store.sessions.length, 0);
  assert.equal(store.lastDeletedSession?.session.id, sessionId);
  assert.equal(store.createSession('COM-new', config), null);
  assert.equal(store.sessions.length, 0);
});

test('capture controller reports exact per-session frame and byte eviction totals', () => {
  const session = createSessionRecord('capture', 'COM-capture', config);
  const trims: Array<{ sessionId: string; droppedFrames: number; droppedBytes: number }> = [];
  let id = 0;
  const capture = createSessionCaptureController({
    getSessions: () => [session],
    findSession: (sessionId) => (sessionId === session.id ? session : undefined),
    frameVersions: {},
    getMaxBufferFrames: () => 1,
    scheduleFramesPersist: () => undefined,
    createId: () => `frame-${id++}`,
    now: () => id,
    onCaptureTrimmed: (sessionId, droppedFrames, droppedBytes) =>
      trims.push({ sessionId, droppedFrames, droppedBytes }),
  });
  capture.initializeSession(session);

  for (let index = 0; index < 502; index += 1) {
    capture.addFrame(session.id, { direction: 'RX', data: new Uint8Array([index % 256]) });
  }

  assert.deepEqual(trims, [{ sessionId: session.id, droppedFrames: 501, droppedBytes: 501 }]);
  assert.equal(session.frames.length, 1);
});
