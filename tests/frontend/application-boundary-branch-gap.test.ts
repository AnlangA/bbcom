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
import { TauriShutdownPort } from '../../src/features/shutdown/tauri-shutdown-port.ts';

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
