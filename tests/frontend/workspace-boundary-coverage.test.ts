import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { OperationRegistry } from '../../src/features/application/operation-registry.ts';
import {
  WorkspaceOperationRegistryLifecycle,
  workspaceOperationLifecycleFor,
} from '../../src/features/workspace/application/workspace-operation-lifecycle.ts';
import { TauriWorkspacePort } from '../../src/features/workspace/tauri-workspace-port.ts';

afterEach(() => invoke.mockReset());

test('Tauri workspace port forwards every generated request in the request envelope', async () => {
  invoke.mockImplementation((command: string, args: unknown) =>
    Promise.resolve({ command, request: (args as { request: unknown }).request }),
  );
  const port = new TauriWorkspacePort();
  const signal = new AbortController().signal;
  const request = { requestId: 'request-1' } as never;

  await port.loadCatalog(request, { signal });
  await port.openWorkspace(request, { signal });
  await port.createWorkspace(request, { signal });
  await port.requestProjectSourceGrant(request, { signal });
  await port.requestProjectTargetGrant(request, { signal });
  await port.importProject(request, { signal });
  await port.exportProject(request, { signal });
  await port.cancelWorkspaceOperation(request, { signal });
  await port.applyWorkspaceBatch(request, { signal });
  await port.flushWorkspace(request, { signal });
  await port.hydrateSessions(request);
  await port.hydrateFrames(request);
  await port.hydrateCollections(request);
  await port.hydrateAiMessages(request);
  await port.hydrateWaveform(request);

  assert.deepEqual(
    invoke.mock.calls.map(([command, args]) => [command, args]),
    [
      ['workspace_catalog', { request }],
      ['open_workspace', { request }],
      ['create_workspace', { request }],
      ['request_project_source_grant', { request }],
      ['request_project_target_grant', { request }],
      ['import_project', { request }],
      ['export_project', { request }],
      ['cancel_workspace_operation', { request }],
      ['apply_workspace_batch', { request }],
      ['flush_workspace', { request }],
      ['hydrate_workspace_sessions', { request }],
      ['hydrate_workspace_frames', { request }],
      ['hydrate_workspace_collections', { request }],
      ['hydrate_workspace_ai_messages', { request }],
      ['hydrate_workspace_waveform', { request }],
    ],
  );
});

test('guarded workspace calls reject before and after IPC abort while native operations retain completion', async () => {
  const port = new TauriWorkspacePort();
  const preAborted = new AbortController();
  preAborted.abort();

  await assert.rejects(
    port.loadCatalog({ requestId: 'pre-abort' } as never, { signal: preAborted.signal }),
    abortError,
  );
  await assert.rejects(
    async () =>
      port.openWorkspace({ requestId: 'pre-abort' } as never, { signal: preAborted.signal }),
    abortError,
  );
  assert.equal(invoke.mock.calls.length, 0);

  const guardedController = new AbortController();
  invoke.mockImplementationOnce(() => {
    guardedController.abort();
    return Promise.resolve({ requestId: 'guarded' });
  });
  await assert.rejects(
    port.flushWorkspace({ requestId: 'guarded' } as never, {
      signal: guardedController.signal,
    }),
    abortError,
  );

  const nativeController = new AbortController();
  invoke.mockImplementationOnce(() => {
    nativeController.abort();
    return Promise.resolve({ requestId: 'native', workspace: { workspaceId: 'workspace' } });
  });
  const completed = await port.openWorkspace({ requestId: 'native' } as never, {
    signal: nativeController.signal,
  });
  assert.equal(completed.requestId, 'native');
});

test('workspace operation lifecycle owns begin, completion, cancellation and stable failure projection', async () => {
  const registry = new OperationRegistry();
  const lifecycle = new WorkspaceOperationRegistryLifecycle(registry);
  let cancelCalls = 0;

  lifecycle.begin({
    operationId: 'workspace-operation',
    kind: 'workspace-import',
    workspaceId: 'workspace-1',
    cancel: () => {
      cancelCalls += 1;
      return Promise.resolve();
    },
  });
  assert.equal(registry.get('workspace-operation')?.status, 'running');
  await lifecycle.cancel('workspace-operation');
  assert.equal(cancelCalls, 1);
  assert.equal(registry.get('workspace-operation')?.status, 'cancelled');
  lifecycle.complete('workspace-operation');
  lifecycle.fail('workspace-operation', {
    outcome: 'failed',
    messageKey: 'workspace.already_terminal',
  });
  assert.equal(registry.get('workspace-operation')?.status, 'cancelled');

  lifecycle.begin({
    operationId: 'completed-operation',
    kind: 'workspace-export',
    workspaceId: 'workspace-1',
    cancel: () => Promise.resolve(),
  });
  lifecycle.complete('completed-operation');
  assert.equal(registry.get('completed-operation')?.status, 'completed');

  registry.create({
    operationId: 'queued-operation',
    kind: 'workspace-export',
    workspaceId: 'workspace-1',
  });
  lifecycle.fail('queued-operation', {
    outcome: 'failed',
    messageKey: 'workspace.queued_failure',
  });
  assert.equal(registry.get('queued-operation')?.status, 'failed');
});

test('workspace operation failures preserve every generated error code and sanitize unknown codes', () => {
  const registry = new OperationRegistry();
  const lifecycle = workspaceOperationLifecycleFor(registry);
  assert.strictEqual(workspaceOperationLifecycleFor(registry), lifecycle);
  assert.notStrictEqual(workspaceOperationLifecycleFor(new OperationRegistry()), lifecycle);

  const codes = [
    'BUSY',
    'RATE_LIMITED',
    'CANCELLED',
    'TIMEOUT',
    'AI_PROVIDER_FAILED',
    'INVALID_INPUT',
    'LIMIT_EXCEEDED',
    'SECURITY_DENIED',
    'SERIAL_DISCONNECTED',
    'SERIAL_QUEUE_FULL',
    'SERIAL_PARTIAL_WRITE',
    'IO_PERMISSION_DENIED',
    'IO_DISK_FULL',
    'EXPORT_REPLACE_FAILED',
    'REVISION_CONFLICT',
    'WORKSPACE_READ_ONLY',
    'WORKSPACE_CORRUPT',
    'PORT_IN_USE',
  ] as const;

  for (const [index, code] of codes.entries()) {
    const operationId = `failure-${index}`;
    lifecycle.begin({
      operationId,
      kind: 'workspace-export',
      workspaceId: 'workspace-1',
      cancel: () => Promise.resolve(),
    });
    lifecycle.fail(operationId, {
      outcome: 'failed',
      messageKey: `workspace.failure_${index}`,
      code,
    });
    assert.deepEqual(registry.get(operationId)?.error, {
      code,
      messageKey: `workspace.failure_${index}`,
      retryable: false,
      operation: 'workspace-operation',
      requestId: operationId,
    });
  }

  for (const [operationId, code] of [
    ['failure-undefined', undefined],
    ['failure-unknown', 'NOT_A_GENERATED_CODE'],
  ] as const) {
    lifecycle.begin({
      operationId,
      kind: 'workspace-import',
      workspaceId: 'workspace-1',
      cancel: () => Promise.resolve(),
    });
    lifecycle.fail(operationId, {
      outcome: 'failed',
      messageKey: 'workspace.sanitized_failure',
      ...(code === undefined ? {} : { code }),
    });
    assert.equal(registry.get(operationId)?.error?.code, 'INVALID_INPUT');
  }
});

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
