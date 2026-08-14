// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import SessionRuntimeHost from '../../src/features/sessions/ui/SessionRuntimeHost.vue';
import { SESSION_APPLICATION_SERVICES_KEY } from '../../src/features/sessions/runtime/session-application-services.ts';
import type { SerialSession } from '../../src/types/session.ts';

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('host ensures the active runtime and unmount only detaches application observers', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const firstSession = { id: 'session-1' } as SerialSession;
  const secondSession = { id: 'session-2' } as SerialSession;
  const gate = deferred();
  const listeners = new Set<(entries: readonly unknown[]) => void>();
  const ensure = vi.fn(async () => {
    await gate.promise;
    return { sessionId: 'session-1' };
  });
  const reconcile = vi.fn(async () => undefined);
  const disposeSession = vi.fn(async () => undefined);
  const detachNotifications = vi.fn();
  const services = {
    runtimeRegistry: {
      list: () => [],
      subscribe: (listener: (entries: readonly unknown[]) => void) => {
        listeners.add(listener);
        listener([]);
        return () => listeners.delete(listener);
      },
      reconcile,
      ensure,
      disposeSession,
    },
    notifications: {
      attach: () => detachNotifications,
    },
  };
  const wrapper = mount(SessionRuntimeHost, {
    props: { sessions: [firstSession], activeSessionId: 'session-1' },
    global: {
      plugins: [pinia],
      provide: { [SESSION_APPLICATION_SERVICES_KEY as symbol]: services },
      stubs: { SessionView: true },
    },
  });

  await nextTick();
  assert.deepEqual(reconcile.mock.calls[0]?.[0], [firstSession]);
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ensure.mock.calls.length, 1);

  await wrapper.setProps({ sessions: [firstSession, secondSession], activeSessionId: 'session-2' });
  await nextTick();
  await Promise.resolve();
  assert.equal(reconcile.mock.calls.length, 2);
  assert.equal(ensure.mock.calls.length, 2);

  wrapper.unmount();
  assert.equal(listeners.size, 0);
  assert.equal(detachNotifications.mock.calls.length, 1);
  assert.equal(disposeSession.mock.calls.length, 0);
});
