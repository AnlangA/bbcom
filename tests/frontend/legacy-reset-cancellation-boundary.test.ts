import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';

import {
  LEGACY_RESET_MARKER_KEY,
  LEGACY_RESET_MARKER_VALUE,
  LegacyWorkspaceResetCoordinator,
  WorkspaceApplicationResetTarget,
  type LegacyResetJournalSnapshot,
} from '../../src/features/migration/index.ts';
import type {
  WorkspaceApplicationActivation,
  WorkspaceApplicationOutcome,
} from '../../src/features/workspace/application/index.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';

function activated(workspace = workspaceId): WorkspaceApplicationOutcome {
  return {
    outcome: 'completed',
    value: {
      status: 'ready',
      currentWorkspace: {
        workspaceId: workspace,
        name: 'Reset workspace',
        revision: 0,
        activeSessionId: null,
        sessionIds: [],
        saveHealth: 'clean',
        layout: { version: 1, sidebar: { width: 280, collapsed: false } },
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
    },
  };
}

test('reset abort delegates to the reversible workspace activation and waits for its cancellation', async () => {
  let resolveOpen!: (outcome: WorkspaceApplicationOutcome) => void;
  const open = new Promise<WorkspaceApplicationOutcome>((resolve) => {
    resolveOpen = resolve;
  });
  const cancelActivation = vi.fn(() => true);
  const application = {
    openWorkspace: vi.fn(() => open),
    cancelActivation,
  } as unknown as WorkspaceApplicationActivation;
  const controller = new AbortController();
  const activation = new WorkspaceApplicationResetTarget(application).activateEmptyV1(
    workspaceId,
    0,
    { signal: controller.signal },
  );

  controller.abort();
  resolveOpen({ outcome: 'cancelled' });

  await expect(activation).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelActivation).toHaveBeenCalledOnce();
});

test('an abort rejected after the workspace commit point does not relabel activation success', async () => {
  const controller = new AbortController();
  const cancelActivation = vi.fn(() => false);
  const application = {
    cancelActivation,
    openWorkspace: vi.fn(async () => {
      controller.abort();
      return activated();
    }),
  } as unknown as WorkspaceApplicationActivation;

  await expect(
    new WorkspaceApplicationResetTarget(application).activateEmptyV1(workspaceId, 0, {
      signal: controller.signal,
    }),
  ).resolves.toBeUndefined();
  expect(cancelActivation).toHaveBeenCalledOnce();
});

test('native reset completion is an explicit non-cancellable commit phase', async () => {
  let journal: LegacyResetJournalSnapshot = { phase: 'required' };
  let resolveCompletion!: (journal: LegacyResetJournalSnapshot) => void;
  let completionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    completionStarted = resolve;
  });
  const completion = new Promise<LegacyResetJournalSnapshot>((resolve) => {
    resolveCompletion = resolve;
  });
  let markerWrites = 0;
  const coordinator = new LegacyWorkspaceResetCoordinator(
    {
      readSnapshot: async () => ({ applicationVersion: '0.7.3', payload: { sessions: [1] } }),
      readSettings: async () => ({}),
      readPresets: async () => ({}),
    },
    {
      beginEncryptedBackup: async () => ({ backupId: 'verified-backup' }),
      verifyEncryptedBackup: async () => ({ verified: true }),
    },
    {
      activateEmptyV1: async () => undefined,
      activateCompletedV1: async () => undefined,
    },
    {
      isSet: () => false,
      write(key, value) {
        assert.equal(key, LEGACY_RESET_MARKER_KEY);
        assert.equal(value, LEGACY_RESET_MARKER_VALUE);
        markerWrites += 1;
      },
      remove: () => undefined,
    },
    {
      challengeFactory: () => 'discard-challenge',
      nativePort: {
        getJournal: async () => ({ ...journal }),
        beginDiscard: async () => 'discard-token',
        prepare: async () => {
          journal = { phase: 'workspaceReady', workspaceId, expectedRevision: 0 };
          return { ...journal };
        },
        complete: async () => {
          completionStarted();
          return completion;
        },
      },
    },
  );

  assert.equal((await coordinator.start()).outcome, 'completed');
  assert.equal((await coordinator.createVerifiedBackup()).outcome, 'completed');
  const reset = coordinator.activateEmptyV1();
  await started;
  assert.equal(coordinator.snapshot().canCancel, false);
  assert.equal(coordinator.cancel(), false);
  journal = { phase: 'completed', workspaceId, expectedRevision: 0 };
  resolveCompletion({ ...journal });

  assert.equal((await reset).outcome, 'completed');
  assert.equal(markerWrites, 1);
});
