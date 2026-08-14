import type {
  ShutdownCancellation,
  ShutdownCloseRequest,
  ShutdownConfirmation,
  ShutdownCoordinatorSnapshot,
  ShutdownDrainResult,
} from './types';
import { ShutdownCoordinator } from './shutdown-coordinator';
import { ShutdownProtocolAdapter, type ShutdownProtocolPort } from './shutdown-protocol-adapter';
import type { ShutdownCloseRequestSource } from './tauri-shutdown-port';

export type ApplicationShutdownBoundaryErrorPhase =
  'listen' | 'close-request' | 'wait' | 'cancel' | 'force';

export interface ApplicationShutdownSnapshot {
  readonly coordinator: ShutdownCoordinatorSnapshot;
  /** Stable UI state only; native error payloads and paths are never retained. */
  readonly boundaryError: ApplicationShutdownBoundaryErrorPhase | null;
}

export type ApplicationShutdownListener = (snapshot: ApplicationShutdownSnapshot) => void;

export interface ApplicationQuiescePort {
  /** Interrupt operations and quiet runtimes without sealing either registry. */
  prepareShutdown(): Promise<void>;
}

export interface SessionPersistenceShutdownPort {
  flushFinalPersistence(): Promise<'completed' | 'timeout'>;
}

export interface SettingsShutdownPort {
  /** Returns false when the synchronous physical write could not be completed. */
  flushSettings(): boolean;
}

export interface WorkspacePersistenceShutdownPort {
  flush(): Promise<{ readonly outcome: 'completed' | 'cancelled' | 'failed' | 'stale' }>;
}

export interface ApplicationShutdownBootstrapOptions {
  readonly application: ApplicationQuiescePort;
  readonly sessionPersistence: SessionPersistenceShutdownPort;
  readonly appSettings: SettingsShutdownPort;
  readonly serialSettings: SettingsShutdownPort;
  readonly workspacePersistence?: WorkspacePersistenceShutdownPort;
  readonly protocol: ShutdownProtocolPort;
  readonly closeRequests: ShutdownCloseRequestSource;
  readonly coordinator?: ShutdownCoordinator;
}

export interface ApplicationShutdownController {
  start(): Promise<void>;
  stop(): void;
  snapshot(): ApplicationShutdownSnapshot;
  subscribe(listener: ApplicationShutdownListener): () => void;
  wait(attemptId: string): Promise<ShutdownDrainResult>;
  cancel(attemptId: string): Promise<ShutdownCancellation>;
  force(attemptId: string): Promise<ShutdownConfirmation>;
  /** Retry only the failed native publication; never replay drain side effects. */
  retryPublication(attemptId: string): Promise<void>;
}

/**
 * Build the renderer close coordinator and register the three fixed phase-gate
 * participants. Constructing it is side-effect free; `start` owns the native
 * event subscription.
 */
export function createApplicationShutdownController(
  options: ApplicationShutdownBootstrapOptions,
): ApplicationShutdownController {
  const coordinator = options.coordinator ?? new ShutdownCoordinator();
  const adapter = new ShutdownProtocolAdapter(coordinator, options.protocol);
  const listeners = new Set<ApplicationShutdownListener>();
  let boundaryError: ApplicationShutdownBoundaryErrorPhase | null = null;
  let unlisten: (() => void) | null = null;
  let startTask: Promise<void> | null = null;

  coordinator.register({
    name: 'application-quiesce',
    priority: 500,
    timeoutMs: 2_500,
    drain: () => options.application.prepareShutdown(),
  });
  coordinator.register({
    name: 'session-persistence',
    priority: 200,
    timeoutMs: 2_000,
    repeatableBarrier: true,
    drain: async () => {
      const result = await options.sessionPersistence.flushFinalPersistence();
      if (result !== 'completed') throw new Error('session persistence did not complete');
    },
  });
  if (options.workspacePersistence) {
    coordinator.register({
      name: 'workspace-persistence',
      priority: 100,
      timeoutMs: 2_000,
      repeatableBarrier: true,
      drain: async () => {
        const result = await options.workspacePersistence!.flush();
        if (result.outcome !== 'completed') {
          throw new Error('workspace persistence did not complete');
        }
      },
    });
  }
  coordinator.register({
    name: 'settings',
    priority: 100,
    timeoutMs: 1_000,
    repeatableBarrier: true,
    drain: () => {
      const appSaved = options.appSettings.flushSettings();
      const serialSaved = options.serialSettings.flushSettings();
      if (!appSaved || !serialSaved) throw new Error('settings persistence did not complete');
    },
  });

  coordinator.subscribe(() => notify());

  function snapshot(): ApplicationShutdownSnapshot {
    return Object.freeze({
      coordinator: coordinator.snapshot(),
      boundaryError,
    });
  }

  function notify(): void {
    if (listeners.size === 0) return;
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // UI observers cannot change shutdown semantics.
      }
    }
  }

  function markBoundaryError(phase: ApplicationShutdownBoundaryErrorPhase): void {
    boundaryError = phase;
    notify();
  }

  function clearBoundaryError(): void {
    if (boundaryError === null) return;
    boundaryError = null;
    notify();
  }

  async function completeReadyDrain(result: ShutdownDrainResult): Promise<ShutdownDrainResult> {
    if (result.state === 'ready') await adapter.confirmExit(result.attemptId);
    return result;
  }

  async function handleCloseRequest(request: ShutdownCloseRequest): Promise<void> {
    clearBoundaryError();
    await completeReadyDrain(await adapter.handleCloseRequest(request));
  }

  const controller: ApplicationShutdownController = {
    start(): Promise<void> {
      if (unlisten) return Promise.resolve();
      if (startTask) return startTask;
      startTask = options.closeRequests
        .listen((request) => {
          void handleCloseRequest(request).catch(() => markBoundaryError('close-request'));
        })
        .then((detach) => {
          unlisten = detach;
          clearBoundaryError();
        })
        .catch((error: unknown) => {
          markBoundaryError('listen');
          throw error;
        })
        .finally(() => {
          startTask = null;
        });
      return startTask;
    },
    stop(): void {
      unlisten?.();
      unlisten = null;
    },
    snapshot,
    subscribe(listener: ApplicationShutdownListener): () => void {
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch {
        // UI observers cannot change shutdown semantics.
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async wait(attemptId: string): Promise<ShutdownDrainResult> {
      try {
        clearBoundaryError();
        return await completeReadyDrain(await adapter.wait(attemptId));
      } catch (error) {
        markBoundaryError('wait');
        throw error;
      }
    },
    async cancel(attemptId: string): Promise<ShutdownCancellation> {
      try {
        clearBoundaryError();
        return await adapter.cancel(attemptId);
      } catch (error) {
        markBoundaryError('cancel');
        throw error;
      }
    },
    async force(attemptId: string): Promise<ShutdownConfirmation> {
      try {
        clearBoundaryError();
        return await adapter.force(attemptId);
      } catch (error) {
        markBoundaryError('force');
        throw error;
      }
    },
    async retryPublication(attemptId: string): Promise<void> {
      const failedPhase = boundaryError;
      if (failedPhase === null || failedPhase === 'listen') {
        throw new Error('there is no retryable shutdown publication');
      }
      try {
        clearBoundaryError();
        if (failedPhase === 'cancel') {
          await adapter.cancel(attemptId);
          return;
        }
        if (failedPhase === 'force') {
          await adapter.force(attemptId);
          return;
        }
        await completeReadyDrain(await adapter.retryReport(attemptId));
      } catch (error) {
        markBoundaryError(failedPhase);
        throw error;
      }
    },
  };
  return Object.freeze(controller);
}

/** Create the controller and attach the native close listener exactly once. */
export async function bootstrapApplicationShutdown(
  options: ApplicationShutdownBootstrapOptions,
): Promise<ApplicationShutdownController> {
  const controller = createApplicationShutdownController(options);
  await controller.start();
  return controller;
}
