import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  ApplyWorkspaceBatchRequest,
  ApplyWorkspaceBatchResponse,
  CancelWorkspaceOperationRequest,
  CancelWorkspaceOperationResponse,
  CreateWorkspaceCommandRequest,
  CreateWorkspaceCommandResponse,
  DeleteWorkspaceRequest,
  DeleteWorkspaceResponse,
  ExportProjectRequest,
  ExportProjectResponse,
  FlushWorkspaceRequest,
  FlushWorkspaceResponse,
  ImportProjectRequest,
  ImportProjectResponse,
  OpenWorkspaceRequest,
  OpenWorkspaceResponse,
  ProjectSourceGrantResponse,
  ProjectTargetGrantResponse,
  RequestProjectSourceGrantRequest,
  RequestProjectTargetGrantRequest,
  WorkspaceCatalogRequest,
  WorkspaceCatalogResponse,
  WorkspaceDocumentHeader,
  WorkspaceSummary,
} from '@/generated/ipc-contracts.ts';
import {
  WorkspaceCoordinator,
  type WorkspaceCoordinatorPort,
  type WorkspaceMutationCommand,
  type WorkspaceOperationLifecyclePort,
} from '@/features/workspace/index.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function summary(
  workspaceId: string,
  revision = 0,
  updatedAtMs = 1,
  name = `Project ${workspaceId}`,
): WorkspaceSummary {
  return { workspaceId, name, revision, updatedAtMs, saveHealth: 'clean' };
}

function header(
  workspaceId: string,
  revision = 0,
  name = `Project ${workspaceId}`,
): WorkspaceDocumentHeader {
  return { workspaceId, name, revision, sessionIds: [], layout: {} };
}

function openResponse(requestId: string, workspaceId: string, revision = 0): OpenWorkspaceResponse {
  return {
    requestId,
    workspace: summary(workspaceId, revision),
    header: header(workspaceId, revision),
  };
}

function sequenceIds(): (
  scope: 'catalog' | 'activate' | 'delete' | 'export' | 'batch' | 'flush',
) => string {
  let sequence = 0;
  return (scope) => `${scope}-${++sequence}`;
}

interface PortOverrides {
  loadCatalog?: WorkspaceCoordinatorPort['loadCatalog'];
  openWorkspace?: WorkspaceCoordinatorPort['openWorkspace'];
  createWorkspace?: WorkspaceCoordinatorPort['createWorkspace'];
  deleteWorkspace?: WorkspaceCoordinatorPort['deleteWorkspace'];
  requestProjectSourceGrant?: WorkspaceCoordinatorPort['requestProjectSourceGrant'];
  requestProjectTargetGrant?: WorkspaceCoordinatorPort['requestProjectTargetGrant'];
  importProject?: WorkspaceCoordinatorPort['importProject'];
  exportProject?: WorkspaceCoordinatorPort['exportProject'];
  cancelWorkspaceOperation?: WorkspaceCoordinatorPort['cancelWorkspaceOperation'];
  applyWorkspaceBatch?: WorkspaceCoordinatorPort['applyWorkspaceBatch'];
  flushWorkspace?: WorkspaceCoordinatorPort['flushWorkspace'];
}

function createPort(overrides: PortOverrides = {}): WorkspaceCoordinatorPort {
  return {
    loadCatalog:
      overrides.loadCatalog ??
      ((request: WorkspaceCatalogRequest): Promise<WorkspaceCatalogResponse> =>
        Promise.resolve({ requestId: request.requestId, workspaces: [] })),
    openWorkspace:
      overrides.openWorkspace ??
      ((request: OpenWorkspaceRequest): Promise<OpenWorkspaceResponse> =>
        Promise.resolve(openResponse(request.requestId, request.workspaceId))),
    createWorkspace:
      overrides.createWorkspace ??
      ((request: CreateWorkspaceCommandRequest): Promise<CreateWorkspaceCommandResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          workspace: summary('created', 0, 1, request.name),
          header: header('created', 0, request.name),
        })),
    deleteWorkspace:
      overrides.deleteWorkspace ??
      ((request: DeleteWorkspaceRequest): Promise<DeleteWorkspaceResponse> =>
        Promise.resolve({ requestId: request.requestId, workspaceId: request.workspaceId })),
    requestProjectSourceGrant:
      overrides.requestProjectSourceGrant ??
      ((request: RequestProjectSourceGrantRequest): Promise<ProjectSourceGrantResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          sourceGrantId: 'source-grant',
          displayName: 'project.bbcom',
        })),
    requestProjectTargetGrant:
      overrides.requestProjectTargetGrant ??
      ((request: RequestProjectTargetGrantRequest): Promise<ProjectTargetGrantResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          targetGrantId: 'target-grant',
          displayName: request.suggestedName,
        })),
    importProject:
      overrides.importProject ??
      ((request: ImportProjectRequest): Promise<ImportProjectResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          operationId: request.operationId,
          workspace: summary('imported'),
        })),
    exportProject:
      overrides.exportProject ??
      ((request: ExportProjectRequest): Promise<ExportProjectResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          operationId: request.operationId,
          displayName: 'project.bbcom',
        })),
    cancelWorkspaceOperation:
      overrides.cancelWorkspaceOperation ??
      ((request: CancelWorkspaceOperationRequest): Promise<CancelWorkspaceOperationResponse> =>
        Promise.resolve({
          requestId: request.requestId,
          operationId: request.operationId,
          cancellationRequested: true,
        })),
    applyWorkspaceBatch:
      overrides.applyWorkspaceBatch ??
      ((request: ApplyWorkspaceBatchRequest): Promise<ApplyWorkspaceBatchResponse> =>
        Promise.resolve({
          clientBatchId: request.clientBatchId,
          committedRevision: request.baseRevision + 1,
        })),
    flushWorkspace:
      overrides.flushWorkspace ??
      ((request: FlushWorkspaceRequest): Promise<FlushWorkspaceResponse> =>
        Promise.resolve({ committedRevision: request.targetRevision, saveHealth: 'clean' })),
  };
}

test('catalog refresh ignores stale responses and exposes a bounded recent-project home model', async () => {
  const first = deferred<WorkspaceCatalogResponse>();
  const second = deferred<WorkspaceCatalogResponse>();
  let calls = 0;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      loadCatalog: (request) => {
        calls += 1;
        return calls === 1
          ? first.promise
          : second.promise.then((response) => ({ ...response, requestId: request.requestId }));
      },
    }),
    { idFactory: sequenceIds() },
  );

  const staleRefresh = coordinator.refreshCatalog();
  const currentRefresh = coordinator.refreshCatalog();
  second.resolve({
    requestId: 'ignored',
    workspaces: Array.from({ length: 15 }, (_, index) =>
      summary(`workspace-${index}`, index, index),
    ),
    activeWorkspaceId: 'workspace-14',
  });
  assert.equal((await currentRefresh).outcome, 'completed');
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.library.status, 'ready');
  assert.equal(snapshot.library.recentProjects.length, 12);
  assert.equal(snapshot.library.projects.length, 15);
  assert.equal(snapshot.library.recentProjects[0]?.workspaceId, 'workspace-14');
  assert.equal(snapshot.library.recentProjects[0]?.active, true);
  assert.deepEqual(snapshot.library.actions, {
    newProject: { id: 'new-project', enabled: true, busy: false },
    openProject: { id: 'open-project', enabled: true, busy: false },
    importProject: { id: 'import-project', enabled: true, busy: false },
  });

  first.resolve({
    requestId: 'catalog-1',
    workspaces: [summary('old-workspace', 99, 99)],
    activeWorkspaceId: 'old-workspace',
  });
  assert.equal((await staleRefresh).outcome, 'stale');
  assert.equal(coordinator.snapshot().library.recentProjects[0]?.workspaceId, 'workspace-14');
});

test('selecting a project changes only active state and never reorders the library', async () => {
  const catalog = [
    summary('workspace-a', 1, 100, 'Alpha'),
    summary('workspace-b', 2, 300, 'Beta'),
    summary('workspace-c', 3, 200, 'Gamma'),
  ];
  const coordinator = new WorkspaceCoordinator(
    createPort({
      loadCatalog: (request) =>
        Promise.resolve({ requestId: request.requestId, workspaces: catalog }),
      openWorkspace: (request) =>
        Promise.resolve({
          requestId: request.requestId,
          workspace: catalog.find((project) => project.workspaceId === request.workspaceId)!,
          header: header(
            request.workspaceId,
            catalog.find((project) => project.workspaceId === request.workspaceId)!.revision,
            catalog.find((project) => project.workspaceId === request.workspaceId)!.name,
          ),
        }),
    }),
    { idFactory: sequenceIds() },
  );

  await coordinator.refreshCatalog();
  const initialOrder = coordinator
    .snapshot()
    .library.projects.map((project) => project.workspaceId);
  assert.deepEqual(initialOrder, ['workspace-a', 'workspace-b', 'workspace-c']);
  assert.deepEqual(
    coordinator.snapshot().library.recentProjects.map((project) => project.workspaceId),
    ['workspace-b', 'workspace-c', 'workspace-a'],
  );

  await coordinator.openWorkspace('workspace-c');
  const selected = coordinator.snapshot().library;
  assert.deepEqual(
    selected.projects.map((project) => project.workspaceId),
    initialOrder,
  );
  assert.equal(
    selected.projects.find((project) => project.workspaceId === 'workspace-c')?.active,
    true,
  );
  assert.deepEqual(
    selected.recentProjects.map((project) => project.workspaceId),
    ['workspace-b', 'workspace-c', 'workspace-a'],
  );

  await coordinator.openWorkspace('workspace-a');
  assert.deepEqual(
    coordinator.snapshot().library.projects.map((project) => project.workspaceId),
    initialOrder,
  );
});

test('deleting projects clears active state when the selected row is removed', async () => {
  const deleted: string[] = [];
  const coordinator = new WorkspaceCoordinator(
    createPort({
      loadCatalog: (request) =>
        Promise.resolve({
          requestId: request.requestId,
          workspaces: [summary('workspace-a'), summary('workspace-b')],
          activeWorkspaceId: 'workspace-a',
        }),
      deleteWorkspace: (request) => {
        deleted.push(request.workspaceId);
        return Promise.resolve({
          requestId: request.requestId,
          workspaceId: request.workspaceId,
        });
      },
    }),
    { idFactory: sequenceIds() },
  );

  await coordinator.refreshCatalog();
  assert.equal((await coordinator.deleteWorkspace('workspace-b')).outcome, 'completed');
  assert.deepEqual(deleted, ['workspace-b']);
  assert.deepEqual(
    coordinator.snapshot().library.projects.map((project) => project.workspaceId),
    ['workspace-a'],
  );
  assert.equal((await coordinator.deleteWorkspace('workspace-a')).outcome, 'completed');
  assert.deepEqual(deleted, ['workspace-b', 'workspace-a']);
  assert.equal(coordinator.activeWorkspaceId, null);
  assert.deepEqual(coordinator.snapshot().library.projects, []);
  assert.equal(coordinator.snapshot().library.status, 'idle');
});

test('open cancellation and overlapping activation cannot replace the current workspace', async () => {
  const slow = deferred<OpenWorkspaceResponse>();
  let slowSignal: AbortSignal | undefined;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request, context) => {
        if (request.workspaceId === 'slow') {
          slowSignal = context.signal;
          return slow.promise;
        }
        return Promise.resolve(openResponse(request.requestId, request.workspaceId));
      },
    }),
    { idFactory: sequenceIds() },
  );

  const slowOpen = coordinator.openWorkspace('slow');
  assert.equal(coordinator.snapshot().navigationAction, 'open');
  const fastOpen = coordinator.openWorkspace('fast');
  assert.equal(slowSignal?.aborted, true);
  assert.equal((await fastOpen).outcome, 'completed');
  slow.resolve(openResponse('activate-1', 'slow'));
  assert.equal((await slowOpen).outcome, 'stale');
  assert.equal(coordinator.activeWorkspaceId, 'fast');

  const cancelledResponse = deferred<OpenWorkspaceResponse>();
  const cancelling = new WorkspaceCoordinator(
    createPort({ openWorkspace: () => cancelledResponse.promise }),
    { idFactory: sequenceIds() },
  );
  const pending = cancelling.openWorkspace('cancelled');
  assert.equal(cancelling.cancelActivation(), true);
  cancelledResponse.resolve(openResponse('activate-1', 'cancelled'));
  assert.equal((await pending).outcome, 'cancelled');
  assert.equal(cancelling.activeWorkspaceId, null);
  assert.equal(cancelling.snapshot().library.status, 'idle');
});

test('reopening the active workspace cannot regress its revision', async () => {
  let revision = 5;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request) =>
        Promise.resolve(openResponse(request.requestId, request.workspaceId, revision)),
    }),
    { idFactory: sequenceIds() },
  );
  assert.equal((await coordinator.openWorkspace('workspace')).outcome, 'completed');
  revision = 4;
  assert.equal((await coordinator.openWorkspace('workspace')).outcome, 'failed');
  assert.equal(coordinator.snapshot().activeWorkspace?.revision, 5);
});

test('generated typed mutations serialize writes and advance revision monotonically', async () => {
  const firstWrite = deferred<ApplyWorkspaceBatchResponse>();
  const requests: ApplyWorkspaceBatchRequest[] = [];
  const saveHealth: string[] = [];
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request) => Promise.resolve(openResponse(request.requestId, 'workspace', 5)),
      applyWorkspaceBatch: (request) => {
        requests.push(request);
        return requests.length === 1
          ? firstWrite.promise
          : Promise.resolve({
              clientBatchId: request.clientBatchId,
              committedRevision: request.baseRevision + 1,
            });
      },
    }),
    { idFactory: sequenceIds() },
  );
  coordinator.subscribe((snapshot) => {
    if (snapshot.activeWorkspace) saveHealth.push(snapshot.activeWorkspace.saveHealth);
  });
  await coordinator.openWorkspace('workspace');

  const original: WorkspaceMutationCommand = {
    kind: 'set-metadata',
    payload: { name: 'Renamed' },
  };
  const firstCommit = coordinator.commit(original);
  const secondCommit = coordinator.commit({
    kind: 'set-active-session',
    sessionId: null,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.baseRevision, 5);
  assert.deepEqual(requests[0]?.mutations, [
    { kind: 'set-metadata', sequence: 0, payload: { name: 'Renamed' } },
  ]);
  original.payload.name = 'mutated-after-submit';
  assert.equal(
    requests[0]?.mutations[0]?.kind === 'set-metadata'
      ? requests[0].mutations[0].payload.name
      : null,
    'Renamed',
  );
  assert.equal(Object.isFrozen(requests[0]?.mutations[0]), true);

  firstWrite.resolve({ clientBatchId: requests[0]!.clientBatchId, committedRevision: 6 });
  assert.equal((await firstCommit).outcome, 'completed');
  assert.equal((await secondCommit).outcome, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.baseRevision, 6);
  assert.equal(requests[1]?.mutations[0]?.sequence, 1);
  assert.equal(coordinator.snapshot().activeWorkspace?.revision, 7);
  assert.equal(coordinator.snapshot().activeWorkspace?.saveHealth, 'clean');
  assert.ok(saveHealth.includes('pending'));
  assert.ok(saveHealth.includes('saving'));
});

test('commitBatch sends one atomic native batch and publishes its document only after validation', async () => {
  const nativeWrite = deferred<ApplyWorkspaceBatchResponse>();
  const requests: ApplyWorkspaceBatchRequest[] = [];
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request) => Promise.resolve(openResponse(request.requestId, 'workspace', 4)),
      applyWorkspaceBatch: (request) => {
        requests.push(request);
        return nativeWrite.promise;
      },
    }),
    { idFactory: sequenceIds() },
  );
  await coordinator.openWorkspace('workspace');

  const pending = coordinator.commitBatch([
    { kind: 'set-metadata', payload: { name: 'Atomic project' } },
    { kind: 'upsert-session', sessionId: 'session-1', payload: { sortOrder: 0 } },
    { kind: 'set-active-session', sessionId: 'session-1' },
  ]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.baseRevision, 4);
  assert.deepEqual(
    requests[0]?.mutations.map((mutation) => mutation.sequence),
    [0, 1, 2],
  );
  assert.deepEqual(coordinator.snapshot().activeWorkspace, {
    workspaceId: 'workspace',
    name: 'Project workspace',
    revision: 4,
    activeSessionId: null,
    sessionIds: [],
    saveHealth: 'saving',
    layout: { version: 1, sidebar: { width: 292, collapsed: false } },
  });

  nativeWrite.resolve({
    clientBatchId: requests[0]!.clientBatchId,
    committedRevision: 5,
  });
  assert.equal((await pending).outcome, 'completed');
  assert.deepEqual(coordinator.snapshot().activeWorkspace, {
    workspaceId: 'workspace',
    name: 'Atomic project',
    revision: 5,
    activeSessionId: 'session-1',
    sessionIds: ['session-1'],
    saveHealth: 'clean',
    layout: { version: 1, sidebar: { width: 292, collapsed: false } },
  });
});

test('commitBatch leaves the complete local document unchanged when its response is invalid', async () => {
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request) => Promise.resolve(openResponse(request.requestId, 'workspace', 7)),
      applyWorkspaceBatch: (request) =>
        Promise.resolve({
          clientBatchId: request.clientBatchId,
          committedRevision: request.baseRevision + 2,
        }),
    }),
    { idFactory: sequenceIds() },
  );
  await coordinator.openWorkspace('workspace');

  const result = await coordinator.commitBatch([
    { kind: 'set-metadata', payload: { name: 'Must not leak' } },
    { kind: 'upsert-session', sessionId: 'session-1', payload: { sortOrder: 0 } },
  ]);

  assert.equal(result.outcome, 'failed');
  assert.deepEqual(coordinator.snapshot().activeWorkspace, {
    workspaceId: 'workspace',
    name: 'Project workspace',
    revision: 7,
    activeSessionId: null,
    sessionIds: [],
    saveHealth: 'degraded',
    layout: { version: 1, sidebar: { width: 292, collapsed: false } },
  });
});

test('revision conflict enters read-only degradation and blocks later writes', async () => {
  let writeCalls = 0;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      applyWorkspaceBatch: () => {
        writeCalls += 1;
        return Promise.reject({
          code: 'REVISION_CONFLICT',
          messageKey: 'error.revision_conflict',
          retryable: false,
          operation: 'workspace_apply_batch',
        });
      },
    }),
    { idFactory: sequenceIds() },
  );
  await coordinator.openWorkspace('workspace');
  const conflicted = await coordinator.commit({
    kind: 'remove-session',
    sessionId: 'session-1',
  });
  assert.deepEqual(conflicted, {
    outcome: 'failed',
    messageKey: 'error.revision_conflict',
    code: 'REVISION_CONFLICT',
  });
  assert.equal(coordinator.snapshot().activeWorkspace?.saveHealth, 'readOnly');
  assert.equal(coordinator.snapshot().acceptsMutations, false);
  assert.equal(
    (
      await coordinator.commit({
        kind: 'remove-session',
        sessionId: 'session-2',
      })
    ).outcome,
    'failed',
  );
  assert.equal(writeCalls, 1);
});

test('queued mutations cannot clear a read-only conflict state', async () => {
  const conflict = deferred<ApplyWorkspaceBatchResponse>();
  let writeCalls = 0;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      applyWorkspaceBatch: () => {
        writeCalls += 1;
        return conflict.promise;
      },
    }),
    { idFactory: sequenceIds() },
  );
  await coordinator.openWorkspace('workspace');
  const first = coordinator.commit({ kind: 'set-active-session', sessionId: null });
  const queued = coordinator.commit({ kind: 'remove-session', sessionId: 'session-2' });
  await Promise.resolve();
  conflict.reject({
    code: 'REVISION_CONFLICT',
    messageKey: 'error.revision_conflict',
    retryable: false,
    operation: 'workspace_apply_batch',
  });
  assert.equal((await first).outcome, 'failed');
  assert.equal((await queued).outcome, 'failed');
  assert.equal(writeCalls, 1);
  assert.equal(coordinator.snapshot().activeWorkspace?.saveHealth, 'readOnly');
});

test('late mutation responses from a previous workspace are stale and cannot overwrite current state', async () => {
  const oldWrite = deferred<ApplyWorkspaceBatchResponse>();
  let calls = 0;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      openWorkspace: (request) =>
        Promise.resolve(openResponse(request.requestId, request.workspaceId)),
      applyWorkspaceBatch: (request) => {
        calls += 1;
        return calls === 1
          ? oldWrite.promise
          : Promise.resolve({
              clientBatchId: request.clientBatchId,
              committedRevision: request.baseRevision + 1,
            });
      },
    }),
    { idFactory: sequenceIds() },
  );
  await coordinator.openWorkspace('old');
  const pending = coordinator.commit({ kind: 'set-active-session', sessionId: null });
  await Promise.resolve();
  await coordinator.openWorkspace('current');
  oldWrite.resolve({ clientBatchId: 'batch-2', committedRevision: 1 });
  assert.equal((await pending).outcome, 'stale');
  assert.equal(coordinator.activeWorkspaceId, 'current');
  assert.equal(coordinator.snapshot().activeWorkspace?.revision, 0);
  assert.equal(coordinator.snapshot().activeWorkspace?.saveHealth, 'clean');
});

test('import/export exchange only generated opaque grants and stale export responses are ignored', async () => {
  const exported = deferred<ExportProjectResponse>();
  const observedRequests: unknown[] = [];
  const coordinator = new WorkspaceCoordinator(
    createPort({
      requestProjectSourceGrant: (request) => {
        observedRequests.push(request);
        return Promise.resolve({
          requestId: request.requestId,
          sourceGrantId: 'opaque-source',
          displayName: 'import.bbcom',
        });
      },
      importProject: (request) => {
        observedRequests.push(request);
        return Promise.resolve({
          requestId: request.requestId,
          operationId: request.operationId,
          workspace: summary('imported'),
        });
      },
      openWorkspace: (request) => {
        observedRequests.push(request);
        return Promise.resolve(openResponse(request.requestId, request.workspaceId));
      },
      requestProjectTargetGrant: (request) => {
        observedRequests.push(request);
        return Promise.resolve({
          requestId: request.requestId,
          targetGrantId: 'opaque-target',
          displayName: request.suggestedName,
        });
      },
      exportProject: (request) => {
        observedRequests.push(request);
        return exported.promise;
      },
    }),
    { idFactory: sequenceIds() },
  );

  assert.equal((await coordinator.importWorkspace()).outcome, 'completed');
  const exporting = coordinator.exportWorkspace('copy.bbcom');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const cancelling = coordinator.cancelExport();
  await Promise.resolve();
  exported.resolve({
    requestId: 'export-5',
    operationId: 'export-5',
    displayName: 'copy.bbcom',
  });
  assert.equal(await cancelling, 'completed');
  assert.equal((await exporting).outcome, 'completed');

  const serialized = JSON.stringify(observedRequests);
  assert.equal(serialized.includes('/tmp/'), false);
  assert.equal(serialized.includes('C:\\'), false);
  assert.equal(serialized.includes('path'), false);
  assert.equal(serialized.includes('opaque-source'), true);
  assert.equal(serialized.includes('opaque-target'), true);
  assert.equal(coordinator.snapshot().exporting, false);
});

test('project operations use the preallocated operation id and retain native cancellation outside UI state', async () => {
  const exported = deferred<ExportProjectResponse>();
  const nativeCancellations: string[] = [];
  const records = new Map<string, Parameters<WorkspaceOperationLifecyclePort['begin']>[0]>();
  const lifecycle: WorkspaceOperationLifecyclePort = {
    begin: (input) => records.set(input.operationId, input),
    complete: () => undefined,
    fail: () => undefined,
    cancel: async (operationId) => {
      await records.get(operationId)?.cancel();
    },
  };
  const coordinator = new WorkspaceCoordinator(
    createPort({
      exportProject: (_request) => exported.promise,
      cancelWorkspaceOperation: (request) => {
        nativeCancellations.push(request.operationId);
        return Promise.resolve({
          requestId: request.requestId,
          operationId: request.operationId,
          cancellationRequested: true,
        });
      },
    }),
    { idFactory: sequenceIds(), operations: lifecycle },
  );
  await coordinator.openWorkspace('current');

  const pending = coordinator.exportWorkspace('copy.bbcom');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(records.get('export-3')?.kind, 'workspace-export');
  const cancelling = coordinator.cancelExport();
  await Promise.resolve();
  assert.deepEqual(nativeCancellations, ['export-3']);

  exported.resolve({
    requestId: 'export-3',
    operationId: 'export-3',
    displayName: 'copy.bbcom',
  });
  assert.equal(await cancelling, 'completed');
  assert.equal((await pending).outcome, 'completed');
});

test('mismatched request IDs and path-bearing typed payloads are rejected without state corruption', async () => {
  let writes = 0;
  const coordinator = new WorkspaceCoordinator(
    createPort({
      loadCatalog: () => Promise.resolve({ requestId: 'wrong-response', workspaces: [] }),
      applyWorkspaceBatch: (request) => {
        writes += 1;
        return Promise.resolve({
          clientBatchId: request.clientBatchId,
          committedRevision: request.baseRevision + 1,
        });
      },
    }),
    { idFactory: sequenceIds() },
  );
  assert.equal((await coordinator.refreshCatalog()).outcome, 'failed');
  assert.equal(coordinator.snapshot().library.status, 'failed');
  await coordinator.openWorkspace('workspace');
  const invalid = await coordinator.commit({
    kind: 'upsert-feature-state',
    entityId: 'plugin.example',
    payload: { feature: 'plugin', state: { projectPath: '/tmp/private.bbcom' } },
  });
  assert.deepEqual(invalid, { outcome: 'failed', messageKey: 'workspace.mutation.invalid' });
  assert.equal(writes, 0);
  assert.equal(coordinator.snapshot().activeWorkspace?.revision, 0);
});
