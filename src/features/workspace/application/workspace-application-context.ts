import { inject, type InjectionKey } from 'vue';
import type { WorkspaceCoordinator } from '../workspace-coordinator';
import type { WorkspaceApplicationService } from './workspace-application-service';

export interface WorkspaceApplicationContext {
  readonly coordinator: WorkspaceCoordinator;
  readonly application: WorkspaceApplicationService;
}

export const WORKSPACE_APPLICATION_KEY: InjectionKey<WorkspaceApplicationContext> = Symbol(
  'bbcom-workspace-application',
);

export function useWorkspaceApplication(): WorkspaceApplicationContext {
  const context = inject(WORKSPACE_APPLICATION_KEY, null);
  if (!context) throw new Error('workspace application context is unavailable');
  return context;
}

export function useOptionalWorkspaceApplication(): WorkspaceApplicationContext | null {
  return inject(WORKSPACE_APPLICATION_KEY, null);
}
