import { getCurrentInstance, inject, onScopeDispose, ref } from 'vue';
import type { SerialSession } from '@/types';
import type { ApplicationServices } from '@/features/platform/application';
import type { ApplicationSessionRuntime } from './session-runtime-factory';
import type { SessionRuntimeStatusRegistry } from './session-runtime-status';
import type { SessionRuntimeStatus } from './session-runtime-status';
import { useSessionStore } from '@/features/sessions/store/session-store';
import { SESSION_APPLICATION_SERVICES_KEY } from '@/bootstrap/provide-keys';

export { SESSION_APPLICATION_SERVICES_KEY } from '@/bootstrap/provide-keys';

export type SessionApplicationServices = ApplicationServices<
  SerialSession,
  ApplicationSessionRuntime
> & {
  readonly runtimeStatusRegistry: SessionRuntimeStatusRegistry;
};

export function useSessionApplicationServices(): SessionApplicationServices {
  const services = inject(SESSION_APPLICATION_SERVICES_KEY) as SessionApplicationServices | undefined;
  if (!services) throw new Error('session application services were not provided');
  return services;
}

/** Reactive reader for the process-owned connection status authority. */
export function useSessionRuntimeStatuses(): {
  statusOf(sessionId: string): SessionRuntimeStatus;
  isConnected(sessionId: string): boolean;
} {
  const services = getCurrentInstance()
    ? (inject(SESSION_APPLICATION_SERVICES_KEY, null) as SessionApplicationServices | null)
    : null;
  const fallbackCore = services ? null : useSessionStore();
  const revision = ref(0);
  const unsubscribe = services?.runtimeStatusRegistry.subscribeAll(() => {
    revision.value += 1;
  });
  if (unsubscribe && getCurrentInstance()) onScopeDispose(unsubscribe);
  return {
    statusOf(sessionId) {
      void revision.value;
      return (
        services?.runtimeStatusRegistry.get(sessionId) ?? {
          phase: fallbackCore?.sessions.find((session) => session.id === sessionId)?.isConnected
            ? 'connected'
            : 'stopped',
          droppedBytes:
            fallbackCore?.sessions.find((session) => session.id === sessionId)?.droppedBytes ?? 0,
          failure: null,
        }
      );
    },
    isConnected(sessionId) {
      void revision.value;
      if (services) return services.runtimeStatusRegistry.get(sessionId).phase === 'connected';
      return (
        fallbackCore?.sessions.find((session) => session.id === sessionId)?.isConnected === true
      );
    },
  };
}
