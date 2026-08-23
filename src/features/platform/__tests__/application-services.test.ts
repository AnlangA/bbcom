import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createApplicationServices } from '@/features/platform/application/application-services.ts';
import { ApplicationNotificationRouter } from '@/features/platform/application/application-notifications.ts';
import { PortLeaseRegistry } from '@/features/serial/application/port-lease-registry.ts';

test('application services are explicit instances and shutdown both registries', async () => {
  const disposed: string[] = [];
  const options = {
    createRuntime: (session: { id: string }) => ({ sessionId: session.id }),
    disposeRuntime: (runtime: { sessionId: string }) => {
      disposed.push(runtime.sessionId);
    },
  };
  const first = createApplicationServices(
    options,
    new PortLeaseRegistry({ platform: 'windows' }),
    new ApplicationNotificationRouter(),
  );
  const second = createApplicationServices(
    options,
    new PortLeaseRegistry({ platform: 'windows' }),
    new ApplicationNotificationRouter(),
  );
  assert.notStrictEqual(first.runtimeRegistry, second.runtimeRegistry);
  assert.notStrictEqual(first.operationRegistry, second.operationRegistry);

  await first.runtimeRegistry.ensure({ id: 'session-1' });
  first.operationRegistry.create({
    operationId: 'operation-1',
    kind: 'workspace-migration',
    workspaceId: 'workspace-1',
  });
  first.operationRegistry.start('operation-1');
  const shutdown = first.shutdown();
  assert.strictEqual(first.shutdown(), shutdown);
  await shutdown;

  assert.deepEqual(disposed, ['session-1']);
  assert.equal(first.operationRegistry.get('operation-1')?.status, 'interrupted');
  assert.equal(first.runtimeRegistry.size, 0);
  assert.equal(second.runtimeRegistry.isShutdown, false);
  assert.equal(second.operationRegistry.isShutdown, false);
});
