import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_LAYOUT, useWorkspaceUiStore } from '../../src/features/workspace';

describe('WorkspaceUiStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts from the workspace default and applies hydration without emitting a write', () => {
    const store = useWorkspaceUiStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.snapshot()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    store.apply({ version: 1, sidebar: { width: 320, collapsed: true } });
    expect(store.snapshot().sidebar).toEqual({ width: 320, collapsed: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits exactly one metadata mutation per effective UI change', () => {
    const store = useWorkspaceUiStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSidebarWidth(310);
    store.setSidebarWidth(310);
    store.toggleSidebarCollapsed();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
