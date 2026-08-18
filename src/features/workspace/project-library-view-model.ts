import type {
  WorkspaceLibraryStatus,
  WorkspaceLibraryViewModel,
  WorkspaceNavigationAction,
  WorkspaceProjectViewModel,
} from './types';
import { WORKSPACE_RECENT_PROJECT_LIMIT } from './types';

export function createProjectLibraryViewModel(input: {
  status: WorkspaceLibraryStatus;
  projects: readonly WorkspaceProjectViewModel[];
  activeWorkspaceId: string | null;
  navigationAction: WorkspaceNavigationAction | null;
  messageKey: string | null;
}): WorkspaceLibraryViewModel {
  const busy = input.navigationAction !== null;
  // Library order is domain state owned by the coordinator. Selection is a
  // projection only: it must never mutate or re-sort the navigation list.
  const projects = input.projects.map((project) =>
    Object.freeze({ ...project, active: project.workspaceId === input.activeWorkspaceId }),
  );
  // Recency is a separate shortcut projection. Keeping its sort isolated
  // prevents activity timestamps from leaking into the stable sidebar order.
  const recentProjects = [...projects]
    .sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs || left.workspaceId.localeCompare(right.workspaceId),
    )
    .slice(0, WORKSPACE_RECENT_PROJECT_LIMIT);
  return Object.freeze({
    status: input.status,
    activeWorkspaceId: input.activeWorkspaceId,
    messageKey: input.messageKey,
    actions: Object.freeze({
      newProject: Object.freeze({
        id: 'new-project',
        enabled: !busy,
        busy: input.navigationAction === 'create',
      }),
      openProject: Object.freeze({
        id: 'open-project',
        enabled: !busy,
        busy: input.navigationAction === 'open',
      }),
      importProject: Object.freeze({
        id: 'import-project',
        enabled: !busy,
        busy: input.navigationAction === 'import',
      }),
    }),
    projects: Object.freeze(projects),
    recentProjects: Object.freeze(recentProjects),
  });
}
