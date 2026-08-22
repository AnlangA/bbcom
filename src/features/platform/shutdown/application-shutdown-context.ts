import { inject, type InjectionKey } from 'vue';
import type { ApplicationShutdownController } from './application-shutdown-bootstrap';

export const APPLICATION_SHUTDOWN_KEY: InjectionKey<ApplicationShutdownController> = Symbol(
  'bbcom-application-shutdown',
);

export function useApplicationShutdown(): ApplicationShutdownController {
  const controller = inject(APPLICATION_SHUTDOWN_KEY, null);
  if (!controller) throw new Error('application shutdown controller is not provided');
  return controller;
}

export function useOptionalApplicationShutdown(): ApplicationShutdownController | null {
  return inject(APPLICATION_SHUTDOWN_KEY, null);
}
