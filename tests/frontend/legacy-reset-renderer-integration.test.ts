// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { expect, test, vi } from 'vitest';
import LegacyResetGate from '../../src/components/migration/LegacyResetGate.vue';
import {
  LEGACY_RESET_CONTEXT_KEY,
  LEGACY_RESET_MARKER_KEY,
  LEGACY_RESET_MARKER_VALUE,
  LegacyRendererReadOnlySource,
  WorkspaceApplicationResetTarget,
  createLegacyResetBootstrap,
  type LegacyBackupContent,
  type LegacyPassphraseBackupPort,
  type LegacyResetNativePort,
  type LegacyResetWebStorage,
} from '../../src/features/migration/index.ts';
import type { WorkspaceApplicationActivation } from '../../src/features/workspace/application/index.ts';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<readonly [string, string]> = [];
  const removals: string[] = [];
  const storage: LegacyResetWebStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem: (key) => {
      removals.push(key);
      values.delete(key);
    },
  };
  return { storage, values, writes, removals };
}

function createNativeResetPort(initialPhase: 'required' | 'completed' = 'required') {
  let phase: 'required' | 'workspaceReady' | 'completed' = initialPhase;
  const workspace = {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 0,
  } as const;
  const port: LegacyResetNativePort = {
    async getJournal() {
      return phase === 'required' ? { phase } : { phase, ...workspace };
    },
    async beginDiscard() {
      return 'native-discard-token';
    },
    async prepare() {
      phase = 'workspaceReady';
      return { phase, ...workspace };
    },
    async complete() {
      phase = 'completed';
      return { phase, ...workspace };
    },
  };
  return port;
}

test('renderer bootstrap archives sanitized legacy state before authorizing the empty target', async () => {
  const memory = createStorage({
    'bbcom-app-settings': JSON.stringify({ theme: 'dark', apiKey: 'do-not-export' }),
    'bbcom-serial-settings': JSON.stringify({ selectedPort: 'COM7', token: 'do-not-export' }),
    'bbcom-connection-presets': JSON.stringify({
      presets: [{ id: 'preset-1', password: 'do-not-export' }],
    }),
  });
  const source = new LegacyRendererReadOnlySource({
    storage: memory.storage,
    sessions: {
      async read() {
        return { activeSessionId: 'session-1', bytes: new Uint8Array([1, 2, 3]) };
      },
    },
  });
  let encryptedBody: LegacyBackupContent | null = null;
  const backupPort: LegacyPassphraseBackupPort = {
    async beginEncryptedBackup(content, _passphrase, _context) {
      encryptedBody = structuredClone(content);
      return { backupId: 'opaque-native-backup' };
    },
    async verifyEncryptedBackup(receipt, expected, _passphrase, _context) {
      return {
        verified:
          receipt.backupId === 'opaque-native-backup' &&
          JSON.stringify(encryptedBody) === JSON.stringify(expected),
      };
    },
  };
  const activateEmptyV1 = vi.fn(async () => undefined);
  const activateCompletedV1 = vi.fn(async () => undefined);
  const reset = createLegacyResetBootstrap({
    source,
    backupPort,
    target: { activateEmptyV1, activateCompletedV1 },
    markerStorage: memory.storage,
    resetPort: createNativeResetPort(),
    coordinator: { now: () => 123, challengeFactory: () => 'discard-challenge' },
  });

  expect((await reset.start()).outcome).toBe('completed');
  expect(memory.writes).toEqual([]);
  expect((await reset.createVerifiedBackup('correct horse battery')).outcome).toBe('completed');
  expect(encryptedBody).toMatchObject({
    format: 'bbcom-legacy-readonly-backup-v1',
    sourceVersion: '0.7.3',
    createdAtMs: 123,
    snapshot: {
      sessions: { activeSessionId: 'session-1', bytes: { $bbcomBytesBase64: 'AQID' } },
    },
    settings: { app: { theme: 'dark' }, serial: {} },
    presets: { presets: [{ id: 'preset-1' }] },
  });
  expect(JSON.stringify(encryptedBody)).not.toContain('do-not-export');
  expect((await reset.coordinator.activateEmptyV1()).outcome).toBe('completed');
  expect(activateEmptyV1).toHaveBeenCalledOnce();
  expect(memory.writes).toEqual([[LEGACY_RESET_MARKER_KEY, LEGACY_RESET_MARKER_VALUE]]);
  expect(memory.removals).toEqual([]);
});

test('workspace target opens only the native journal fixed empty schema-v1 workspace', async () => {
  const openWorkspace = vi.fn(async (workspaceId: string) => ({
    outcome: 'completed' as const,
    value: {
      status: 'ready' as const,
      currentWorkspace: {
        workspaceId,
        name: 'Empty after reset',
        revision: 0,
        activeSessionId: null,
        sessionIds: [],
        saveHealth: 'clean' as const,
      },
      saveHealth: 'clean' as const,
      acceptsSaves: true,
      acceptsPersistenceEvents: true,
      readOnly: false,
      recoveryRequired: false,
      hydrating: false,
      messageKey: null,
      unsavedMutationCount: 0,
    },
  }));
  const application: WorkspaceApplicationActivation = {
    openWorkspace,
  } as unknown as WorkspaceApplicationActivation;
  const target = new WorkspaceApplicationResetTarget(application);
  await expect(
    target.activateEmptyV1('workspace-1', 0, { signal: new AbortController().signal }),
  ).resolves.toBeUndefined();
  expect(openWorkspace).toHaveBeenCalledWith('workspace-1');

  const restoreLastActiveWorkspace = vi.fn(openWorkspace);
  const restoringTarget = new WorkspaceApplicationResetTarget({
    openWorkspace,
    restoreLastActiveWorkspace,
  } as unknown as WorkspaceApplicationActivation);
  await restoringTarget.activateCompletedV1('workspace-1', {
    signal: new AbortController().signal,
  });
  expect(restoreLastActiveWorkspace).toHaveBeenCalledWith('workspace-1', expect.any(AbortSignal));

  const unsafeApplication = {
    openWorkspace: async () => ({
      outcome: 'completed' as const,
      value: {
        ...(await openWorkspace('workspace-1')).value,
        currentWorkspace: {
          ...(await openWorkspace('workspace-1')).value.currentWorkspace!,
          activeSessionId: 'session-1',
          sessionIds: ['session-1'],
        },
      },
    }),
  } as unknown as WorkspaceApplicationActivation;
  await expect(
    new WorkspaceApplicationResetTarget(unsafeApplication).activateEmptyV1('workspace-1', 0, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('reset target is not an empty workspace');
  await expect(
    new WorkspaceApplicationResetTarget(unsafeApplication).activateCompletedV1('workspace-1', {
      signal: new AbortController().signal,
    }),
  ).resolves.toBeUndefined();
});

test('gate renders no application content until native journal workspace open completes', async () => {
  const memory = createStorage({ [LEGACY_RESET_MARKER_KEY]: LEGACY_RESET_MARKER_VALUE });
  const sourceRead = vi.fn(async () => ({ applicationVersion: '0.7.3' as const, payload: {} }));
  let finishActivation!: () => void;
  const activation = new Promise<void>((resolve) => {
    finishActivation = resolve;
  });
  const activateCompletedV1 = vi.fn(() => activation);
  const reset = createLegacyResetBootstrap({
    source: {
      readSnapshot: sourceRead,
      readSettings: async () => ({}),
      readPresets: async () => ({}),
    },
    backupPort: {
      beginEncryptedBackup: async () => ({ backupId: 'unused' }),
      verifyEncryptedBackup: async () => ({ verified: false }),
    },
    target: {
      activateEmptyV1: async () => undefined,
      activateCompletedV1,
    },
    markerStorage: memory.storage,
    resetPort: createNativeResetPort('completed'),
  });
  const wrapper = mount(LegacyResetGate, {
    global: { provide: { [LEGACY_RESET_CONTEXT_KEY as symbol]: reset } },
    slots: { default: '<main data-test="application">application</main>' },
  });

  expect(wrapper.find('[data-test="application"]').exists()).toBe(false);
  await flushPromises();
  expect(activateCompletedV1).toHaveBeenCalledWith(
    '00000000-0000-4000-8000-000000000001',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(wrapper.find('[data-test="application"]').exists()).toBe(false);

  finishActivation();
  await flushPromises();
  await nextTick();
  expect(wrapper.find('[data-test="application"]').exists()).toBe(true);
  expect(sourceRead).not.toHaveBeenCalled();
  wrapper.unmount();
});

test('a trusted completion marker suppresses the gate flash entirely', async () => {
  // The gate probes window.localStorage (not the injected marker storage) so
  // an already-migrated install renders neither the migration card nor the
  // neutral skeleton while the journal confirm + hydration run.
  window.localStorage.setItem(LEGACY_RESET_MARKER_KEY, LEGACY_RESET_MARKER_VALUE);
  try {
    let finishActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    const activateCompletedV1 = vi.fn(() => activation);
    const reset = createLegacyResetBootstrap({
      source: {
        readSnapshot: vi.fn(async () => ({ applicationVersion: '0.7.3' as const, payload: {} })),
        readSettings: async () => ({}),
        readPresets: async () => ({}),
      },
      backupPort: {
        beginEncryptedBackup: async () => ({ backupId: 'unused' }),
        verifyEncryptedBackup: async () => ({ verified: false }),
      },
      target: {
        activateEmptyV1: async () => undefined,
        activateCompletedV1,
      },
      markerStorage: createStorage().storage,
      resetPort: createNativeResetPort('completed'),
    });
    const wrapper = mount(LegacyResetGate, {
      global: { provide: { [LEGACY_RESET_CONTEXT_KEY as symbol]: reset } },
      slots: { default: '<main data-test="application">application</main>' },
    });

    // Suppressed: no migration card, no skeleton, no application content.
    expect(wrapper.find('.legacy-reset-card').exists()).toBe(false);
    expect(wrapper.find('.legacy-reset-gate--neutral').exists()).toBe(false);
    expect(wrapper.find('[data-test="application"]').exists()).toBe(false);

    finishActivation();
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-test="application"]').exists()).toBe(true);
    wrapper.unmount();
  } finally {
    window.localStorage.removeItem(LEGACY_RESET_MARKER_KEY);
  }
});
