import {
  ApplicationRuntimeRegistry,
  type ApplicationRuntimeRegistryOptions,
  type ApplicationSessionIdentity,
} from './application-runtime-registry';
import { ApplicationNotificationRouter } from './application-notifications';
import { OperationRegistry } from './operation-registry';
import type { PortLeaseRegistry } from '../serial';

export interface ApplicationServices<TSession extends ApplicationSessionIdentity, TRuntime> {
  readonly runtimeRegistry: ApplicationRuntimeRegistry<TSession, TRuntime>;
  readonly operationRegistry: OperationRegistry;
  readonly portLeaseRegistry: PortLeaseRegistry;
  readonly notifications: ApplicationNotificationRouter;
  /** Quiet current work for a prevented close without sealing application services. */
  prepareShutdown(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Construct one explicitly owned application service graph. No module-level
 * singleton is created; the application entry point retains this object.
 */
export function createApplicationServices<TSession extends ApplicationSessionIdentity, TRuntime>(
  runtimeOptions: ApplicationRuntimeRegistryOptions<TSession, TRuntime>,
  portLeaseRegistry: PortLeaseRegistry,
  notifications: ApplicationNotificationRouter,
): ApplicationServices<TSession, TRuntime> {
  const runtimeRegistry = new ApplicationRuntimeRegistry(runtimeOptions);
  const operationRegistry = new OperationRegistry();
  let prepareTask: Promise<void> | null = null;
  let shutdownTask: Promise<void> | null = null;

  return Object.freeze({
    runtimeRegistry,
    operationRegistry,
    portLeaseRegistry,
    notifications,
    prepareShutdown(): Promise<void> {
      if (prepareTask) return prepareTask;
      prepareTask = prepareServices(operationRegistry, runtimeRegistry).finally(() => {
        prepareTask = null;
      });
      return prepareTask;
    },
    shutdown(): Promise<void> {
      if (shutdownTask) return shutdownTask;
      shutdownTask = shutdownServices(
        operationRegistry,
        runtimeRegistry,
        portLeaseRegistry,
        notifications,
      );
      return shutdownTask;
    },
  });
}

async function prepareServices<TSession extends ApplicationSessionIdentity, TRuntime>(
  operations: OperationRegistry,
  runtimes: ApplicationRuntimeRegistry<TSession, TRuntime>,
): Promise<void> {
  const results = await Promise.allSettled([
    operations.interruptActive(),
    runtimes.prepareShutdown(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'application services failed to prepare for shutdown');
  }
}

async function shutdownServices<TSession extends ApplicationSessionIdentity, TRuntime>(
  operations: OperationRegistry,
  runtimes: ApplicationRuntimeRegistry<TSession, TRuntime>,
  portLeases: PortLeaseRegistry,
  notifications: ApplicationNotificationRouter,
): Promise<void> {
  const results = await Promise.allSettled([operations.shutdown(), runtimes.shutdown()]);
  portLeases.shutdown();
  notifications.shutdown();
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0)
    throw new AggregateError(failures, 'application services failed to shut down');
}
