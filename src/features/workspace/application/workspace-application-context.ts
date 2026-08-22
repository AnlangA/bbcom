import { inject } from 'vue';
import type { WorkspaceCoordinator } from '../workspace-coordinator';
import type { WorkspaceApplicationService } from './workspace-application-service';
import { WORKSPACE_APPLICATION_KEY } from '@/bootstrap/provide-keys';

export { WORKSPACE_APPLICATION_KEY } from '@/bootstrap/provide-keys';

export interface WorkspaceApplicationContext {
  readonly coordinator: WorkspaceCoordinator;
  readonly application: WorkspaceApplicationService;
}

export function useWorkspaceApplication(): WorkspaceApplicationContext {
  const context = inject(WORKSPACE_APPLICATION_KEY, null) as WorkspaceApplicationContext | null;
  if (!context) throw new Error('workspace application context is unavailable');
  return context;
}

export function useOptionalWorkspaceApplication(): WorkspaceApplicationContext | null {
  return inject(WORKSPACE_APPLICATION_KEY, null) as WorkspaceApplicationContext | null;
}
