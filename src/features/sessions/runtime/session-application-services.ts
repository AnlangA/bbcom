import { getCurrentInstance, inject, onScopeDispose, ref, type InjectionKey } from 'vue';
import type { SerialSession } from '../../../types';
import type { ApplicationServices } from '../../application';
import type { ApplicationSessionRuntime } from './session-runtime-factory';
import type { SessionRuntimeStatusRegistry } from './session-runtime-status';
import type { SessionRuntimeStatus } from './session-runtime-status';
import { useSessionCoreStore } from '../../../stores/session-core';

export type SessionApplicationServices = ApplicationServices<
  SerialSession,
  ApplicationSessionRuntime
> & {
  readonly runtimeStatusRegistry: SessionRuntimeStatusRegistry;
};

export const SESSION_APPLICATION_SERVICES_KEY: InjectionKey<SessionApplicationServices> = Symbol(
  'bbcom.session-application-services',
);

export function useSessionApplicationServices(): SessionApplicationServices {
  const services = inject(SESSION_APPLICATION_SERVICES_KEY);
  if (!services) throw new Error('session application services were not provided');
  return services;
}

/** Reactive reader for the process-owned connection status authority. */
export function useSessionRuntimeStatuses(): {
  statusOf(sessionId: string): SessionRuntimeStatus;
  isConnected(sessionId: string): boolean;
} {
  const services = getCurrentInstance() ? inject(SESSION_APPLICATION_SERVICES_KEY, null) : null;
  const fallbackCore = services ? null : useSessionCoreStore();
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
