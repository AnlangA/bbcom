import { inject } from 'vue';
import type { ApplicationShutdownController } from './application-shutdown-bootstrap';
import { APPLICATION_SHUTDOWN_KEY } from '@/bootstrap/provide-keys';

export { APPLICATION_SHUTDOWN_KEY } from '@/bootstrap/provide-keys';

export function useApplicationShutdown(): ApplicationShutdownController {
  const controller = inject(APPLICATION_SHUTDOWN_KEY, null) as ApplicationShutdownController | null;
  if (!controller) throw new Error('application shutdown controller is not provided');
  return controller;
}

export function useOptionalApplicationShutdown(): ApplicationShutdownController | null {
  return inject(APPLICATION_SHUTDOWN_KEY, null) as ApplicationShutdownController | null;
}
