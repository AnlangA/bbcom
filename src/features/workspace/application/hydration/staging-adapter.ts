import type { ActiveWorkspaceViewModel } from '@/features/workspace/types';
import type { WorkspaceHydrationStaging } from '../../adapters';
import type { WorkspaceCoordinator } from '../../workspace-coordinator';
import { WORKSPACE_STOPPED_ACTIVITY_POLICY, type WorkspaceFacadeSnapshot } from '../types';

export function assertSameSessionSet(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length) throw new Error('workspace session header mismatch');
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expectedSet.size !== expected.length ||
    actualSet.size !== actual.length ||
    expected.some((sessionId) => !actualSet.has(sessionId))
  ) {
    throw new Error('workspace session header mismatch');
  }
}

export function assertCurrentHydration(
  coordinator: WorkspaceCoordinator,
  activations: { isActive(attempt: { controller: AbortController; phase: string }): boolean },
  attempt: { controller: AbortController; phase: string },
  header: ActiveWorkspaceViewModel,
  staging: WorkspaceHydrationStaging,
): void {
  if (
    !activations.isActive(attempt) ||
    coordinator.activeWorkspaceId !== header.workspaceId ||
    staging.workspaceId !== header.workspaceId ||
    staging.revision !== header.revision
  ) {
    const error = new Error('stale workspace hydration');
    error.name = 'AbortError';
    throw error;
  }
  const coordinatorHeader = coordinator.snapshot().activeWorkspace;
  if (!coordinatorHeader || coordinatorHeader.revision !== header.revision) {
    throw new Error('workspace revision changed during hydration');
  }
  assertSameSessionSet(
    header.sessionIds,
    staging.sessions.map((entry) => entry.session.id),
  );
  for (const entry of staging.sessions) {
    if (
      entry.rebind.required !== true ||
      entry.session.isConnected !== false ||
      entry.session.autoLogEnabled !== false ||
      entry.session.logPath !== null
    ) {
      throw new Error('hydrated workspace contains active runtime state');
    }
  }
}

export function createFacadeSnapshot(
  header: ActiveWorkspaceViewModel,
  staging: WorkspaceHydrationStaging,
): WorkspaceFacadeSnapshot {
  return Object.freeze({
    workspaceId: header.workspaceId,
    name: header.name,
    revision: header.revision,
    activeSessionId: staging.activeSessionId,
    sessions: staging.sessions,
    layout: header.layout,
    activityPolicy: WORKSPACE_STOPPED_ACTIVITY_POLICY,
  });
}

export function freezeActive(active: ActiveWorkspaceViewModel): ActiveWorkspaceViewModel {
  return Object.freeze({
    workspaceId: active.workspaceId,
    name: active.name,
    revision: active.revision,
    activeSessionId: active.activeSessionId,
    sessionIds: Object.freeze([...active.sessionIds]),
    saveHealth: active.saveHealth,
    layout: active.layout,
  });
}
