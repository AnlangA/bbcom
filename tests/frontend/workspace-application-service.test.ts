import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { IPC_LIMITS } from '../../src/generated/ipc-contracts.ts';
import type {
  ApplyWorkspaceBatchRequest,
  HydrateWorkspaceSessionsRequest,
  WorkspaceDocumentHeader,
  WorkspaceHydratedFrame,
  WorkspaceSessionSnapshot,
  WorkspaceSummary,
} from '../../src/generated/ipc-contracts.ts';
import type { DataFrame } from '../../src/types/serial.ts';
import type { WorkspaceHydrationPort } from '../../src/features/workspace/adapters/index.ts';
import {
  WORKSPACE_STOPPED_ACTIVITY_POLICY,
  WorkspaceApplicationService,
  type WorkspaceFacadeSnapshot,
  type WorkspaceSessionFacade,
} from '../../src/features/workspace/application/index.ts';
import type { WorkspaceRuntimeLifecycle } from '../../src/features/workspace/application/types.ts';
import {
  WorkspaceCoordinator,
  type WorkspaceCoordinatorPort,
} from '../../src/features/workspace/index.ts';

interface WorkspaceDefinition {
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly sessions: readonly WorkspaceSessionSnapshot[];
  readonly frames?: Readonly<Record<string, readonly WorkspaceHydratedFrame[]>>;
  readonly headerSessionIds?: readonly string[];
}

interface TestSystem {
  readonly application: WorkspaceApplicationService;
  readonly coordinator: WorkspaceCoordinator;
  readonly hydrationPort: WorkspaceHydrationPort;
  readonly replacements: WorkspaceFacadeSnapshot[];
  readonly applyRequests: ApplyWorkspaceBatchRequest[];
  readonly flushTargets: number[];
  readonly persistenceEvents: string[];
  readonly openTargets: string[];
  setRejectWrites(reject: boolean): void;
  setOpenFailure(workspaceId: string, fail: boolean): void;
}

function sessionSnapshot(id: string, sortOrder = 0): WorkspaceSessionSnapshot {
  return {
    id,
    sortOrder,
    kind: 'live',
    name: `Session ${id}`,
    needsRebind: true,
    lastPortHint: { displayName: `Device ${id}`, vendorId: 0x1234 },
    portConfig: {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      rxFrameGapMs: 5,
      dtr: false,
      rts: false,
    },
    document: { schemaVersion: 1, sendDraft: '' },
    displayPreferences: { schemaVersion: 1, sourceMode: 'text' },
    sendPreferences: {},
    parserState: {
      schemaVersion: 1,
      config: { kind: 'delimiter', delimiter: [13, 10], includeDelimiter: false },
      presetId: null,
    },
    featureState: {
      schemaVersion: 1,
      terminalAiModel: 'glm-5.1',
      logAiModel: 'glm-4.7',
      logAiContextMode: 'latest-n-frames',
      logAiFrameLimit: 100,
    },
    modbusConfig: {
      schemaVersion: 1,
      transport: 'rtu',
      enabled: false,
      pollIntervalMs: 1000,
      writeIntervalMs: 1000,
      timeoutMs: 500,
    },
  };
}

function definition(
  workspaceId: string,
  revision: number,
  sessions: readonly WorkspaceSessionSnapshot[] = [],
  frames: Readonly<Record<string, readonly WorkspaceHydratedFrame[]>> = {},
): WorkspaceDefinition {
  return {
    workspaceId,
    name: `Project ${workspaceId}`,
    revision,
    sessions,
    frames,
  };
}

function createSystem(
  definitions: readonly WorkspaceDefinition[],
  runtimeLifecycle?: WorkspaceRuntimeLifecycle,
  onPersistenceFailure?: () => void | Promise<void>,
): TestSystem {
  const projects = new Map(definitions.map((project) => [project.workspaceId, project]));
  const replacements: WorkspaceFacadeSnapshot[] = [];
  const applyRequests: ApplyWorkspaceBatchRequest[] = [];
  const flushTargets: number[] = [];
  const persistenceEvents: string[] = [];
  const openTargets: string[] = [];
  const openFailures = new Set<string>();
  let rejectWrites = false;
  let coordinatorId = 0;
  let hydrationId = 0;

  const coordinatorPort: WorkspaceCoordinatorPort = {
    loadCatalog: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        workspaces: Array.from(projects.values(), workspaceSummary),
      }),
    openWorkspace: (request) => {
      openTargets.push(request.workspaceId);
      if (openFailures.has(request.workspaceId)) {
        return Promise.reject(new Error('open failed'));
      }
      const project = requiredProject(projects, request.workspaceId);
      return Promise.resolve({
        requestId: request.requestId,
        workspace: workspaceSummary(project),
        header: documentHeader(project),
      });
    },
    createWorkspace: (request) => {
      const project = requiredProject(projects, 'created');
      return Promise.resolve({
        requestId: request.requestId,
        workspace: { ...workspaceSummary(project), name: request.name },
        header: { ...documentHeader(project), name: request.name },
      });
    },
    requestProjectSourceGrant: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        sourceGrantId: 'opaque-source-grant',
        displayName: 'import.bbcom',
      }),
    requestProjectTargetGrant: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        targetGrantId: 'opaque-target-grant',
        displayName: request.suggestedName,
      }),
    importProject: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        operationId: request.operationId,
        workspace: workspaceSummary(requiredProject(projects, 'imported')),
      }),
    exportProject: (request) => {
      persistenceEvents.push('export');
      return Promise.resolve({
        requestId: request.requestId,
        operationId: request.operationId,
        displayName: 'export.bbcom',
      });
    },
    cancelWorkspaceOperation: (request) =>
      Promise.resolve({
        requestId: request.requestId,
        operationId: request.operationId,
        cancellationRequested: true,
      }),
    applyWorkspaceBatch: (request) => {
      persistenceEvents.push('apply');
      applyRequests.push(request);
      if (rejectWrites) {
        const error = new Error('revision conflict');
        Object.assign(error, {
          code: 'REVISION_CONFLICT',
          messageKey: 'error.workspace_read_only',
        });
        return Promise.reject(error);
      }
      return Promise.resolve({
        clientBatchId: request.clientBatchId,
        committedRevision: request.baseRevision + 1,
      });
    },
    flushWorkspace: (request) => {
      persistenceEvents.push('flush');
      flushTargets.push(request.targetRevision);
      return Promise.resolve({
        committedRevision: request.targetRevision,
        saveHealth: 'clean',
      });
    },
  };

  const hydrationPort: WorkspaceHydrationPort = {
    hydrateSessions: (request) => {
      const project = requiredProject(projects, request.workspaceId);
      const end = Math.min(project.sessions.length, request.offset + request.limit);
      return Promise.resolve({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        revision: project.revision,
        sessions: [...project.sessions.slice(request.offset, end)],
        ...(end < project.sessions.length ? { nextOffset: end } : {}),
      });
    },
    hydrateFrames: (request) => {
      const project = requiredProject(projects, request.workspaceId);
      const frames = project.frames?.[request.sessionId] ?? [];
      const eligible = frames.filter((frame) => frame.seq >= request.fromSeq);
      const page = eligible.slice(0, request.limit);
      const next = eligible[request.limit]?.seq;
      return Promise.resolve({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: project.revision,
        frames: [...page],
        ...(next !== undefined ? { nextSeq: next } : {}),
      });
    },
    hydrateCollections: (request) => {
      const project = requiredProject(projects, request.workspaceId);
      return Promise.resolve({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: project.revision,
        collections: {
          sendHistory: [],
          quickCommands: [],
          macros: [],
          triggers: [],
          highlights: [],
          modbusRegisters: [],
        },
      });
    },
    hydrateAiMessages: (request) => {
      const project = requiredProject(projects, request.workspaceId);
      return Promise.resolve({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: project.revision,
        messages: [],
      });
    },
    hydrateWaveform: (request) => {
      const project = requiredProject(projects, request.workspaceId);
      return Promise.resolve({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: project.revision,
        channels: [],
        samples: [],
      });
    },
  };
  const facade: WorkspaceSessionFacade = {
    replaceWorkspace: (snapshot) => {
      replacements.push(snapshot);
    },
  };
  const coordinator = new WorkspaceCoordinator(coordinatorPort, {
    idFactory: (scope) => `${scope}-${++coordinatorId}`,
  });
  return {
    application: new WorkspaceApplicationService(coordinator, hydrationPort, facade, {
      requestId: () => `hydrate-${++hydrationId}`,
      ...(runtimeLifecycle ? { runtimeLifecycle } : {}),
      ...(onPersistenceFailure ? { onPersistenceFailure } : {}),
    }),
    coordinator,
    hydrationPort,
    replacements,
    applyRequests,
    flushTargets,
    persistenceEvents,
    openTargets,
    setRejectWrites(reject) {
      rejectWrites = reject;
    },
    setOpenFailure(workspaceId, fail) {
      if (fail) openFailures.add(workspaceId);
      else openFailures.delete(workspaceId);
    },
  };
}

test('open fully stages one revision and atomically installs stopped, rebind-only sessions', async () => {
  const session = sessionSnapshot('session-1');
  const frame: WorkspaceHydratedFrame = {
    seq: 5,
    id: 'restored-frame',
    direction: 'RX',
    timestampMs: 10,
    data: [1, 2, 3],
  };
  const system = createSystem([definition('workspace', 7, [session], { 'session-1': [frame] })]);
  const sessionRequests: HydrateWorkspaceSessionsRequest[] = [];
  const originalHydrateSessions = system.hydrationPort.hydrateSessions;
  system.hydrationPort.hydrateSessions = (request) => {
    sessionRequests.push(request);
    return originalHydrateSessions(request);
  };

  const outcome = await system.application.openWorkspace('workspace');
  assert.equal(outcome.outcome, 'completed');
  assert.equal(system.replacements.length, 1);
  const installed = system.replacements[0];
  assert.equal(installed.workspaceId, 'workspace');
  assert.equal(installed.revision, 7);
  assert.strictEqual(installed.activityPolicy, WORKSPACE_STOPPED_ACTIVITY_POLICY);
  assert.equal(installed.sessions[0]?.session.frames.length, 1);
  assert.equal(installed.sessions[0]?.session.isConnected, false);
  assert.equal(installed.sessions[0]?.session.autoLogEnabled, false);
  assert.equal(installed.sessions[0]?.session.logPath, null);
  assert.equal(installed.sessions[0]?.rebind.required, true);
  assert.deepEqual(sessionRequests, [
    { requestId: 'hydrate-1', workspaceId: 'workspace', offset: 0, limit: 64 },
  ]);
  assert.deepEqual(system.application.snapshot(), {
    status: 'ready',
    currentWorkspace: {
      workspaceId: 'workspace',
      name: 'Project workspace',
      revision: 7,
      activeSessionId: 'session-1',
      sessionIds: ['session-1'],
      layout: {
        version: 1,
        sidebar: { width: 292, collapsed: false },
      },
      saveHealth: 'clean',
    },
    saveHealth: 'clean',
    acceptsSaves: true,
    acceptsPersistenceEvents: true,
    readOnly: false,
    recoveryRequired: false,
    hydrating: false,
    exporting: false,
    messageKey: null,
    unsavedMutationCount: 0,
  });

  system.application.queueCapturedFrame('session-1', dataFrame('after-gap', 1));
  await system.application.flush();
  const append = system.applyRequests[0]?.mutations[0];
  assert.equal(append?.kind, 'append-frames');
  if (append?.kind === 'append-frames') assert.equal(append.payload.startSeq, 6);
});

test('header mismatch or staging failure leaves both the live facade and project document unchanged', async () => {
  const first = definition('first', 1, [sessionSnapshot('first-session')]);
  const mismatched: WorkspaceDefinition = {
    ...definition('mismatched', 2, [sessionSnapshot('only-session')]),
    headerSessionIds: ['only-session', 'missing-session'],
  };
  const system = createSystem([first, mismatched]);
  assert.equal((await system.application.openWorkspace('first')).outcome, 'completed');
  const installedBefore = system.replacements[0];

  const outcome = await system.application.openWorkspace('mismatched');
  assert.equal(outcome.outcome, 'failed');
  assert.equal(system.replacements.length, 1);
  assert.strictEqual(system.replacements[0], installedBefore);
  assert.equal(system.application.snapshot().currentWorkspace?.workspaceId, 'first');
  assert.equal(system.application.snapshot().status, 'ready');
  assert.equal(system.application.snapshot().acceptsSaves, true);
  assert.equal(system.application.snapshot().messageKey, 'workspace.hydration.failed');

  system.setOpenFailure('first', true);
  assert.equal((await system.application.openWorkspace('mismatched')).outcome, 'failed');
  assert.equal(system.replacements.length, 1);
  assert.equal(system.application.snapshot().status, 'failed');
  assert.equal(system.application.snapshot().readOnly, true);
  assert.equal(system.application.snapshot().recoveryRequired, true);
  assert.equal(system.application.snapshot().acceptsSaves, false);
  assert.equal(system.application.snapshot().messageKey, 'workspace.activation.rollback_failed');
});

test('a newer activation aborts obsolete hydration and late responses cannot overwrite it', async () => {
  const first = definition('first', 1, [sessionSnapshot('first-session')]);
  const slow = definition('slow', 2, [sessionSnapshot('slow-session')]);
  const latest = definition('latest', 3, [sessionSnapshot('latest-session')]);
  const system = createSystem([first, slow, latest]);
  assert.equal((await system.application.openWorkspace('first')).outcome, 'completed');

  const started = deferred<HydrateWorkspaceSessionsRequest>();
  const slowPage = deferred<Awaited<ReturnType<WorkspaceHydrationPort['hydrateSessions']>>>();
  const originalHydrateSessions = system.hydrationPort.hydrateSessions;
  system.hydrationPort.hydrateSessions = (request) => {
    if (request.workspaceId !== 'slow') return originalHydrateSessions(request);
    started.resolve(request);
    return slowPage.promise;
  };

  const obsolete = system.application.openWorkspace('slow');
  const slowRequest = await started.promise;
  const current = system.application.openWorkspace('latest');
  assert.equal((await current).outcome, 'completed');
  slowPage.resolve({
    requestId: slowRequest.requestId,
    workspaceId: 'slow',
    revision: 2,
    sessions: [sessionSnapshot('slow-session')],
  });
  assert.equal((await obsolete).outcome, 'stale');
  assert.deepEqual(
    system.replacements.map((snapshot) => snapshot.workspaceId),
    ['first', 'latest'],
  );
  assert.equal(system.application.snapshot().currentWorkspace?.workspaceId, 'latest');
});

test('a superseded native owner rolls back before a failing successor may activate', async () => {
  const first = definition('first', 1, [sessionSnapshot('first-session')]);
  const superseded = definition('superseded', 2, [sessionSnapshot('superseded-session')]);
  const failing = definition('failing', 3, [sessionSnapshot('failing-session')]);
  const system = createSystem([first, superseded, failing]);
  assert.equal((await system.application.openWorkspace('first')).outcome, 'completed');

  const hydrationStarted = deferred<HydrateWorkspaceSessionsRequest>();
  const latePage = deferred<Awaited<ReturnType<WorkspaceHydrationPort['hydrateSessions']>>>();
  const originalHydrateSessions = system.hydrationPort.hydrateSessions;
  system.hydrationPort.hydrateSessions = (request) => {
    if (request.workspaceId !== 'superseded') return originalHydrateSessions(request);
    hydrationStarted.resolve(request);
    return latePage.promise;
  };

  const obsolete = system.application.openWorkspace('superseded');
  const obsoleteRequest = await hydrationStarted.promise;
  system.setOpenFailure('failing', true);

  const successor = system.application.openWorkspace('failing');
  assert.equal((await obsolete).outcome, 'stale');
  assert.equal((await successor).outcome, 'failed');
  assert.deepEqual(
    system.replacements.map((snapshot) => snapshot.workspaceId),
    ['first'],
  );
  assert.equal(system.application.snapshot().currentWorkspace?.workspaceId, 'first');
  assert.equal(system.application.snapshot().status, 'ready');
  assert.equal(system.application.snapshot().recoveryRequired, false);
  assert.equal(system.application.snapshot().acceptsSaves, true);

  // The obsolete read-only hydration may settle after both ownership hand-offs;
  // it remains detached from the facade and has no rollback authority.
  latePage.resolve({
    requestId: obsoleteRequest.requestId,
    workspaceId: 'superseded',
    revision: 2,
    sessions: [sessionSnapshot('superseded-session')],
  });
  await Promise.resolve();
  assert.deepEqual(
    system.replacements.map((snapshot) => snapshot.workspaceId),
    ['first'],
  );
});

test('create and opaque-grant import both hydrate before their single facade replacement', async () => {
  const system = createSystem([
    definition('created', 0),
    definition('imported', 4, [sessionSnapshot('imported-session')]),
  ]);
  assert.equal((await system.application.createWorkspace('New project')).outcome, 'completed');
  assert.equal((await system.application.importWorkspace()).outcome, 'completed');
  assert.deepEqual(
    system.replacements.map((snapshot) => [snapshot.workspaceId, snapshot.name]),
    [
      ['created', 'New project'],
      ['imported', 'Project imported'],
    ],
  );
});

test('workspace replacement quiesces with an internal drain, flushes, then disposes before stopped activation', async () => {
  const events: string[] = [];
  const quiesceStarted = deferred<Parameters<WorkspaceRuntimeLifecycle['quiesce']>[0]>();
  const releaseQuiesce = deferred<void>();
  const lifecycle: WorkspaceRuntimeLifecycle = {
    async quiesce(context) {
      events.push(`quiesce:${context.previousWorkspaceId}`);
      quiesceStarted.resolve(context);
      await releaseQuiesce.promise;
    },
    dispose(context) {
      events.push(
        `dispose:${context.previousWorkspaceId}->${context.nextWorkspaceId}:writes=${system.applyRequests.length}`,
      );
      return Promise.resolve();
    },
    restore(context) {
      events.push(`restore:${context.previousWorkspaceId}`);
      return Promise.resolve();
    },
    activateStopped(context) {
      events.push(`activate-stopped:${context.workspace.workspaceId}`);
      return Promise.resolve();
    },
    commit(context) {
      events.push(`commit:${context.workspaceId}`);
    },
  };
  const system = createSystem(
    [
      definition('first', 1, [sessionSnapshot('shared-session')]),
      definition('next', 4, [sessionSnapshot('shared-session')]),
    ],
    lifecycle,
  );
  assert.equal((await system.application.openWorkspace('first')).outcome, 'completed');
  events.length = 0;

  const replacement = system.application.openWorkspace('next');
  const quiesce = await quiesceStarted.promise;
  assert.deepEqual(
    system.application.queueConfigMutation({
      kind: 'set-metadata',
      payload: { name: 'user mutation must stay closed' },
    }),
    { accepted: false, messageKey: 'workspace.activation.in_progress' },
  );
  assert.deepEqual(
    quiesce.persistence.queueConfigMutation({
      kind: 'set-metadata',
      payload: { name: 'final old-runtime state' },
    }),
    { accepted: true },
  );
  releaseQuiesce.resolve(undefined);
  assert.equal((await replacement).outcome, 'completed');
  assert.deepEqual(
    quiesce.persistence.queueConfigMutation({
      kind: 'set-metadata',
      payload: { name: 'late old-runtime state' },
    }),
    { accepted: false, messageKey: 'workspace.persistence.drain_closed' },
  );
  assert.deepEqual(events, [
    'quiesce:first',
    'dispose:first->next:writes=1',
    'activate-stopped:next',
    'commit:next',
  ]);
  assert.equal(system.applyRequests[0]?.mutations.length, 1);
  assert.equal(system.flushTargets.at(-1), 2);
  assert.deepEqual(
    system.replacements.map((snapshot) => snapshot.workspaceId),
    ['first', 'next'],
  );
});

test('failed stopped-runtime staging rolls native state back and restores the prior runtime set', async () => {
  const events: string[] = [];
  const lifecycle: WorkspaceRuntimeLifecycle = {
    quiesce(context) {
      events.push(`quiesce:${context.previousWorkspaceId}`);
      return Promise.resolve();
    },
    dispose(context) {
      events.push(`dispose:${context.previousWorkspaceId}->${context.nextWorkspaceId}`);
      return Promise.resolve();
    },
    restore(context) {
      events.push(`restore:${context.previousWorkspaceId}<-${context.failedWorkspaceId}`);
      return Promise.resolve();
    },
    activateStopped(context) {
      events.push(`activate-stopped:${context.workspace.workspaceId}`);
      return context.workspace.workspaceId === 'next'
        ? Promise.reject(new Error('stopped staging failed'))
        : Promise.resolve();
    },
  };
  const system = createSystem(
    [
      definition('first', 1, [sessionSnapshot('shared-session')]),
      definition('next', 2, [sessionSnapshot('shared-session')]),
    ],
    lifecycle,
  );
  assert.equal((await system.application.openWorkspace('first')).outcome, 'completed');
  events.length = 0;

  const failedActivation = await system.application.openWorkspace('next');
  assert.equal(failedActivation.outcome, 'failed');
  assert.deepEqual(events, [
    'quiesce:first',
    'dispose:first->next',
    'activate-stopped:next',
    'restore:first<-next',
  ]);
  assert.deepEqual(
    system.replacements.map((snapshot) => snapshot.workspaceId),
    ['first'],
  );
  assert.equal(system.application.snapshot().currentWorkspace?.workspaceId, 'first');
  assert.equal(system.application.snapshot().acceptsSaves, true);
});

test('one save group uses atomic batches and splits only at generated IPC limits', async () => {
  const system = createSystem([definition('workspace', 0)]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  assert.deepEqual(system.application.preflightSessionRegistration('new-session', 0, 0), {
    accepted: true,
  });
  assert.equal(
    system.application.preflightSessionRegistration('new-session', 1, 1).accepted,
    false,
  );
  const commands = Array.from({ length: 257 }, (_, index) => ({
    kind: 'set-metadata' as const,
    payload: { name: `Project ${index}` },
  }));
  assert.deepEqual(system.application.queueConfigMutations(commands), { accepted: true });
  assert.equal((await system.application.flush()).outcome, 'completed');
  assert.deepEqual(
    system.applyRequests.map((request) => ({
      baseRevision: request.baseRevision,
      mutationCount: request.mutations.length,
      firstSequence: request.mutations[0]?.sequence,
      lastSequence: request.mutations.at(-1)?.sequence,
    })),
    [
      { baseRevision: 0, mutationCount: 256, firstSequence: 0, lastSequence: 255 },
      { baseRevision: 1, mutationCount: 1, firstSequence: 256, lastSequence: 256 },
    ],
  );
});

test('logical byte partitioning keeps mutations whole and rejects one oversized structured mutation', async () => {
  const system = createSystem([definition('workspace', 0)]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  const boundedState = 'x'.repeat(300 * 1024);
  assert.deepEqual(
    system.application.queueConfigMutations([
      {
        kind: 'upsert-feature-state',
        entityId: 'plugin:first',
        payload: { feature: 'plugin', state: { value: boundedState } },
      },
      {
        kind: 'upsert-feature-state',
        entityId: 'plugin:second',
        payload: { feature: 'plugin', state: { value: boundedState } },
      },
    ]),
    { accepted: true },
  );
  assert.equal((await system.application.flush()).outcome, 'completed');
  assert.deepEqual(
    system.applyRequests.map((request) => request.mutations.length),
    [1, 1],
  );

  const oversized = createSystem([definition('oversized-workspace', 0)]);
  assert.equal(
    (await oversized.application.openWorkspace('oversized-workspace')).outcome,
    'completed',
  );
  assert.deepEqual(
    oversized.application.queueConfigMutation({
      kind: 'upsert-feature-state',
      entityId: 'plugin:oversized',
      payload: {
        feature: 'plugin',
        state: { value: 'x'.repeat(IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES + 1) },
      },
    }),
    { accepted: true },
  );
  const failedSave = await oversized.application.flush();
  assert.deepEqual(failedSave, {
    outcome: 'failed',
    messageKey: 'workspace.mutation.limit_exceeded',
    code: 'LIMIT_EXCEEDED',
  });
  assert.equal(oversized.applyRequests.length, 0);
  assert.equal(oversized.application.snapshot().unsavedMutationCount, 1);
});

test('config and frame autosave obey the fixed 300 ms and 250 ms/256/512 KiB gates', async () => {
  vi.useFakeTimers();
  try {
    const system = createSystem([definition('workspace', 0, [sessionSnapshot('session')])]);
    assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');

    assert.deepEqual(
      system.application.queueConfigMutation({
        kind: 'set-metadata',
        payload: { name: 'First' },
      }),
      { accepted: true },
    );
    await vi.advanceTimersByTimeAsync(200);
    system.application.queueConfigMutation({
      kind: 'set-metadata',
      payload: { name: 'Second' },
    });
    await vi.advanceTimersByTimeAsync(299);
    assert.equal(system.applyRequests.length, 0, 'config debounce is trailing');
    await vi.advanceTimersByTimeAsync(1);
    await system.application.flush();
    assert.deepEqual(system.applyRequests[0]?.mutations, [
      { kind: 'set-metadata', sequence: 0, payload: { name: 'First' } },
      { kind: 'set-metadata', sequence: 1, payload: { name: 'Second' } },
    ]);

    system.application.queueCapturedFrame('session', dataFrame('timer-frame', 1));
    await vi.advanceTimersByTimeAsync(249);
    assert.equal(system.applyRequests.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    await system.application.flush();

    for (let index = 0; index < 256; index += 1) {
      assert.equal(
        system.application.queueCapturedFrame('session', dataFrame(`count-${index}`, 1)).accepted,
        true,
      );
    }
    await system.application.flush();
    system.application.queueCapturedFrame('session', dataFrame('byte-threshold', 512 * 1024));
    await system.application.flush();

    const appends = system.applyRequests
      .flatMap((request) => request.mutations)
      .filter((mutation) => mutation.kind === 'append-frames');
    assert.deepEqual(
      appends.map((mutation) => [mutation.payload.startSeq, mutation.payload.frames.length]),
      [
        [0, 1],
        [1, 256],
        [257, 1],
      ],
    );
  } finally {
    vi.useRealTimers();
  }
});

test('waveform replacement and append stay ordered and use generated mutation variants', async () => {
  const system = createSystem([definition('workspace', 0, [sessionSnapshot('session')])]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');

  assert.deepEqual(
    system.application.queueWaveformReplacement(
      'session',
      [{ channelIndex: 0, config: { color: '#123456', visible: true } }],
      [{ channelIndex: 0, seq: 4, timestampMs: 100, value: 12.5 }],
    ),
    { accepted: true },
  );
  await system.application.flush();
  assert.deepEqual(
    system.applyRequests.flatMap((request) => request.mutations).map((mutation) => mutation.kind),
    ['replace-waveform-channels', 'append-waveform-samples'],
  );

  assert.deepEqual(
    system.application.queueWaveformSamples('session', [
      { channelIndex: 0, seq: 5, timestampMs: 101, value: 13 },
    ]),
    { accepted: true },
  );
  await system.application.flush();
  const last = system.applyRequests.flatMap((request) => request.mutations).at(-1);
  assert.equal(last?.kind, 'append-waveform-samples');
  if (last?.kind === 'append-waveform-samples') {
    assert.deepEqual(last.payload.samples, [
      { channelIndex: 0, seq: 5, timestampMs: 101, value: 13 },
    ]);
  }
});

test('text waveform samples and frame cursor commit in one native batch', async () => {
  const system = createSystem([definition('workspace', 0, [sessionSnapshot('session')])]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');

  assert.deepEqual(
    system.application.queueWaveformFrameIngest({
      sessionId: 'session',
      mode: 'replace',
      channels: [{ channelIndex: 0, config: { color: '#123456', visible: true } }],
      samples: [{ channelIndex: 0, seq: 0, timestampMs: 100, value: 12.5 }],
      featureState: {
        schemaVersion: 1,
        sourceMode: 'text',
        frameCursor: { consumed: 1, lastFrameId: 'frame-1' },
      },
    }),
    { accepted: true },
  );
  await system.application.flush();

  assert.equal(system.applyRequests.length, 1, 'the semantic ingest must not be batch-split');
  assert.deepEqual(
    system.applyRequests[0]?.mutations.map((mutation) => mutation.kind),
    ['replace-waveform-channels', 'append-waveform-samples', 'upsert-feature-state'],
  );
  const cursor = system.applyRequests[0]?.mutations.at(-1);
  assert.equal(cursor?.kind, 'upsert-feature-state');
  if (cursor?.kind === 'upsert-feature-state') {
    assert.deepEqual(cursor.payload.state, {
      schemaVersion: 1,
      sourceMode: 'text',
      frameCursor: { consumed: 1, lastFrameId: 'frame-1' },
    });
  }
});

test('capture preflight, persisted trim, and one-slot undo keep sequence accounting aligned', async () => {
  const restoredFrame: WorkspaceHydratedFrame = {
    seq: 5,
    id: 'restored',
    direction: 'RX',
    timestampMs: 1,
    data: [1, 2, 3],
  };
  const system = createSystem([
    definition('workspace', 0, [sessionSnapshot('session')], { session: [restoredFrame] }),
  ]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  assert.deepEqual(
    system.application.preflightCapturedFrame('session', {
      direction: 'RX',
      data: new Uint8Array([4]),
    }),
    { accepted: true },
  );
  assert.equal(
    system.application.preflightCapturedFrame('session', {
      direction: 'RX',
      data: new Uint8Array(IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES + 1),
    }).accepted,
    false,
  );

  assert.deepEqual(system.application.queueCaptureTrim('session', 1, 3), { accepted: true });
  await system.application.flush();
  const trim = system.applyRequests.flatMap((request) => request.mutations).at(0);
  assert.deepEqual(trim, {
    kind: 'trim-capture',
    sequence: 0,
    sessionId: 'session',
    payload: { frameCount: 1 },
  });

  system.application.forgetSession('session');
  assert.deepEqual(system.application.registerSession('session'), { accepted: true });
  assert.deepEqual(system.application.queueCapturedFrame('session', dataFrame('after-undo', 1)), {
    accepted: true,
  });
  await system.application.flush();
  const append = system.applyRequests
    .flatMap((request) => request.mutations)
    .find((mutation) => mutation.kind === 'append-frames');
  assert.equal(append?.kind, 'append-frames');
  if (append?.kind === 'append-frames') assert.equal(append.payload.startSeq, 6);
});

test('a synchronous facade rejection latches degraded state instead of disappearing in a log', async () => {
  let quiesceRequests = 0;
  const system = createSystem([definition('workspace', 0)], undefined, () => {
    quiesceRequests += 1;
  });
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  system.application.rejectPersistence('workspace.capture.invalid_trim');
  assert.equal(system.application.snapshot().saveHealth, 'degraded');
  assert.equal(system.application.snapshot().acceptsSaves, false);
  assert.equal(system.application.snapshot().messageKey, 'workspace.capture.invalid_trim');
  assert.deepEqual(
    system.application.queueConfigMutation({ kind: 'set-metadata', payload: { name: 'blocked' } }),
    { accepted: false, messageKey: 'workspace.capture.invalid_trim' },
  );
  assert.equal(quiesceRequests, 1);
  system.application.rejectPersistence('workspace.mutation.invalid');
  assert.equal(quiesceRequests, 1, 'one fatal latch requests quiesce exactly once');
});

test('flush is a save barrier and a revision conflict permanently exposes read-only state', async () => {
  const system = createSystem([definition('workspace', 5, [sessionSnapshot('session')])]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  system.application.queueConfigMutation({
    kind: 'set-active-session',
    sessionId: 'session',
  });
  system.application.queueCapturedFrame('session', dataFrame('frame', 2));
  const saved = await system.application.flush();
  assert.equal(saved.outcome, 'completed');
  assert.deepEqual(
    system.applyRequests.map((request) => [request.baseRevision, request.mutations[0]?.kind]),
    [
      [5, 'set-active-session'],
      [6, 'append-frames'],
    ],
  );
  assert.equal(system.flushTargets.at(-1), 7);

  system.setRejectWrites(true);
  system.application.queueConfigMutation({
    kind: 'set-metadata',
    payload: { name: 'Conflicting edit' },
  });
  const conflicted = await system.application.flush();
  assert.equal(conflicted.outcome, 'failed');
  assert.equal(system.application.snapshot().readOnly, true);
  assert.equal(system.application.snapshot().saveHealth, 'readOnly');
  assert.equal(system.application.snapshot().acceptsSaves, false);
  assert.deepEqual(
    system.application.queueConfigMutation({ kind: 'set-metadata', payload: { name: 'Later' } }),
    { accepted: false, messageKey: 'error.workspace_read_only' },
  );
});

test('project export snapshots one flushed revision and queues later mutations behind it', async () => {
  const system = createSystem([definition('workspace', 0)]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  system.application.queueConfigMutation({
    kind: 'set-metadata',
    payload: { name: 'Included in export' },
  });

  const exported = system.application.exportWorkspace('workspace.bbcom');
  system.application.queueConfigMutation({
    kind: 'set-metadata',
    payload: { name: 'After export boundary' },
  });

  assert.equal((await exported).outcome, 'completed');
  assert.deepEqual(system.persistenceEvents, ['apply', 'flush', 'export']);
  assert.equal((await system.application.flush()).outcome, 'completed');
  assert.deepEqual(system.persistenceEvents, ['apply', 'flush', 'export', 'apply', 'flush']);
});

test('idle save gates, restoration and subscriptions expose stable application outcomes', async () => {
  const idle = createSystem([definition('workspace', 0)]);
  assert.deepEqual(await idle.application.flush(), {
    outcome: 'failed',
    messageKey: 'workspace.no_active_project',
  });
  assert.deepEqual(
    idle.application.queueOrderedMutations([
      { kind: 'set-metadata', payload: { name: 'not active' } },
    ]),
    { accepted: false, messageKey: 'workspace.no_active_project' },
  );
  assert.deepEqual(idle.application.queueCaptureReset('missing'), {
    accepted: false,
    messageKey: 'workspace.no_active_project',
  });
  assert.deepEqual(idle.application.queueCaptureTrim('missing', 1, 0), {
    accepted: false,
    messageKey: 'workspace.no_active_project',
  });
  assert.deepEqual(
    idle.application.queueCapturedFrame({
      sessionId: 'missing',
      frame: dataFrame('not-active', 1),
    }),
    { accepted: false, messageKey: 'workspace.no_active_project' },
  );
  assert.deepEqual(
    idle.application.preflightCapturedFrame('missing', {
      direction: 'RX',
      data: new Uint8Array([1]),
    }),
    { accepted: false, messageKey: 'workspace.no_active_project' },
  );
  assert.deepEqual(idle.application.preflightSessionRegistration('new-session', 0, 0), {
    accepted: false,
    messageKey: 'workspace.no_active_project',
  });
  assert.equal(idle.application.cancelActivation(), false);
  assert.equal(await idle.application.cancelExport(), null);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(
    await idle.application.restoreLastActiveWorkspace('workspace', alreadyAborted.signal),
    { outcome: 'cancelled' },
  );

  const abortAfterCatalog = new AbortController();
  const cancelledRestore = idle.application.restoreLastActiveWorkspace(
    'workspace',
    abortAfterCatalog.signal,
  );
  abortAfterCatalog.abort();
  assert.deepEqual(await cancelledRestore, { outcome: 'cancelled' });

  let throwingObserverCalls = 0;
  const detachThrowing = idle.application.subscribe(() => {
    throwingObserverCalls += 1;
    throw new Error('observer failure');
  });
  const observed: string[] = [];
  const detach = idle.application.subscribe((snapshot) => observed.push(snapshot.status));
  assert.equal(
    (await idle.application.restoreLastActiveWorkspace('workspace')).outcome,
    'completed',
  );
  assert.equal(
    (await idle.application.restoreLastActiveWorkspace('unused-fallback')).outcome,
    'completed',
  );
  assert.equal(throwingObserverCalls > 1, true);
  assert.equal(observed.includes('ready'), true);
  detachThrowing();
  detach();
  const countAfterDetach = observed.length;
  idle.application.queueConfigMutation({ kind: 'set-metadata', payload: { name: 'detached' } });
  assert.equal(observed.length, countAfterDetach);
  await idle.application.flush();

  const defaultIds = createSystem([definition('default-id-workspace', 0)]);
  const applicationWithDefaultIds = new WorkspaceApplicationService(
    defaultIds.coordinator,
    defaultIds.hydrationPort,
    { replaceWorkspace: () => undefined },
  );
  assert.equal(
    (await applicationWithDefaultIds.openWorkspace('default-id-workspace')).outcome,
    'completed',
  );
});

test('mutation queues reject cyclic and oversized recovery units without scheduling partial writes', async () => {
  const system = createSystem([definition('workspace', 0, [sessionSnapshot('session')])]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');

  const cyclicState: Record<string, unknown> = {};
  cyclicState.self = cyclicState;
  assert.deepEqual(
    system.application.queueConfigMutation({
      kind: 'upsert-feature-state',
      entityId: 'session',
      payload: { feature: 'plugin', state: cyclicState },
    }),
    { accepted: false, messageKey: 'workspace.mutation.invalid' },
  );
  assert.deepEqual(
    system.application.queueOrderedMutations([
      {
        kind: 'set-metadata',
        payload: { name: 'cyclic', extra: cyclicState } as never,
      },
    ]),
    { accepted: false, messageKey: 'workspace.mutation.invalid' },
  );

  const cyclicConfig: Record<string, unknown> = {};
  cyclicConfig.self = cyclicConfig;
  assert.deepEqual(
    system.application.queueWaveformReplacement(
      'session',
      [{ channelIndex: 0, config: cyclicConfig }],
      [],
    ),
    { accepted: false, messageKey: 'workspace.mutation.invalid' },
  );
  assert.deepEqual(
    system.application.queueWaveformFrameIngest({
      sessionId: 'session',
      mode: 'append',
      channels: [],
      samples: [],
      featureState: cyclicState,
    }),
    { accepted: false, messageKey: 'workspace.mutation.invalid' },
  );

  assert.deepEqual(system.application.queueConfigMutations([]), { accepted: true });
  assert.deepEqual(system.application.queueOrderedMutations([]), { accepted: true });
  assert.deepEqual(system.application.queueWaveformSamples('session', []), { accepted: true });
  for (const outcome of [
    system.application.queueWaveformReplacement('missing', [], []),
    system.application.queueWaveformSamples('missing', []),
    system.application.queueWaveformFrameIngest({
      sessionId: 'missing',
      mode: 'append',
      channels: [],
      samples: [],
      featureState: {},
    }),
  ]) {
    assert.deepEqual(outcome, { accepted: false, messageKey: 'workspace.no_active_project' });
  }

  const oversizedSamples = Array.from({ length: 16_000 }, (_, index) => ({
    channelIndex: index % 8,
    seq: index,
    timestampMs: index,
    value: index + 0.25,
  }));
  assert.deepEqual(
    system.application.queueWaveformFrameIngest({
      sessionId: 'session',
      mode: 'replace',
      channels: [],
      samples: oversizedSamples,
      featureState: { schemaVersion: 1, sourceMode: 'text' },
    }),
    { accepted: false, messageKey: 'workspace.mutation.limit_exceeded' },
  );
  assert.equal(system.applyRequests.length, 0);
});

test('session registration and capture accounting reject every invalid boundary without mutation', async () => {
  const system = createSystem([
    definition('workspace', 0, [sessionSnapshot('alpha'), sessionSnapshot('beta')]),
  ]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  const state = system.application as unknown as {
    nextFrameSequence: Map<string, number>;
    sessionFrameCounts: Map<string, number>;
    sessionCaptureBytes: Map<string, number>;
    workspaceFrameCount: number;
    workspaceCaptureBytes: number;
    undoCaptureState: {
      sessionId: string;
      nextSequence: number;
      frameCount: number;
      captureBytes: number;
    } | null;
  };

  assert.deepEqual(system.application.registerSession('alpha'), { accepted: true });
  for (const [sessionId, frameCount, captureBytes, messageKey] of [
    ['bad/id', 0, 0, 'workspace.capture.invalid_session'],
    ['new-session', Number.NaN, 0, 'workspace.capture.invalid_session'],
    ['new-session', -1, 0, 'workspace.capture.invalid_session'],
    ['new-session', 0, Number.NaN, 'workspace.capture.invalid_session'],
    ['new-session', 0, -1, 'workspace.capture.invalid_session'],
    ['new-session', 1, 1, 'workspace.capture.invalid_restore'],
  ] as const) {
    assert.deepEqual(
      system.application.preflightSessionRegistration(sessionId, frameCount, captureBytes),
      { accepted: false, messageKey },
    );
  }

  system.application.forgetSession('alpha');
  assert.deepEqual(system.application.preflightSessionRegistration('alpha', 1, 0), {
    accepted: false,
    messageKey: 'workspace.capture.invalid_restore',
  });
  assert.deepEqual(system.application.registerSession('alpha'), { accepted: true });
  system.application.unregisterSession('alpha');
  assert.deepEqual(system.application.registerSession('alpha'), { accepted: true });

  const originalFrameCount = state.workspaceFrameCount;
  const originalCaptureBytes = state.workspaceCaptureBytes;
  const dummyIds: string[] = [];
  for (
    let index = state.nextFrameSequence.size;
    index < IPC_LIMITS.MAX_WORKSPACE_SESSIONS;
    index++
  ) {
    const id = `dummy-${index}`;
    dummyIds.push(id);
    state.nextFrameSequence.set(id, 0);
  }
  assert.deepEqual(system.application.preflightSessionRegistration('one-too-many', 0, 0), {
    accepted: false,
    messageKey: 'workspace.capture.limit_exceeded',
  });
  for (const id of dummyIds) state.nextFrameSequence.delete(id);

  assert.deepEqual(
    system.application.preflightSessionRegistration(
      'too-many-frames',
      IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION + 1,
      0,
    ),
    { accepted: false, messageKey: 'workspace.capture.invalid_restore' },
  );
  state.undoCaptureState = {
    sessionId: 'too-many-frames',
    nextSequence: 0,
    frameCount: IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION + 1,
    captureBytes: 0,
  };
  assert.deepEqual(
    system.application.preflightSessionRegistration(
      'too-many-frames',
      IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION + 1,
      0,
    ),
    { accepted: false, messageKey: 'workspace.capture.limit_exceeded' },
  );
  state.undoCaptureState = {
    sessionId: 'workspace-frame-limit',
    nextSequence: 0,
    frameCount: 1,
    captureBytes: 0,
  };
  state.workspaceFrameCount = IPC_LIMITS.MAX_WORKSPACE_FRAMES;
  assert.deepEqual(system.application.preflightSessionRegistration('workspace-frame-limit', 1, 0), {
    accepted: false,
    messageKey: 'workspace.capture.limit_exceeded',
  });
  state.undoCaptureState = {
    sessionId: 'workspace-byte-limit',
    nextSequence: 0,
    frameCount: 0,
    captureBytes: 1,
  };
  state.workspaceFrameCount = originalFrameCount;
  state.workspaceCaptureBytes = IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES;
  assert.deepEqual(system.application.preflightSessionRegistration('workspace-byte-limit', 0, 1), {
    accepted: false,
    messageKey: 'workspace.capture.limit_exceeded',
  });
  state.workspaceCaptureBytes = originalCaptureBytes;
  state.undoCaptureState = null;

  for (const [sessionId, frame] of [
    ['missing', { direction: 'RX', data: new Uint8Array([1]) }],
    ['alpha', { direction: 'invalid', data: new Uint8Array([1]) }],
    ['alpha', { direction: 'RX', data: [1] }],
    ['alpha', { direction: 'RX', data: new Uint8Array(IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES + 1) }],
  ] as const) {
    assert.deepEqual(system.application.preflightCapturedFrame(sessionId, frame as never), {
      accepted: false,
      messageKey: 'workspace.capture.invalid',
    });
  }

  const alphaCount = state.sessionFrameCounts.get('alpha') ?? 0;
  state.sessionFrameCounts.set('alpha', IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION);
  assert.deepEqual(
    system.application.preflightCapturedFrame('alpha', {
      direction: 'RX',
      data: new Uint8Array([1]),
    }),
    { accepted: false, messageKey: 'workspace.capture.limit_exceeded' },
  );
  state.sessionFrameCounts.set('alpha', alphaCount);
  state.workspaceFrameCount = IPC_LIMITS.MAX_WORKSPACE_FRAMES;
  assert.equal(
    system.application.preflightCapturedFrame('alpha', {
      direction: 'RX',
      data: new Uint8Array([1]),
    }).accepted,
    false,
  );
  state.workspaceFrameCount = originalFrameCount;
  state.workspaceCaptureBytes = IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES;
  assert.equal(
    system.application.preflightCapturedFrame('alpha', {
      direction: 'RX',
      data: new Uint8Array([1]),
    }).accepted,
    false,
  );
  state.workspaceCaptureBytes = originalCaptureBytes;
});

test('captured-frame ordering, reset and trim boundaries preserve exact append sequences', async () => {
  const system = createSystem([
    definition('workspace', 0, [sessionSnapshot('alpha'), sessionSnapshot('beta')]),
  ]);
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  const state = system.application as unknown as {
    nextFrameSequence: Map<string, number>;
    sessionFrameCounts: Map<string, number>;
    sessionCaptureBytes: Map<string, number>;
    workspaceFrameCount: number;
    workspaceCaptureBytes: number;
  };

  assert.deepEqual(
    system.application.queueCapturedFrame({ sessionId: 'alpha', frame: dataFrame('object', 1) }),
    { accepted: true },
  );
  assert.deepEqual(
    system.application.queueCapturedFrame({ sessionId: 'missing', frame: dataFrame('missing', 1) }),
    { accepted: false, messageKey: 'workspace.capture.invalid_session' },
  );
  assert.deepEqual(
    system.application.queueCapturedFrame({ sessionId: 'alpha', frame: null as never }),
    { accepted: false, messageKey: 'workspace.capture.invalid_session' },
  );

  const nextAlpha = state.nextFrameSequence.get('alpha') ?? 0;
  state.nextFrameSequence.set('alpha', Number.MAX_SAFE_INTEGER);
  assert.deepEqual(system.application.queueCapturedFrame('alpha', dataFrame('exhausted', 1)), {
    accepted: false,
    messageKey: 'workspace.capture.sequence_exhausted',
  });
  state.nextFrameSequence.set('alpha', nextAlpha);
  assert.deepEqual(
    system.application.queueCapturedFrame('alpha', {
      ...dataFrame('invalid-frame', 1),
      timestamp: -1,
    }),
    { accepted: false, messageKey: 'workspace.capture.invalid' },
  );

  const alphaCount = state.sessionFrameCounts.get('alpha') ?? 0;
  state.sessionFrameCounts.set('alpha', IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION);
  assert.deepEqual(system.application.queueCapturedFrame('alpha', dataFrame('session-limit', 1)), {
    accepted: false,
    messageKey: 'workspace.capture.limit_exceeded',
  });
  state.sessionFrameCounts.set('alpha', alphaCount);
  const workspaceCount = state.workspaceFrameCount;
  state.workspaceFrameCount = IPC_LIMITS.MAX_WORKSPACE_FRAMES;
  assert.equal(
    system.application.queueCapturedFrame('alpha', dataFrame('workspace-limit', 1)).accepted,
    false,
  );
  state.workspaceFrameCount = workspaceCount;
  const workspaceBytes = state.workspaceCaptureBytes;
  state.workspaceCaptureBytes = IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES;
  assert.equal(
    system.application.queueCapturedFrame('alpha', dataFrame('byte-limit', 1)).accepted,
    false,
  );
  state.workspaceCaptureBytes = workspaceBytes;

  system.application.queueCapturedFrame('beta', dataFrame('other-session', 1));
  system.application.queueCapturedFrame('alpha', dataFrame('large-a', 300 * 1024));
  system.application.queueCapturedFrame('alpha', dataFrame('large-b', 300 * 1024));
  system.application.queueCapturedFrame('beta', dataFrame('single-large', 600 * 1024));
  assert.equal((await system.application.flush()).outcome, 'completed');
  const appends = system.applyRequests
    .flatMap((request) => request.mutations)
    .filter((mutation) => mutation.kind === 'append-frames');
  assert.equal(
    appends.some((mutation) => mutation.sessionId === 'alpha'),
    true,
  );
  assert.equal(
    appends.some((mutation) => mutation.sessionId === 'beta'),
    true,
  );
  assert.equal(
    appends.some((mutation) => mutation.payload.frames[0]?.data.length === 600 * 1024),
    true,
  );

  const frameCount = state.sessionFrameCounts.get('alpha') ?? 0;
  const captureBytes = state.sessionCaptureBytes.get('alpha') ?? 0;
  const invalidTrims = [
    ['missing', 1, 0],
    ['alpha', Number.NaN, 0],
    ['alpha', 0, 0],
    ['alpha', frameCount + 1, 0],
    ['alpha', 1, Number.NaN],
    ['alpha', 1, -1],
    ['alpha', 1, captureBytes + 1],
  ] as const;
  for (const [sessionId, droppedFrames, droppedBytes] of invalidTrims) {
    assert.deepEqual(system.application.queueCaptureTrim(sessionId, droppedFrames, droppedBytes), {
      accepted: false,
      messageKey: 'workspace.capture.invalid_trim',
    });
  }
  state.sessionFrameCounts.set('alpha', 0x1_0000_0000);
  assert.equal(system.application.queueCaptureTrim('alpha', 0x1_0000_0000, 0).accepted, false);
  state.sessionFrameCounts.set('alpha', frameCount);

  assert.deepEqual(system.application.queueCaptureReset('alpha'), { accepted: true });
  assert.equal((await system.application.flush()).outcome, 'completed');
  assert.deepEqual(system.application.queueCapturedFrame('alpha', dataFrame('after-reset', 1)), {
    accepted: true,
  });
  assert.equal((await system.application.flush()).outcome, 'completed');
  const lastAppend = system.applyRequests
    .flatMap((request) => request.mutations)
    .filter((mutation) => mutation.kind === 'append-frames')
    .at(-1);
  assert.equal(lastAppend?.kind, 'append-frames');
  if (lastAppend?.kind === 'append-frames') assert.equal(lastAppend.payload.startSeq, 0);

  system.application.forgetSession('not-registered');
  assert.deepEqual(system.application.queueCaptureReset('not-registered'), {
    accepted: false,
    messageKey: 'workspace.no_active_project',
  });
});

test('unserializable buffered commands latch once and retain abandoned work', async () => {
  const failures: string[] = [];
  const system = createSystem(
    [definition('workspace', 0, [sessionSnapshot('session')])],
    undefined,
    () => {
      failures.push('sync');
      throw new Error('failure observer throws');
    },
  );
  assert.equal((await system.application.openWorkspace('workspace')).outcome, 'completed');
  system.application.queueConfigMutation({
    kind: 'upsert-feature-state',
    entityId: 'plugin:bigint',
    payload: { feature: 'plugin', state: { value: 1n } },
  });
  system.application.queueCapturedFrame('session', dataFrame('retained-frame', 1));
  const outcome = await system.application.flush();
  assert.deepEqual(outcome, {
    outcome: 'failed',
    messageKey: 'workspace.mutation.limit_exceeded',
    code: 'LIMIT_EXCEEDED',
  });
  assert.deepEqual(failures, ['sync']);
  assert.equal(system.application.snapshot().unsavedMutationCount, 2);
  assert.deepEqual(
    system.application.queueConfigMutation({ kind: 'set-metadata', payload: { name: 'closed' } }),
    { accepted: false, messageKey: 'workspace.mutation.limit_exceeded' },
  );

  const asyncFailure = createSystem([definition('async-failure', 0)], undefined, () =>
    Promise.reject(new Error('async observer rejects')),
  );
  assert.equal(
    (await asyncFailure.application.openWorkspace('async-failure')).outcome,
    'completed',
  );
  asyncFailure.application.rejectPersistence('workspace.save.failed');
  await Promise.resolve();

  const mismatch = createSystem([definition('mismatch', 0)]);
  assert.equal((await mismatch.application.openWorkspace('mismatch')).outcome, 'completed');
  (mismatch.coordinator as unknown as { active: unknown }).active = null;
  assert.deepEqual(await mismatch.application.flush(), {
    outcome: 'failed',
    messageKey: 'workspace.activation.incomplete',
  });
});

function workspaceSummary(project: WorkspaceDefinition): WorkspaceSummary {
  return {
    workspaceId: project.workspaceId,
    name: project.name,
    revision: project.revision,
    updatedAtMs: 1,
    saveHealth: 'clean',
  };
}

function documentHeader(project: WorkspaceDefinition): WorkspaceDocumentHeader {
  const sessionIds = project.headerSessionIds ?? project.sessions.map((session) => session.id);
  return {
    workspaceId: project.workspaceId,
    name: project.name,
    revision: project.revision,
    ...(sessionIds[0] ? { activeSessionId: sessionIds[0] } : {}),
    sessionIds: [...sessionIds],
    layout: {},
  };
}

function requiredProject(
  projects: ReadonlyMap<string, WorkspaceDefinition>,
  workspaceId: string,
): WorkspaceDefinition {
  const project = projects.get(workspaceId);
  if (!project) throw new Error(`missing test workspace ${workspaceId}`);
  return project;
}

function dataFrame(id: string, size: number): DataFrame {
  return {
    id,
    direction: 'RX',
    timestamp: 1,
    data: new Uint8Array(size),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
