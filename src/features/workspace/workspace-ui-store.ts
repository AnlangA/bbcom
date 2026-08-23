import { defineStore } from 'pinia';
import { ref } from 'vue';
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth } from '@/lib/sidebar-layout';
import type { WorkspaceLayoutV1 } from './types';

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutV1 = Object.freeze({
  version: 1,
  sidebar: Object.freeze({ width: SIDEBAR_WIDTH_DEFAULT, collapsed: false }),
});

/** The only reactive owner of workspace-scoped layout metadata. */
export const useWorkspaceUiStore = defineStore('workspace-ui', () => {
  const sidebarWidth = ref(DEFAULT_WORKSPACE_LAYOUT.sidebar.width);
  const sidebarCollapsed = ref(DEFAULT_WORKSPACE_LAYOUT.sidebar.collapsed);
  const listeners = new Set<(layout: WorkspaceLayoutV1) => void>();

  function snapshot(): WorkspaceLayoutV1 {
    return Object.freeze({
      version: 1,
      sidebar: Object.freeze({
        width: clampSidebarWidth(sidebarWidth.value),
        collapsed: sidebarCollapsed.value,
      }),
    });
  }

  function apply(layout: WorkspaceLayoutV1): void {
    sidebarWidth.value = clampSidebarWidth(layout.sidebar.width);
    sidebarCollapsed.value = layout.sidebar.collapsed;
  }

  function setSidebarWidth(width: number): void {
    const next = clampSidebarWidth(width);
    if (next === sidebarWidth.value) return;
    sidebarWidth.value = next;
    notify();
  }

  function toggleSidebarCollapsed(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    notify();
  }

  function subscribe(listener: (layout: WorkspaceLayoutV1) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify(): void {
    const layout = snapshot();
    for (const listener of listeners) {
      try {
        listener(layout);
      } catch {
        // UI observers cannot alter the workspace layout authority.
      }
    }
  }

  return {
    sidebarWidth,
    sidebarCollapsed,
    snapshot,
    apply,
    setSidebarWidth,
    toggleSidebarCollapsed,
    subscribe,
  };
});
