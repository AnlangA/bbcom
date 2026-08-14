import assert from 'node:assert/strict';
import { test } from 'vitest';

import type {
  WorkspaceDocumentHeader,
  WorkspaceSummary,
} from '../../src/generated/ipc-contracts.ts';
import {
  InvalidWorkspaceResponseError,
  createSequencedMutation,
  isWorkspaceReadOnlyError,
  requireMatchingRequestId,
  safeFailure,
  sanitizeCatalog,
  sanitizeHeader,
  sanitizeWorkspaceLayout,
  sanitizeWorkspaceSummary,
  validateCommittedRevision,
  validateProjectFileDisplayName,
  validateProjectName,
  validateRequestId,
  validateResponseOpaqueId,
  validateSuggestedProjectFileName,
  validateWorkspaceId,
  workspaceGrantId,
} from '../../src/features/workspace/validation.ts';

function summary(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    workspaceId: 'workspace-1',
    name: 'Workspace',
    revision: 1,
    updatedAtMs: 1,
    saveHealth: 'clean',
    ...overrides,
  };
}

function header(overrides: Partial<WorkspaceDocumentHeader> = {}): WorkspaceDocumentHeader {
  return {
    workspaceId: 'workspace-1',
    name: 'Workspace',
    revision: 1,
    activeSessionId: 'session-1',
    sessionIds: ['session-1'],
    layout: {},
    ...overrides,
  };
}

test('workspace identifiers and display names reject every path-bearing boundary form', () => {
  assert.equal(validateWorkspaceId(' workspace-1 '), 'workspace-1');
  assert.equal(validateRequestId('request:1'), 'request:1');
  assert.equal(workspaceGrantId('grant:1'), 'grant:1');
  assert.throws(() => workspaceGrantId('file:grant'), /file identifier/);
  assert.throws(() => validateWorkspaceId('bad/id'), /path-free opaque identifier/);

  assert.equal(validateProjectName(' Workspace '), 'Workspace');
  for (const invalid of [
    '',
    'x'.repeat(257),
    'folder/project',
    'folder\\project',
    'file:project',
  ]) {
    assert.throws(() => validateProjectName(invalid), /path-free display name/);
  }

  assert.equal(validateProjectFileDisplayName(' Project.BBCOM '), 'Project.BBCOM');
  assert.equal(validateSuggestedProjectFileName('project.bbcom'), 'project.bbcom');
  for (const invalid of [null, '', 'x'.repeat(251) + '.bbcom', 'folder/project.bbcom', 'x.txt']) {
    assert.throws(() => validateProjectFileDisplayName(invalid), InvalidWorkspaceResponseError);
  }
  assert.throws(
    () => validateSuggestedProjectFileName('folder/project.bbcom'),
    /path-free \.bbcom filename/,
  );
});

test('catalog and header sanitizers reject malformed, duplicate and dangling identities', () => {
  assert.throws(
    () => sanitizeCatalog(null as never, 'request-1'),
    (error) => stableField(error, 'catalog'),
  );
  assert.throws(
    () => sanitizeCatalog({ requestId: 'request-1', workspaces: null } as never, 'request-1'),
    (error) => stableField(error, 'catalog'),
  );
  assert.throws(
    () =>
      sanitizeCatalog(
        {
          requestId: 'request-1',
          workspaces: [summary(), summary()],
        },
        'request-1',
      ),
    (error) => stableField(error, 'workspaceId'),
  );
  assert.throws(
    () =>
      sanitizeCatalog(
        {
          requestId: 'request-1',
          workspaces: [summary()],
          activeWorkspaceId: 'missing',
        },
        'request-1',
      ),
    (error) => stableField(error, 'activeWorkspaceId'),
  );
  const catalog = sanitizeCatalog(
    {
      requestId: 'request-1',
      workspaces: [summary()],
      activeWorkspaceId: 'workspace-1',
    },
    'request-1',
  );
  assert.equal(catalog.activeWorkspaceId, 'workspace-1');
  assert.equal(Object.isFrozen(catalog.projects), true);

  assert.throws(
    () => sanitizeHeader(null as never),
    (error) => stableField(error, 'header'),
  );
  assert.throws(
    () => sanitizeHeader({ ...header(), sessionIds: null } as never),
    (error) => stableField(error, 'header'),
  );
  assert.throws(
    () => sanitizeHeader(header({ sessionIds: ['session-1', 'session-1'] })),
    (error) => stableField(error, 'sessionIds'),
  );
  assert.throws(
    () => sanitizeHeader(header({ activeSessionId: 'missing' })),
    (error) => stableField(error, 'activeSessionId'),
  );
  assert.equal(sanitizeHeader(header({ activeSessionId: undefined })).activeSessionId, null);
});

test('workspace layout accepts only the versioned finite sidebar shape', () => {
  for (const fallback of [null, 'layout', [], {}]) {
    assert.deepEqual(sanitizeWorkspaceLayout(fallback), {
      version: 1,
      sidebar: { width: 292, collapsed: false },
    });
  }
  for (const invalid of [
    { version: 2, sidebar: { width: 300, collapsed: false } },
    { version: 1 },
    { version: 1, sidebar: 'wide' },
    { version: 1, sidebar: [] },
    { version: 1, sidebar: { width: '300', collapsed: false } },
    { version: 1, sidebar: { width: Number.POSITIVE_INFINITY, collapsed: false } },
    { version: 1, sidebar: { width: 300, collapsed: 'no' } },
  ]) {
    assert.throws(
      () => sanitizeWorkspaceLayout(invalid),
      (error) => stableField(error, 'layout'),
    );
  }
  assert.deepEqual(
    sanitizeWorkspaceLayout({ version: 1, sidebar: { width: 10_000, collapsed: true } }),
    { version: 1, sidebar: { width: 340, collapsed: true } },
  );
});

test('sequenced mutation cloning covers structural variants and rejects invalid trim/default cases', () => {
  const commands = [
    { kind: 'replace-capture', sessionId: 'session-1', payload: { frames: [] } },
    {
      kind: 'replace-session-collections',
      sessionId: 'session-1',
      payload: {
        sendHistory: [],
        quickCommands: [],
        macros: [],
        triggers: [],
        highlights: [],
        modbusRegisters: [],
      },
    },
    {
      kind: 'append-ai-messages',
      sessionId: 'session-1',
      payload: { startPosition: 0, messages: [] },
    },
    { kind: 'clear-ai-messages', sessionId: 'session-1' },
    {
      kind: 'replace-waveform-channels',
      sessionId: 'session-1',
      payload: { channels: [] },
    },
    {
      kind: 'append-waveform-samples',
      sessionId: 'session-1',
      payload: { samples: [] },
    },
  ] as const;
  for (const [sequence, command] of commands.entries()) {
    const mutation = createSequencedMutation(command as never, sequence);
    assert.equal(mutation.kind, command.kind);
    assert.equal(Object.isFrozen(mutation), true);
  }
  assert.equal(
    createSequencedMutation(
      { kind: 'trim-capture', sessionId: 'session-1', payload: { frameCount: 1 } },
      9,
    ).kind,
    'trim-capture',
  );

  for (const frameCount of [Number.NaN, 0, 0x1_0000_0000]) {
    assert.throws(() =>
      createSequencedMutation(
        { kind: 'trim-capture', sessionId: 'session-1', payload: { frameCount } },
        0,
      ),
    );
  }
  for (const invalid of [null, undefined, 'command']) {
    assert.throws(() => createSequencedMutation(invalid as never, 0), /command is invalid/);
  }
  assert.throws(() => createSequencedMutation({ kind: 'set-active-session', sessionId: null }, -1));
  assert.throws(() => createSequencedMutation({ kind: 'unsupported' } as never, 0), /unsupported/);
});

test('workspace response scalar validation reports only stable fields', () => {
  assert.throws(
    () => requireMatchingRequestId(1, 'request-1'),
    (error) => stableField(error, 'requestId'),
  );
  assert.throws(
    () => requireMatchingRequestId('other', 'request-1'),
    (error) => stableField(error, 'requestId'),
  );
  assert.equal(validateCommittedRevision(0), 0);
  for (const invalid of [Number.NaN, -1, 1.5]) {
    assert.throws(
      () => validateCommittedRevision(invalid),
      (error) => stableField(error, 'committedRevision'),
    );
  }
  assert.throws(
    () => validateResponseOpaqueId(null, 'opaque'),
    (error) => stableField(error, 'opaque'),
  );
  assert.throws(
    () => validateResponseOpaqueId('bad/id', 'opaque'),
    (error) => stableField(error, 'opaque'),
  );

  for (const invalid of [
    null,
    summary({ saveHealth: 'unknown' as never }),
    summary({ workspaceId: null as never }),
    summary({ workspaceId: 'bad/id' }),
    summary({ name: null as never }),
    summary({ name: 'bad/name' }),
    summary({ revision: -1 }),
    summary({ updatedAtMs: Number.POSITIVE_INFINITY }),
  ]) {
    assert.throws(() => sanitizeWorkspaceSummary(invalid as never), InvalidWorkspaceResponseError);
  }
});

test('safe failures whitelist IPC codes/message keys and reject filesystem/capability payloads', () => {
  assert.equal(
    isWorkspaceReadOnlyError({ code: 'REVISION_CONFLICT', messageKey: 'error.conflict' }),
    true,
  );
  assert.equal(
    isWorkspaceReadOnlyError({ code: 'WORKSPACE_READ_ONLY', messageKey: 'error.read_only' }),
    true,
  );
  assert.equal(isWorkspaceReadOnlyError({ code: 'BUSY', messageKey: 'error.busy' }), false);
  assert.deepEqual(safeFailure({ code: 'BUSY', messageKey: 'error.busy' }, 'fallback.error'), {
    outcome: 'failed',
    messageKey: 'error.busy',
    code: 'BUSY',
  });
  for (const invalid of [
    null,
    'failure',
    { code: 1, messageKey: 'error.bad' },
    { code: 'NOT_ALLOWED', messageKey: 'error.bad' },
    { code: 'BUSY', messageKey: 1 },
    { code: 'BUSY', messageKey: 'bad key' },
  ]) {
    assert.deepEqual(safeFailure(invalid, 'fallback.error'), {
      outcome: 'failed',
      messageKey: 'fallback.error',
    });
  }

  for (const value of ['/root/project', '\\server\\share', 'file:project', 'C:\\project']) {
    assert.throws(() =>
      createSequencedMutation(
        { kind: 'set-metadata', payload: { name: 'Workspace', value } } as never,
        0,
      ),
    );
  }
  for (const key of [
    'sourcePath',
    'portName',
    'nativeHandle',
    'accessToken',
    'grantId',
    'keyringId',
    'key',
    'providerApiKey',
    'clientSecret',
  ]) {
    assert.throws(() =>
      createSequencedMutation(
        {
          kind: 'upsert-feature-state',
          entityId: 'plugin:test',
          payload: { feature: 'plugin', state: { [key]: 'opaque' } },
        },
        0,
      ),
    );
  }

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() =>
    createSequencedMutation(
      {
        kind: 'upsert-feature-state',
        entityId: 'plugin:test',
        payload: { feature: 'plugin', state: cyclic },
      },
      0,
    ),
  );
});

function stableField(error: unknown, field: string): boolean {
  return error instanceof InvalidWorkspaceResponseError && error.stableField === field;
}
