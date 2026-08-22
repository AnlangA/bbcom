import { defineStore } from 'pinia';

import {
  enterWorkspaceSessionPersistenceMode,
  exposeSessionStoreForPinia,
  SessionStore,
  type CompleteWorkspaceRebindResult,
  type DeletedSessionSnapshot,
  type SessionCreationOptions,
  type SessionStoreFacade,
  type UndoDeletedSessionResult,
  type WorkspaceSessionChangeEvent,
  type WorkspaceSessionChangeListener,
  type WorkspaceSessionMutationPermissions,
} from '@/features/sessions/application/session-store';

export {
  enterWorkspaceSessionPersistenceMode,
  type CompleteWorkspaceRebindResult,
  type DeletedSessionSnapshot,
  type SessionCreationOptions,
  type UndoDeletedSessionResult,
  type WorkspaceSessionChangeEvent,
  type WorkspaceSessionChangeListener,
  type WorkspaceSessionMutationPermissions,
};

export type { SessionStore, SessionStoreFacade };

/** Headless graph owned by the active Pinia facade (tests may create many Pinia roots). */
let activeHeadlessSessionStore: SessionStore | null = null;

export function resolveHeadlessSessionStore(): SessionStore {
  if (!activeHeadlessSessionStore) {
    useSessionStore();
  }
  if (!activeHeadlessSessionStore) {
    throw new Error('session store was not initialized');
  }
  return activeHeadlessSessionStore;
}

/**
 * Pinia facade over the headless {@link SessionStore} graph.
 *
 * Each Pinia instance owns exactly one {@link SessionStore}; feature ports
 * select members from this facade so they share controllers, refs and listeners.
 */
export const useSessionStore = defineStore('session-store', () => {
  const sessionStore = new SessionStore();
  activeHeadlessSessionStore = sessionStore;
  return exposeSessionStoreForPinia(sessionStore);
});

/** @deprecated Use {@link useSessionStore} instead. */
export const useSessionCoreStore = useSessionStore;
