import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { ApplicationNotificationRouter } from '../../src/features/application/application-notifications.ts';
import { createApplicationServices } from '../../src/features/application/application-services.ts';
import { PortLeaseRegistry } from '../../src/features/serial/application/port-lease-registry.ts';
import { TauriLegacyBackupPort } from '../../src/features/migration/tauri-legacy-backup-port.ts';
import { TauriLegacyResetPort } from '../../src/features/migration/tauri-legacy-reset-port.ts';
import { TauriShutdownPort } from '../../src/features/shutdown/tauri-shutdown-port.ts';
import type { LegacyBackupContent } from '../../src/features/migration/types.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const content: LegacyBackupContent = {
  format: 'bbcom-legacy-readonly-backup-v1',
  sourceVersion: '0.7.3',
  createdAtMs: 123,
  snapshot: { sessions: [] },
  settings: { locale: 'en' },
  presets: {},
};

function requestOf(args: unknown): { requestId: string; [key: string]: unknown } {
  return (args as { request: { requestId: string; [key: string]: unknown } }).request;
}

function journalResponse(args: unknown, journal: Record<string, unknown>) {
  return { requestId: requestOf(args).requestId, journal };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReset();
  tauri.listen.mockReset();
});

test('notification routing isolates sinks, detaches observers, and seals on shutdown', () => {
  const router = new ApplicationNotificationRouter();
  const received: string[] = [];
  const detach = router.attach({
    info: (message) => received.push(`info:${message}`),
    success: (message) => received.push(`success:${message}`),
    warning: (message) => received.push(`warning:${message}`),
    error: (message) => received.push(`error:${message}`),
  });
  router.attach({
    info: () => {
      throw new Error('sink failure');
    },
    success: () => undefined,
    warning: () => undefined,
    error: () => undefined,
  });
  router.info('one');
  router.success('two');
  router.warning('three');
  router.error('four');
  assert.deepEqual(received, ['info:one', 'success:two', 'warning:three', 'error:four']);
  detach();
  router.info('detached');
  router.shutdown();
  router.error('sealed');
  const inertDetach = router.attach({
    info: () => assert.fail(),
    success: () => assert.fail(),
    warning: () => assert.fail(),
    error: () => assert.fail(),
  });
  inertDetach();
});

test('application services aggregate preparation and final-shutdown failures', async () => {
  const prepareServices = createApplicationServices(
    {
      createRuntime: (session: { id: string }) => ({ id: session.id }),
      prepareRuntime: async () => {
        throw new Error('runtime prepare failed');
      },
      disposeRuntime: () => undefined,
    },
    new PortLeaseRegistry({ platform: 'windows' }),
    new ApplicationNotificationRouter(),
  );
  await prepareServices.runtimeRegistry.ensure({ id: 'prepare-runtime' });
  prepareServices.operationRegistry.create({
    operationId: 'prepare-operation',
    kind: 'serial-send',
    workspaceId: 'workspace-main',
    cancel: async () => {
      throw new Error('operation prepare failed');
    },
  });
  const firstPrepare = prepareServices.prepareShutdown();
  assert.strictEqual(prepareServices.prepareShutdown(), firstPrepare);
  await assert.rejects(firstPrepare, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  await assert.rejects(prepareServices.prepareShutdown(), AggregateError);

  const leases = new PortLeaseRegistry({ platform: 'windows', leaseIdFactory: () => 'lease-1' });
  const notifications = new ApplicationNotificationRouter();
  notifications.attach({ info() {}, success() {}, warning() {}, error() {} });
  leases.acquire('COM9', 'session-1', 'Session 1');
  const shutdownServices = createApplicationServices(
    {
      createRuntime: (session: { id: string }) => ({ id: session.id }),
      disposeRuntime: async () => {
        throw new Error('runtime disposal failed');
      },
    },
    leases,
    notifications,
  );
  await shutdownServices.runtimeRegistry.ensure({ id: 'shutdown-runtime' });
  shutdownServices.operationRegistry.create({
    operationId: 'shutdown-operation',
    kind: 'serial-send',
    workspaceId: 'workspace-main',
    cancel: async () => {
      throw new Error('operation shutdown failed');
    },
  });
  const firstShutdown = shutdownServices.shutdown();
  assert.strictEqual(shutdownServices.shutdown(), firstShutdown);
  await assert.rejects(firstShutdown, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.equal(leases.isShutdown, true);
  assert.equal(
    notifications.attach({ info() {}, success() {}, warning() {}, error() {} })(),
    undefined,
  );
});

test('Tauri shutdown boundary covers browser, native listener, custom names, and all commands', async () => {
  tauri.isTauri.mockReturnValue(false);
  const browserDetach = await new TauriShutdownPort().listen(() => assert.fail());
  browserDetach();

  const detached = vi.fn();
  let nativeEvent: ((event: { payload: { attemptId: string } }) => void) | undefined;
  tauri.isTauri.mockReturnValue(true);
  tauri.listen.mockImplementation(async (_name: string, listener: typeof nativeEvent) => {
    nativeEvent = listener;
    return detached;
  });
  tauri.invoke.mockResolvedValue(undefined);
  const port = new TauriShutdownPort({
    closeRequestEvent: 'custom-close',
    submitReportCommand: 'custom-report',
    confirmExitCommand: 'custom-confirm',
    cancelExitCommand: 'custom-cancel',
  });
  const requests: string[] = [];
  const detach = await port.listen((request) => requests.push(request.attemptId));
  nativeEvent?.({ payload: { attemptId: 'attempt-native' } });
  assert.deepEqual(requests, ['attempt-native']);
  await port.submitShutdownReport({ attemptId: 'a' } as never);
  await port.confirmExit({ attemptId: 'a' } as never);
  await port.cancelExit({ attemptId: 'a' } as never);
  assert.deepEqual(
    tauri.invoke.mock.calls.map((call) => call[0]),
    ['custom-report', 'custom-confirm', 'custom-cancel'],
  );
  detach();
  assert.equal(detached.mock.calls.length, 1);
});

test('legacy reset transport validates authorization, correlation, journals, tokens, and aborts', async () => {
  const port = new TauriLegacyResetPort();
  const live = new AbortController();
  const aborted = new AbortController();
  aborted.abort();

  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) =>
    journalResponse(args, { phase: 'required' }),
  );
  assert.deepEqual(await port.getJournal({ signal: live.signal }), { phase: 'required' });

  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) =>
    journalResponse(args, { phase: 'required', workspaceId }),
  );
  await assert.rejects(port.getJournal({ signal: live.signal }), /invalid required reset journal/);

  tauri.invoke.mockImplementationOnce(async () => ({
    requestId: 'wrong-correlation',
    journal: { phase: 'required' },
  }));
  await assert.rejects(port.getJournal({ signal: live.signal }), /correlation/);

  const postAbort = new AbortController();
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => {
    postAbort.abort();
    return journalResponse(args, { phase: 'required' });
  });
  await assert.rejects(port.getJournal({ signal: postAbort.signal }), { name: 'AbortError' });

  await assert.rejects(port.beginDiscard({ signal: aborted.signal }), { name: 'AbortError' });
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => ({
    requestId: requestOf(args).requestId,
    discardToken: '/invalid token',
  }));
  await assert.rejects(port.beginDiscard({ signal: live.signal }), /invalid native discard token/);
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => ({
    requestId: requestOf(args).requestId,
    discardToken: 'discard-token:1',
  }));
  assert.equal(await port.beginDiscard({ signal: live.signal }), 'discard-token:1');

  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => {
    const request = requestOf(args);
    assert.equal(request.verifiedBackupId, undefined);
    assert.equal(request.discardToken, undefined);
    assert.equal(request.emptyLegacyState, undefined);
    return journalResponse(args, { phase: 'intent', workspaceId, expectedRevision: 0 });
  });
  assert.equal((await port.prepare({}, { signal: live.signal })).phase, 'intent');

  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => {
    const request = requestOf(args);
    assert.equal(request.verifiedBackupId, 'backup-1');
    assert.equal(request.discardToken, 'discard-1');
    assert.equal(request.emptyLegacyState, true);
    return journalResponse(args, { phase: 'workspaceReady', workspaceId, expectedRevision: 0 });
  });
  assert.equal(
    (
      await port.prepare(
        {
          verifiedBackupId: 'backup-1',
          discardToken: 'discard-1',
          emptyLegacyState: true,
        } as never,
        { signal: live.signal },
      )
    ).phase,
    'workspaceReady',
  );

  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) =>
    journalResponse(args, { phase: 'intent', workspaceId: 'bad', expectedRevision: 0 }),
  );
  await assert.rejects(port.prepare({}, { signal: live.signal }), /invalid native reset journal/);
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) =>
    journalResponse(args, { phase: 'intent', workspaceId, expectedRevision: 1 }),
  );
  await assert.rejects(port.prepare({}, { signal: live.signal }), /invalid native reset journal/);
  await assert.rejects(port.complete(workspaceId, 0, { signal: aborted.signal }), {
    name: 'AbortError',
  });
});

test('legacy backup transport validates receipts, verification correlation, results, and aborts', async () => {
  const port = new TauriLegacyBackupPort();
  const live = new AbortController();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(port.beginEncryptedBackup(content, 'secret', { signal: aborted.signal }), {
    name: 'AbortError',
  });

  tauri.invoke.mockImplementationOnce(async (command: string, args: unknown) => {
    assert.equal(command, 'begin_legacy_backup');
    const request = requestOf(args);
    assert.equal(request.passphrase, 'secret');
    assert.equal(request.passphraseConfirmation, 'secret');
    assert.deepEqual(request.content, content);
    return { requestId: request.requestId, backupId: 'backup:good' };
  });
  assert.deepEqual(await port.beginEncryptedBackup(content, 'secret', { signal: live.signal }), {
    backupId: 'backup:good',
  });

  tauri.invoke.mockImplementationOnce(async () => ({
    requestId: 'wrong',
    backupId: 'backup:good',
  }));
  await assert.rejects(
    port.beginEncryptedBackup(content, 'secret', { signal: live.signal }),
    /invalid legacy backup receipt/,
  );
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => ({
    requestId: requestOf(args).requestId,
    backupId: 'bad id',
  }));
  await assert.rejects(
    port.beginEncryptedBackup(content, 'secret', { signal: live.signal }),
    /invalid legacy backup receipt/,
  );
  const postAbort = new AbortController();
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => {
    postAbort.abort();
    return { requestId: requestOf(args).requestId, backupId: 'backup:good' };
  });
  await assert.rejects(port.beginEncryptedBackup(content, 'secret', { signal: postAbort.signal }), {
    name: 'AbortError',
  });

  await assert.rejects(
    port.verifyEncryptedBackup({ backupId: 'bad id' }, content, 'secret', { signal: live.signal }),
    /invalid legacy backup receipt/,
  );
  await assert.rejects(
    port.verifyEncryptedBackup({ backupId: 'backup:good' }, content, 'secret', {
      signal: aborted.signal,
    }),
    { name: 'AbortError' },
  );
  for (const verified of [true, false]) {
    tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => ({
      requestId: requestOf(args).requestId,
      backupId: 'backup:good',
      verified,
    }));
    assert.deepEqual(
      await port.verifyEncryptedBackup({ backupId: 'backup:good' }, content, 'secret', {
        signal: live.signal,
      }),
      { verified },
    );
  }
  tauri.invoke.mockImplementationOnce(async () => ({
    requestId: 'wrong',
    backupId: 'backup:good',
    verified: true,
  }));
  await assert.rejects(
    port.verifyEncryptedBackup({ backupId: 'backup:good' }, content, 'secret', {
      signal: live.signal,
    }),
    /verification correlation failed/,
  );
  tauri.invoke.mockImplementationOnce(async (_command: string, args: unknown) => ({
    requestId: requestOf(args).requestId,
    backupId: 'backup:other',
    verified: true,
  }));
  await assert.rejects(
    port.verifyEncryptedBackup({ backupId: 'backup:good' }, content, 'secret', {
      signal: live.signal,
    }),
    /verification correlation failed/,
  );
});
