import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  LEGACY_RESET_MARKER_KEY,
  LEGACY_RESET_MARKER_VALUE,
  LegacyWorkspaceResetCoordinator,
  type LegacyBackupContent,
  type LegacyBackupPort,
  type LegacyReadOnlySource,
  type LegacyResetJournalPhase,
  type LegacyResetJournalSnapshot,
  type LegacyResetMarkerStore,
  type LegacyResetNativePort,
  type LegacyResetStatus,
  type WorkspaceResetTarget,
} from '../../src/features/migration/index.ts';

type SourceHasDelete = 'delete' extends keyof LegacyReadOnlySource ? true : false;
const sourceHasDelete: SourceHasDelete = false;

interface HarnessOptions {
  readonly markerInitiallySet?: boolean;
  readonly nativePhase?: LegacyResetJournalPhase;
  readonly beginBackup?: LegacyBackupPort['beginEncryptedBackup'];
  readonly verifyBackup?: LegacyBackupPort['verifyEncryptedBackup'];
  readonly activateTarget?: WorkspaceResetTarget['activateEmptyV1'];
  readonly emptyLegacyState?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const markers = new Map<string, string>();
  if (options.markerInitiallySet) {
    markers.set(LEGACY_RESET_MARKER_KEY, LEGACY_RESET_MARKER_VALUE);
  }
  const sourceCalls = { snapshot: 0, settings: 0, presets: 0 };
  const markerCalls = { writes: 0, removes: 0 };
  const backupCalls = { begins: 0, verifies: 0 };
  const nativeCalls = { gets: 0, discards: 0, prepares: 0, completes: 0 };
  let backedUpContent: LegacyBackupContent | null = null;
  let targetCalls = 0;

  const source: LegacyReadOnlySource = {
    async readSnapshot() {
      sourceCalls.snapshot += 1;
      if (options.emptyLegacyState) {
        return {
          applicationVersion: '0.7.3',
          payload: { sessions: { indexedDb: null, localStorage: null } },
        };
      }
      return {
        applicationVersion: '0.7.3',
        payload: {
          activeSessionId: 'session-1',
          sessions: [
            {
              id: 'session-1',
              text: 'literal /dev/ttyUSB0 remains user content',
              logPath: '/tmp/serial.log',
              sourceGrantId: 'native-grant',
            },
          ],
        },
      };
    },
    async readSettings() {
      sourceCalls.settings += 1;
      if (options.emptyLegacyState) return { app: {}, serial: {} };
      return {
        theme: 'dark',
        keyring: { provider: 'native', key: 'must-not-leave-keyring' },
        exportDirectory: '/tmp',
      };
    },
    async readPresets() {
      sourceCalls.presets += 1;
      if (options.emptyLegacyState) return {};
      return {
        parser: { kind: 'delimiter', delimiter: '\\n' },
        nativeGrant: 'must-not-enter-backup',
      };
    },
  };

  const backupPort: LegacyBackupPort = {
    async beginEncryptedBackup(content, context) {
      backupCalls.begins += 1;
      if (options.beginBackup) return options.beginBackup(content, context);
      backedUpContent = structuredClone(content);
      return { backupId: 'opaque-backup-1' };
    },
    async verifyEncryptedBackup(receipt, expectedContent, context) {
      backupCalls.verifies += 1;
      if (options.verifyBackup) {
        return options.verifyBackup(receipt, expectedContent, context);
      }
      assert.equal(receipt.backupId, 'opaque-backup-1');
      assert.deepEqual(backedUpContent, expectedContent);
      return { verified: true };
    },
  };

  const markerStore: LegacyResetMarkerStore = {
    isSet(key) {
      return markers.get(key) === LEGACY_RESET_MARKER_VALUE;
    },
    write(key, value) {
      markerCalls.writes += 1;
      markers.set(key, value);
    },
    remove(key) {
      markerCalls.removes += 1;
      markers.delete(key);
    },
  };

  const target: WorkspaceResetTarget = {
    async activateEmptyV1(_workspaceId, _expectedRevision, context) {
      targetCalls += 1;
      if (options.activateTarget) {
        return options.activateTarget('00000000-0000-4000-8000-000000000001', 0, context);
      }
    },
    async activateCompletedV1(_workspaceId, context) {
      targetCalls += 1;
      if (options.activateTarget) {
        return options.activateTarget('00000000-0000-4000-8000-000000000001', 0, context);
      }
    },
  };

  let journal: LegacyResetJournalSnapshot =
    options.nativePhase && options.nativePhase !== 'required'
      ? {
          phase: options.nativePhase,
          workspaceId: '00000000-0000-4000-8000-000000000001',
          expectedRevision: 0,
        }
      : { phase: 'required' as const };
  const nativePort: LegacyResetNativePort = {
    async getJournal() {
      nativeCalls.gets += 1;
      return { ...journal };
    },
    async beginDiscard() {
      nativeCalls.discards += 1;
      return 'native-discard-token-1';
    },
    async prepare(authorization) {
      nativeCalls.prepares += 1;
      if (journal.phase === 'required') {
        assert.equal(
          authorization.verifiedBackupId === 'opaque-backup-1' ||
            authorization.discardToken === 'native-discard-token-1' ||
            authorization.emptyLegacyState === true,
          true,
        );
      }
      journal = {
        phase: 'workspaceReady' as const,
        workspaceId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 0,
      };
      return { ...journal };
    },
    async complete(workspaceId, expectedRevision) {
      nativeCalls.completes += 1;
      assert.equal(workspaceId, '00000000-0000-4000-8000-000000000001');
      assert.equal(expectedRevision, 0);
      journal = {
        phase: 'completed',
        workspaceId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 0,
      };
      return { ...journal };
    },
  };

  const coordinator = new LegacyWorkspaceResetCoordinator(source, backupPort, target, markerStore, {
    now: () => 1_723_456_789_000,
    challengeFactory: () => 'discard-challenge-0001',
    nativePort,
  });

  return {
    coordinator,
    source,
    sourceCalls,
    markerCalls,
    backupCalls,
    nativeCalls,
    markers,
    get backedUpContent() {
      return backedUpContent;
    },
    get targetCalls() {
      return targetCalls;
    },
  };
}

test('0.7.3 backup is independently verified before the empty v1 reset', async () => {
  const harness = createHarness({
    activateTarget: async () => {
      assert.equal(harness.markers.has(LEGACY_RESET_MARKER_KEY), false);
    },
  });
  const states: LegacyResetStatus[] = [];
  harness.coordinator.subscribe((snapshot) => states.push(snapshot.status));

  assert.equal((await harness.coordinator.start()).outcome, 'completed');
  assert.equal((await harness.coordinator.createVerifiedBackup()).outcome, 'completed');
  assert.equal((await harness.coordinator.activateEmptyV1()).outcome, 'completed');

  assert.deepEqual(withoutConsecutiveDuplicates(states), [
    'checking',
    'backup-required',
    'backing-up',
    'verifying',
    'ready-to-reset',
    'resetting',
    'completed',
  ]);
  assert.equal(harness.backupCalls.begins, 1);
  assert.equal(harness.backupCalls.verifies, 1);
  assert.equal(harness.targetCalls, 1);
  assert.equal(harness.markers.get(LEGACY_RESET_MARKER_KEY), LEGACY_RESET_MARKER_VALUE);

  const content = harness.backedUpContent;
  assert.ok(content);
  if (!content) throw new Error('backup content expected');
  assert.equal(content.sourceVersion, '0.7.3');
  assert.equal(content.createdAtMs, 1_723_456_789_000);
  assert.equal(JSON.stringify(content).includes('must-not-leave-keyring'), false);
  assert.equal(JSON.stringify(content).includes('/tmp/serial.log'), false);
  assert.equal(JSON.stringify(content).includes('native-grant'), false);
  assert.equal(JSON.stringify(content).includes('literal /dev/ttyUSB0 remains user content'), true);
});

test('a clean first install creates its empty workspace without showing the migration gate', async () => {
  const harness = createHarness({ emptyLegacyState: true });

  assert.equal((await harness.coordinator.start()).outcome, 'completed');
  assert.equal(harness.coordinator.snapshot().status, 'completed');
  assert.deepEqual(harness.sourceCalls, { snapshot: 1, settings: 1, presets: 1 });
  assert.equal(harness.nativeCalls.prepares, 1);
  assert.equal(harness.nativeCalls.completes, 1);
  assert.equal(harness.targetCalls, 1);
  assert.equal(harness.backupCalls.begins, 0);
  assert.equal(harness.markers.get(LEGACY_RESET_MARKER_KEY), LEGACY_RESET_MARKER_VALUE);
});

test('cancelling target activation leaves native workspaceReady and writes no marker', async () => {
  let enteredTarget: (() => void) | null = null;
  const targetEntered = new Promise<void>((resolve) => {
    enteredTarget = resolve;
  });
  const harness = createHarness({
    activateTarget: (_workspaceId, _revision, { signal }) =>
      new Promise<void>((_resolve, reject) => {
        enteredTarget?.();
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  });
  await harness.coordinator.start();
  const discard = harness.coordinator.requestDiscard();
  assert.equal(discard.outcome, 'challenge');
  if (discard.outcome !== 'challenge') throw new Error('challenge expected');
  assert.equal(harness.coordinator.confirmDiscard(discard.challenge).outcome, 'completed');

  const reset = harness.coordinator.activateEmptyV1();
  await targetEntered;
  assert.equal(harness.markers.has(LEGACY_RESET_MARKER_KEY), false);
  assert.equal(harness.coordinator.cancel(), true);
  assert.equal((await reset).outcome, 'cancelled');
  assert.equal(harness.markers.has(LEGACY_RESET_MARKER_KEY), false);
  assert.equal(harness.markerCalls.writes, 0);
  assert.equal(harness.markerCalls.removes, 0);
  assert.equal(harness.coordinator.snapshot().status, 'ready-to-reset');
});

test('backup write failure reports failure and never writes the marker', async () => {
  const harness = createHarness({
    beginBackup: async () => {
      throw new Error('disk full');
    },
  });
  await harness.coordinator.start();
  const outcome = await harness.coordinator.createVerifiedBackup();

  assert.equal(outcome.outcome, 'failed');
  assert.equal(harness.coordinator.snapshot().messageKey, 'migration.reset.backup_failed');
  assert.equal(harness.backupCalls.verifies, 0);
  assert.equal(harness.markerCalls.writes, 0);
  assert.equal(harness.targetCalls, 0);
});

test('failed independent readback does not authorize reset', async () => {
  const harness = createHarness({
    verifyBackup: async () => ({ verified: false }),
  });
  await harness.coordinator.start();
  const outcome = await harness.coordinator.createVerifiedBackup();

  assert.equal(outcome.outcome, 'failed');
  assert.equal(
    harness.coordinator.snapshot().messageKey,
    'migration.reset.backup_verification_failed',
  );
  assert.equal((await harness.coordinator.activateEmptyV1()).outcome, 'rejected');
  assert.equal(harness.markerCalls.writes, 0);
});

test('no-backup reset requires a one-time two-step discard challenge', async () => {
  const harness = createHarness();
  await harness.coordinator.start();

  const request = harness.coordinator.requestDiscard();
  assert.equal(request.outcome, 'challenge');
  if (request.outcome !== 'challenge') throw new Error('challenge expected');
  assert.equal(harness.coordinator.requestDiscard().outcome, 'rejected');
  assert.equal(harness.coordinator.confirmDiscard('wrong-challenge').outcome, 'rejected');
  assert.equal(harness.markerCalls.writes, 0);
  assert.equal(harness.coordinator.confirmDiscard(request.challenge).outcome, 'completed');
  assert.equal(harness.coordinator.snapshot().status, 'ready-to-reset');
  assert.equal(harness.coordinator.confirmDiscard(request.challenge).outcome, 'rejected');

  assert.equal((await harness.coordinator.activateEmptyV1()).outcome, 'completed');
  assert.equal(harness.markerCalls.writes, 1);
  assert.equal(harness.backupCalls.begins, 0);
});

test('native completed journal suppresses legacy reads and reopens its fixed workspace', async () => {
  const harness = createHarness({ markerInitiallySet: true, nativePhase: 'completed' });
  const first = harness.coordinator.start();
  const concurrent = harness.coordinator.start();
  assert.equal(first, concurrent);
  assert.equal((await first).outcome, 'completed');
  assert.equal(harness.coordinator.snapshot().status, 'completed');
  assert.deepEqual(harness.sourceCalls, { snapshot: 0, settings: 0, presets: 0 });
  assert.equal(harness.targetCalls, 1);
  assert.equal(harness.coordinator.requestDiscard().outcome, 'rejected');

  assert.equal((await harness.coordinator.start()).outcome, 'completed');
  assert.deepEqual(harness.sourceCalls, { snapshot: 0, settings: 0, presets: 0 });
});

test('renderer completion marker cannot override a native required journal', async () => {
  const harness = createHarness({ markerInitiallySet: true, nativePhase: 'required' });
  assert.equal((await harness.coordinator.start()).outcome, 'completed');
  assert.equal(harness.coordinator.snapshot().status, 'backup-required');
  assert.deepEqual(harness.sourceCalls, { snapshot: 1, settings: 1, presets: 1 });
  assert.equal(harness.markers.has(LEGACY_RESET_MARKER_KEY), false);
  assert.equal(harness.markerCalls.removes, 1);
});

test('durable native intent resumes the same workspace without another authorization', async () => {
  const harness = createHarness({ nativePhase: 'intent' });
  assert.equal((await harness.coordinator.start()).outcome, 'completed');
  assert.equal(harness.coordinator.snapshot().status, 'completed');
  assert.deepEqual(harness.sourceCalls, { snapshot: 0, settings: 0, presets: 0 });
  assert.equal(harness.nativeCalls.prepares, 1);
  assert.equal(harness.nativeCalls.completes, 1);
  assert.equal(harness.backupCalls.begins, 0);
});

test('target failure leaves the native recovery journal authoritative and source untouched', async () => {
  const harness = createHarness({
    activateTarget: async () => {
      throw new Error('workspace creation failed');
    },
  });
  await harness.coordinator.start();
  await harness.coordinator.createVerifiedBackup();
  const outcome = await harness.coordinator.activateEmptyV1();

  assert.equal(outcome.outcome, 'failed');
  assert.equal(harness.coordinator.snapshot().status, 'failed');
  assert.equal(harness.coordinator.snapshot().messageKey, 'migration.reset.target_failed');
  assert.equal(harness.markers.has(LEGACY_RESET_MARKER_KEY), false);
  assert.equal(harness.markerCalls.writes, 0);
  assert.equal(harness.markerCalls.removes, 0);
  assert.deepEqual(harness.sourceCalls, { snapshot: 1, settings: 1, presets: 1 });
});

test('the legacy source contract is structurally read-only and has no delete API', () => {
  const harness = createHarness();
  assert.equal(sourceHasDelete, false);
  assert.deepEqual(Object.keys(harness.source).sort(), [
    'readPresets',
    'readSettings',
    'readSnapshot',
  ]);
  assert.equal('delete' in harness.source, false);
  assert.equal('write' in harness.source, false);
});

function withoutConsecutiveDuplicates(values: readonly LegacyResetStatus[]): LegacyResetStatus[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}
