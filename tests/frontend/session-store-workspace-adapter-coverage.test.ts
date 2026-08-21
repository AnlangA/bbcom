import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { createSessionRecord } from '../../src/lib/session-persistence.ts';
import {
  SessionStoreWorkspaceAdapter,
  WorkspaceSessionFacadeBridge,
} from '../../src/features/workspace/session-store-workspace-adapter.ts';
import type {
  WorkspaceApplicationService,
  WorkspaceApplicationViewModel,
  WorkspaceFacadeSnapshot,
  WorkspaceQueueOutcome,
  WorkspaceRuntimePersistenceDrain,
} from '../../src/features/workspace/application/index.ts';
import type {
  WorkspaceSessionChangeEvent,
  useSessionCoreStore,
} from '../../src/stores/session-core.ts';
import type { PortConfig, SerialSession, SessionWaveformState } from '../../src/types/index.ts';

const portConfig: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

const accepted = Object.freeze({ accepted: true }) as WorkspaceQueueOutcome;

interface AdapterCall {
  readonly target: 'application' | 'drain';
  readonly method: string;
  readonly args: readonly unknown[];
}

function session(id: string, portName: string): SerialSession {
  return createSessionRecord(id, portName, portConfig);
}

function waveform(lastFrameId: string | null = null): SessionWaveformState {
  return {
    channels: [{ channelIndex: 0, config: { color: '#123456', visible: true } }],
    samples: [{ channelIndex: 0, seq: 4, timestampMs: 20, value: 2.5 }],
    frameCursor: { consumed: 1, lastFrameId },
  };
}

function facadeSnapshot(
  sessions: readonly SerialSession[],
  activeSessionId: string | null,
): WorkspaceFacadeSnapshot {
  return {
    workspaceId: 'workspace-1',
    name: 'Workspace',
    revision: 1,
    activeSessionId,
    sessions: sessions.map((entry, sortOrder) => ({
      session: entry,
      sortOrder,
      rebind: {
        required: true,
        displayName: `Device ${entry.id}`,
        kind: 'live',
        lastPortHint: null,
      },
      waveform: waveform(),
    })),
    layout: { version: 1, sidebar: { width: 280, collapsed: false } },
    activityPolicy: {
      connections: 'disconnected',
      automation: 'stopped',
      ai: 'stopped',
    },
  };
}

function createAdapterHarness(initialSessions: readonly SerialSession[]) {
  let sessions = [...initialSessions];
  let activeSessionId = sessions[0]?.id ?? null;
  let currentWorkspace = true;
  let storeListener: ((event: WorkspaceSessionChangeEvent) => void) | null = null;
  let applicationListener: ((snapshot: WorkspaceApplicationViewModel) => void) | null = null;
  const calls: AdapterCall[] = [];
  const outcomes = new Map<string, WorkspaceQueueOutcome[]>();
  const storeDetach = vi.fn();
  const applicationDetach = vi.fn();
  const markWorkspacePersisted = vi.fn();
  const replaceWorkspaceSessions = vi.fn();
  const rejectPersistence = vi.fn();

  const rebindBySessionId: Record<string, unknown> = {};
  const waveformBySessionId: Record<string, SessionWaveformState> = {};
  for (const entry of sessions) waveformBySessionId[entry.id] = waveform();

  const takeOutcome = (method: string): WorkspaceQueueOutcome =>
    outcomes.get(method)?.shift() ?? accepted;
  const record = (
    target: AdapterCall['target'],
    method: string,
    args: readonly unknown[],
  ): WorkspaceQueueOutcome => {
    calls.push({ target, method, args });
    return takeOutcome(`${target}.${method}`);
  };

  const store = {
    get sessions() {
      return sessions;
    },
    get activeSessionId() {
      return activeSessionId;
    },
    workspaceRebindBySessionId: rebindBySessionId,
    workspaceWaveformBySessionId: waveformBySessionId,
    subscribeWorkspaceChanges(listener: (event: WorkspaceSessionChangeEvent) => void) {
      storeListener = listener;
      return storeDetach;
    },
    isPersistentSession(sessionId: string) {
      return sessions.some((session) => session.id === sessionId);
    },
    replaceWorkspaceSessions,
    markWorkspacePersisted,
  } as unknown as ReturnType<typeof useSessionCoreStore>;

  const application = {
    subscribe(listener: (snapshot: WorkspaceApplicationViewModel) => void) {
      applicationListener = listener;
      return applicationDetach;
    },
    snapshot() {
      return {
        currentWorkspace: currentWorkspace
          ? {
              workspaceId: 'workspace-1',
              name: 'Workspace',
              revision: 1,
              activeSessionId,
              sessionIds: sessions.map((entry) => entry.id),
              saveHealth: 'clean',
              layout: { version: 1, sidebar: { width: 280, collapsed: false } },
            }
          : null,
      };
    },
    rejectPersistence,
    queueCapturedFrame: (...args: unknown[]) => record('application', 'queueCapturedFrame', args),
    queueCaptureReset: (...args: unknown[]) => record('application', 'queueCaptureReset', args),
    queueCaptureTrim: (...args: unknown[]) => record('application', 'queueCaptureTrim', args),
    queueWaveformReplacement: (...args: unknown[]) =>
      record('application', 'queueWaveformReplacement', args),
    queueWaveformSamples: (...args: unknown[]) =>
      record('application', 'queueWaveformSamples', args),
    queueWaveformFrameIngest: (...args: unknown[]) =>
      record('application', 'queueWaveformFrameIngest', args),
    queueConfigMutation: (...args: unknown[]) => record('application', 'queueConfigMutation', args),
    queueConfigMutations: (...args: unknown[]) =>
      record('application', 'queueConfigMutations', args),
    queueOrderedMutations: (...args: unknown[]) =>
      record('application', 'queueOrderedMutations', args),
    registerSession: (...args: unknown[]) => record('application', 'registerSession', args),
    unregisterSession: (...args: unknown[]) => {
      calls.push({ target: 'application', method: 'unregisterSession', args });
    },
    forgetSession: (...args: unknown[]) => {
      calls.push({ target: 'application', method: 'forgetSession', args });
    },
  } as unknown as WorkspaceApplicationService;

  const makeDrain = () => {
    let accepting = true;
    const drain = {
      workspaceId: 'workspace-1',
      get accepting() {
        return accepting;
      },
      queueCapturedFrame: (...args: unknown[]) => record('drain', 'queueCapturedFrame', args),
      queueCaptureTrim: (...args: unknown[]) => record('drain', 'queueCaptureTrim', args),
      queueWaveformReplacement: (...args: unknown[]) =>
        record('drain', 'queueWaveformReplacement', args),
      queueWaveformSamples: (...args: unknown[]) => record('drain', 'queueWaveformSamples', args),
      queueWaveformFrameIngest: (...args: unknown[]) =>
        record('drain', 'queueWaveformFrameIngest', args),
      queueConfigMutation: (...args: unknown[]) => record('drain', 'queueConfigMutation', args),
      queueConfigMutations: (...args: unknown[]) => record('drain', 'queueConfigMutations', args),
      queueOrderedMutations: (...args: unknown[]) => record('drain', 'queueOrderedMutations', args),
    } as unknown as WorkspaceRuntimePersistenceDrain;
    return {
      drain,
      close() {
        accepting = false;
      },
    };
  };

  return {
    adapter: new SessionStoreWorkspaceAdapter(store, application),
    calls,
    outcomes,
    markWorkspacePersisted,
    replaceWorkspaceSessions,
    rejectPersistence,
    storeDetach,
    applicationDetach,
    makeDrain,
    emit(event: WorkspaceSessionChangeEvent) {
      assert.ok(storeListener, 'adapter must be started before emitting store changes');
      storeListener(event);
    },
    publish(snapshot: Partial<WorkspaceApplicationViewModel>) {
      assert.ok(applicationListener, 'adapter must be started before publishing application state');
      applicationListener(snapshot as WorkspaceApplicationViewModel);
    },
    setSessions(next: readonly SerialSession[], nextActiveSessionId: string | null) {
      sessions = [...next];
      activeSessionId = nextActiveSessionId;
      for (const entry of next) waveformBySessionId[entry.id] ??= waveform();
    },
    setCurrentWorkspace(present: boolean) {
      currentWorkspace = present;
    },
  };
}

test('session adapter forwards every session delta and clones waveform/AI payloads', () => {
  const alpha = session('alpha', 'COM7');
  const harness = createAdapterHarness([alpha]);
  harness.adapter.start();
  harness.adapter.start();

  harness.publish({ currentWorkspace: null, saveHealth: 'clean', unsavedMutationCount: 0 });
  harness.publish({
    currentWorkspace: {
      workspaceId: 'workspace-1',
      name: 'Workspace',
      revision: 1,
      activeSessionId: 'alpha',
      sessionIds: ['alpha'],
      saveHealth: 'clean',
      layout: { version: 1, sidebar: { width: 280, collapsed: false } },
    },
    saveHealth: 'pending',
    unsavedMutationCount: 1,
  });
  harness.publish({
    currentWorkspace: {
      workspaceId: 'workspace-1',
      name: 'Workspace',
      revision: 1,
      activeSessionId: 'alpha',
      sessionIds: ['alpha'],
      saveHealth: 'clean',
      layout: { version: 1, sidebar: { width: 280, collapsed: false } },
    },
    saveHealth: 'clean',
    unsavedMutationCount: 0,
  });
  assert.equal(harness.markWorkspacePersisted.mock.calls.length, 1);

  const frame = {
    id: 'frame-1',
    direction: 'RX' as const,
    timestamp: 10,
    data: new Uint8Array([1, 2]),
  };
  const wave = waveform('frame-1');
  const samples = [{ channelIndex: 0, seq: 5, timestampMs: 21, value: 3.5 }];
  harness.emit({ kind: 'frame-added', sessionId: 'alpha', frame });
  harness.emit({ kind: 'capture-cleared', sessionId: 'alpha' });
  harness.emit({
    kind: 'capture-trimmed',
    sessionId: 'alpha',
    droppedFrames: 2,
    droppedBytes: 8,
  });
  harness.emit({ kind: 'waveform-replaced', sessionId: 'alpha', waveform: wave });
  harness.emit({ kind: 'waveform-samples-appended', sessionId: 'alpha', samples });
  harness.emit({
    kind: 'waveform-cursor-changed',
    sessionId: 'alpha',
    cursor: { consumed: 2, lastFrameId: 'frame-1' },
  });
  harness.emit({ kind: 'waveform-channel-config-changed', sessionId: 'alpha', waveform: wave });
  harness.emit({
    kind: 'waveform-frame-ingested',
    sessionId: 'alpha',
    mode: 'replace',
    waveform: wave,
    samples,
  });
  harness.emit({
    kind: 'ai-message-appended',
    sessionId: 'alpha',
    startPosition: 3,
    message: {
      id: 'message-1',
      role: 'assistant',
      content: 'done',
      timestamp: 30,
    },
  });
  harness.emit({ kind: 'ai-messages-cleared', sessionId: 'alpha' });
  harness.emit({ kind: 'session-changed', sessionId: 'alpha' });

  assert.deepEqual(
    harness.calls.map((call) => call.method),
    [
      'queueCapturedFrame',
      'queueCaptureReset',
      'queueCaptureTrim',
      'queueWaveformReplacement',
      'queueWaveformSamples',
      'queueConfigMutation',
      'queueConfigMutation',
      'queueWaveformFrameIngest',
      'queueConfigMutation',
      'queueConfigMutation',
      'queueConfigMutations',
    ],
  );
  const replacement = harness.calls[3]?.args;
  assert.notStrictEqual(replacement?.[1], wave.channels);
  assert.notStrictEqual(replacement?.[2], wave.samples);
  const ingest = harness.calls[7]?.args[0] as {
    channels: unknown[];
    samples: unknown[];
    featureState: Record<string, unknown>;
  };
  assert.notStrictEqual(ingest.channels, wave.channels);
  assert.notStrictEqual(ingest.samples, samples);
  assert.equal(ingest.featureState.sourceMode, 'text');
  const aiCommand = harness.calls[8]?.args[0];
  assert.deepEqual(aiCommand, {
    kind: 'append-ai-messages',
    sessionId: 'alpha',
    payload: {
      startPosition: 3,
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'done',
          timestampMs: 30,
        },
      ],
    },
  });

  harness.emit({
    kind: 'waveform-cursor-changed',
    sessionId: 'missing',
    cursor: { consumed: 0, lastFrameId: null },
  });
  harness.emit({ kind: 'waveform-channel-config-changed', sessionId: 'missing', waveform: wave });
  harness.emit({
    kind: 'waveform-frame-ingested',
    sessionId: 'missing',
    mode: 'append',
    waveform: wave,
    samples,
  });
  harness.emit({ kind: 'session-changed', sessionId: 'missing' });
  assert.equal(harness.calls.length, 11);

  harness.adapter.stop();
  harness.adapter.stop();
  assert.equal(harness.storeDetach.mock.calls.length, 1);
  assert.equal(harness.applicationDetach.mock.calls.length, 1);
});

test('session adapter routes through a scoped drain and drops it when the drain closes', () => {
  const alpha = session('alpha', 'COM7');
  const harness = createAdapterHarness([alpha]);
  harness.adapter.start();
  harness.adapter.replaceWorkspace(facadeSnapshot([alpha], 'alpha'));
  assert.deepEqual(harness.replaceWorkspaceSessions.mock.calls[0], [
    facadeSnapshot([alpha], 'alpha').sessions,
    'alpha',
  ]);

  const scoped = harness.makeDrain();
  const other = harness.makeDrain();
  harness.adapter.beginPersistenceDrain(scoped.drain);
  harness.adapter.beginPersistenceDrain(scoped.drain);
  assert.throws(
    () => harness.adapter.beginPersistenceDrain(other.drain),
    /persistence drain already active/,
  );

  harness.emit({
    kind: 'frame-added',
    sessionId: 'alpha',
    frame: { id: 'frame', direction: 'TX', timestamp: 1, data: new Uint8Array([1]) },
  });
  harness.emit({ kind: 'capture-cleared', sessionId: 'alpha' });
  harness.emit({
    kind: 'capture-trimmed',
    sessionId: 'alpha',
    droppedFrames: 1,
    droppedBytes: 1,
  });
  harness.emit({ kind: 'waveform-replaced', sessionId: 'alpha', waveform: waveform() });
  harness.emit({
    kind: 'waveform-samples-appended',
    sessionId: 'alpha',
    samples: [{ channelIndex: 0, seq: 1, timestampMs: 1, value: 1 }],
  });
  harness.emit({
    kind: 'waveform-cursor-changed',
    sessionId: 'alpha',
    cursor: { consumed: 1, lastFrameId: null },
  });
  harness.emit({
    kind: 'waveform-channel-config-changed',
    sessionId: 'alpha',
    waveform: waveform(),
  });
  harness.emit({
    kind: 'waveform-frame-ingested',
    sessionId: 'alpha',
    mode: 'append',
    waveform: waveform(),
    samples: [{ channelIndex: 0, seq: 2, timestampMs: 2, value: 2 }],
  });
  harness.emit({
    kind: 'ai-message-appended',
    sessionId: 'alpha',
    startPosition: 0,
    message: { id: 'message', role: 'user', content: 'hello', timestamp: 1 },
  });
  harness.emit({ kind: 'ai-messages-cleared', sessionId: 'alpha' });
  harness.emit({ kind: 'session-changed', sessionId: 'alpha' });
  assert.equal(
    harness.calls.every((call) => call.target === 'drain'),
    true,
  );

  const beta = session('beta', 'COM8');
  harness.setSessions([alpha, beta], 'beta');
  harness.emit({ kind: 'session-restored', sessionId: 'beta' });
  harness.emit({ kind: 'catalog-changed' });
  assert.equal(
    harness.calls.filter((call) => call.method === 'queueOrderedMutations').at(-1)?.target,
    'drain',
  );

  harness.adapter.endPersistenceDrain(other.drain);
  scoped.close();
  harness.emit({ kind: 'capture-cleared', sessionId: 'alpha' });
  assert.equal(harness.calls.at(-1)?.target, 'application');

  harness.adapter.beginPersistenceDrain(other.drain);
  harness.adapter.endPersistenceDrain(other.drain);
  harness.emit({ kind: 'capture-cleared', sessionId: 'alpha' });
  assert.equal(harness.calls.at(-1)?.target, 'application');
  harness.adapter.stop();
});

test('catalog projection registers additions, forgets removals and rolls registration failures back', () => {
  const alpha = session('alpha', 'COM7');
  const pathNamed = session('path-named', '/dev/ttyUSB0');
  const windowsNamed = session('windows-named', '\\\\?\\COM9');
  const harness = createAdapterHarness([alpha, pathNamed, windowsNamed]);
  harness.adapter.start();
  harness.adapter.replaceWorkspace(facadeSnapshot([alpha, pathNamed, windowsNamed], 'alpha'));

  const gamma = session('gamma', '  Friendly Device  ');
  harness.setSessions([gamma, alpha], 'gamma');
  harness.emit({ kind: 'catalog-changed' });
  const ordered = harness.calls.find((call) => call.method === 'queueOrderedMutations');
  const commands = ordered?.args[0] as Array<Record<string, unknown>>;
  assert.deepEqual(
    commands
      .filter((command) => command.kind === 'remove-session')
      .map((command) => command.sessionId),
    ['path-named', 'windows-named'],
  );
  const gammaUpsert = commands.find(
    (command) => command.kind === 'upsert-session' && command.sessionId === 'gamma',
  ) as { payload: { name: string; lastPortHint?: { displayName: string } } };
  assert.equal(gammaUpsert.payload.name, 'Friendly Device');
  assert.equal(gammaUpsert.payload.lastPortHint?.displayName, 'Friendly Device');
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'forgetSession').map((call) => call.args[0]),
    ['path-named', 'windows-named'],
  );

  const beta = session('beta', 'COM8');
  const delta = session('delta', 'COM9');
  harness.setSessions([gamma, alpha, beta, delta], 'gamma');
  harness.outcomes.set('application.registerSession', [
    accepted,
    { accepted: false, messageKey: 'workspace.capture.limit_exceeded' },
  ]);
  harness.emit({ kind: 'catalog-changed' });
  assert.equal(harness.calls.at(-1)?.method, 'unregisterSession');
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), [
    'workspace.capture.limit_exceeded',
  ]);

  harness.outcomes.set('application.registerSession', [accepted, accepted]);
  harness.outcomes.set('application.queueOrderedMutations', [
    { accepted: false, messageKey: 'workspace.mutation.limit_exceeded' },
  ]);
  harness.emit({ kind: 'catalog-changed' });
  assert.equal(
    harness.calls.filter((call) => call.method === 'unregisterSession').slice(-2).length,
    2,
  );
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), [
    'workspace.mutation.limit_exceeded',
  ]);

  harness.setCurrentWorkspace(false);
  const before = harness.calls.length;
  harness.emit({ kind: 'catalog-changed' });
  assert.equal(harness.calls.length, before);
  harness.adapter.stop();
});

test('facade bridge keeps hydration baseline and deletion projection on the same adapter', () => {
  const alpha = session('alpha', 'COM7');
  const harness = createAdapterHarness([alpha]);
  const bridge = new WorkspaceSessionFacadeBridge();
  assert.throws(() => bridge.replaceWorkspace(facadeSnapshot([alpha], 'alpha')), /not bound/);
  assert.throws(() => bridge.clearWorkspace(), /not bound/);

  harness.adapter.start();
  bridge.bind(harness.adapter);
  bridge.bind(harness.adapter);
  bridge.replaceWorkspace(facadeSnapshot([alpha], 'alpha'));
  assert.equal(harness.replaceWorkspaceSessions.mock.calls.length, 1);

  harness.setSessions([], null);
  harness.emit({ kind: 'catalog-changed' });
  const commands = harness.calls.find((call) => call.method === 'queueOrderedMutations')
    ?.args[0] as Array<Record<string, unknown>> | undefined;
  assert.deepEqual(commands, [
    { kind: 'remove-session', sessionId: 'alpha' },
    { kind: 'set-active-session', sessionId: null },
  ]);
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'forgetSession').map((call) => call.args[0]),
    ['alpha'],
  );
  bridge.clearWorkspace();
  assert.deepEqual(harness.replaceWorkspaceSessions.mock.calls.at(-1), [[], null]);

  const other = createAdapterHarness([]).adapter;
  assert.throws(() => bridge.bind(other), /already bound/);
  harness.adapter.stop();
});

test('restored-session projection is atomic and projection re-entry is ignored', () => {
  const alpha = session('alpha', '');
  const beta = session('beta', '\\\\.\\COM8');
  const harness = createAdapterHarness([alpha]);
  harness.adapter.start();
  harness.adapter.replaceWorkspace(facadeSnapshot([alpha], 'alpha'));
  harness.setSessions([alpha, beta], 'beta');

  harness.emit({ kind: 'session-restored', sessionId: 'missing' });
  harness.outcomes.set('application.registerSession', [
    { accepted: false, messageKey: 'workspace.capture.invalid_session' },
  ]);
  harness.emit({ kind: 'session-restored', sessionId: 'beta' });
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), [
    'workspace.capture.invalid_session',
  ]);

  harness.outcomes.set('application.registerSession', [accepted]);
  harness.outcomes.set('application.queueOrderedMutations', [
    { accepted: false, messageKey: 'workspace.mutation.invalid' },
  ]);
  harness.emit({ kind: 'session-restored', sessionId: 'beta' });
  assert.equal(harness.calls.at(-1)?.method, 'unregisterSession');
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), ['workspace.mutation.invalid']);

  harness.outcomes.set('application.registerSession', [accepted]);
  harness.emit({ kind: 'session-restored', sessionId: 'beta' });
  const restoration = harness.calls.filter((call) => call.method === 'queueOrderedMutations').at(-1)
    ?.args[0] as Array<{ kind: string; sessionId?: string; payload?: { name?: string } }>;
  assert.equal(
    restoration.some((command) => command.kind === 'set-active-session'),
    true,
  );
  const betaUpsert = restoration.find(
    (command) => command.kind === 'upsert-session' && command.sessionId === 'beta',
  );
  assert.equal(betaUpsert?.payload?.name, 'Session 2');
  assert.equal('lastPortHint' in (betaUpsert?.payload ?? {}), false);

  let reentered = false;
  const callCountBefore = harness.calls.length;
  const originalEmit = harness.emit;
  const queueOutcome = harness.outcomes.get('application.queueConfigMutations') ?? [];
  queueOutcome.push(accepted);
  harness.outcomes.set('application.queueConfigMutations', queueOutcome);
  const calls = harness.calls as AdapterCall[];
  const originalPush = calls.push.bind(calls);
  calls.push = ((...items: AdapterCall[]) => {
    const result = originalPush(...items);
    if (!reentered && items.some((item) => item.method === 'queueConfigMutations')) {
      reentered = true;
      originalEmit({ kind: 'session-changed', sessionId: 'alpha' });
    }
    return result;
  }) as typeof calls.push;
  harness.emit({ kind: 'session-changed', sessionId: 'alpha' });
  assert.equal(reentered, true);
  assert.equal(
    harness.calls.slice(callCountBefore).filter((call) => call.method === 'queueConfigMutations')
      .length,
    1,
  );
  harness.adapter.stop();
});

test('adapter turns queue rejection and projection exceptions into fail-closed persistence', () => {
  const alpha = session('alpha', 'COM7');
  const harness = createAdapterHarness([alpha]);
  harness.adapter.start();
  harness.outcomes.set('application.queueCaptureTrim', [
    { accepted: false, messageKey: 'workspace.capture.invalid_trim' },
  ]);
  harness.emit({
    kind: 'capture-trimmed',
    sessionId: 'alpha',
    droppedFrames: 1,
    droppedBytes: 1,
  });
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), ['workspace.capture.invalid_trim']);

  alpha.sendDraft = 'x'.repeat(1024 * 1024 + 1);
  harness.emit({ kind: 'session-changed', sessionId: 'alpha' });
  assert.deepEqual(harness.rejectPersistence.mock.calls.at(-1), ['workspace.mutation.invalid']);
  harness.adapter.stop();
});
