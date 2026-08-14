import { effectScope, shallowRef, type EffectScope } from 'vue';
import { getActivePinia, setActivePinia, type Pinia } from 'pinia';
import type { SerialSession } from '../../../types';
import type { ApplicationRuntimeRegistryOptions } from '../../application/application-runtime-registry';
import type { ApplicationNotificationPort } from '../../application/application-notifications';
import type { PortLeaseClient } from '../../serial/application/port-lease-registry';
import {
  useSessionRuntimeController,
  type SessionRuntimeController,
} from './session-runtime-controller';

export interface ApplicationSessionRuntime extends SessionRuntimeController {
  updateSession(session: SerialSession): void;
}

export interface SessionRuntimeFactoryDependencies {
  readonly pinia: Pinia;
  readonly notifications: ApplicationNotificationPort;
  readonly portLeaseClient: PortLeaseClient;
}

/**
 * Registry adapter that creates every controller in a detached application
 * scope. The creating component is therefore never a runtime owner.
 */
export function createSessionRuntimeRegistryOptions(
  dependencies: SessionRuntimeFactoryDependencies,
): ApplicationRuntimeRegistryOptions<SerialSession, ApplicationSessionRuntime> {
  return {
    createRuntime: (session) => createDetachedSessionRuntime(session, dependencies),
    updateRuntime: (runtime, session) => runtime.updateSession(session),
    prepareRuntime: (runtime) => runtime.prepareShutdown(),
    disposeRuntime: (runtime) => runtime.dispose(),
  };
}

export function createDetachedSessionRuntime(
  session: SerialSession,
  dependencies: SessionRuntimeFactoryDependencies,
): ApplicationSessionRuntime {
  const scope: EffectScope = effectScope(true);
  const sessionRef = shallowRef(session);
  const previousPinia = getActivePinia();
  let controller: SessionRuntimeController | undefined;
  try {
    setActivePinia(dependencies.pinia);
    controller = scope.run(() =>
      useSessionRuntimeController(sessionRef, {
        notifications: dependencies.notifications,
        portLeaseClient: dependencies.portLeaseClient,
      }),
    );
  } finally {
    setActivePinia(previousPinia);
  }
  if (!controller) {
    scope.stop();
    throw new Error('detached session runtime factory returned no controller');
  }

  let disposeTask: Promise<void> | null = null;
  return {
    ...controller,
    updateSession(nextSession: SerialSession): void {
      if (nextSession.id !== controller.sessionId) {
        throw new Error('session runtime identity cannot change');
      }
      sessionRef.value = nextSession;
    },
    dispose(): Promise<void> {
      if (disposeTask) return disposeTask;
      disposeTask = (async () => {
        try {
          await controller.dispose();
        } finally {
          scope.stop();
        }
      })();
      return disposeTask;
    },
  };
}
