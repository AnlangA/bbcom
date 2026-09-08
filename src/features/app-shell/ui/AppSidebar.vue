<template>
  <aside
    class="sidebar"
    :class="{ collapsed, dragging: isDragging }"
    :style="sidebarStyle"
    :aria-label="t('app.name')"
  >
    <div class="sidebar-header">
      <div class="app-brand">
        <button
          class="collapse-btn"
          type="button"
          @click="emit('toggle')"
          :title="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          :aria-label="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          :aria-expanded="!collapsed"
          aria-controls="app-sidebar-body"
        >
          <PanelLeftClose v-if="!collapsed" class="icon" />
          <PanelLeftOpen v-else class="icon" />
        </button>
        <div v-if="!collapsed" class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">
            <Cable class="brand-mark-icon" />
          </span>
          <span class="brand-name">bbcom</span>
        </div>
      </div>
      <div class="sidebar-actions">
        <n-button
          v-if="!collapsed"
          size="tiny"
          :type="aiWindowVisible ? 'primary' : 'default'"
          secondary
          class="ai-toggle"
          :title="aiWindowVisible ? t('sidebar.ai.on') : t('sidebar.ai.off')"
          :aria-label="aiWindowVisible ? t('sidebar.ai.on') : t('sidebar.ai.off')"
          :aria-pressed="aiWindowVisible"
          @click="emit('toggleAi')"
        >
          <template #icon>
            <Bot v-if="aiWindowVisible" class="icon-sm" />
            <BotOff v-else class="icon-sm" />
          </template>
        </n-button>
        <n-button
          size="tiny"
          quaternary
          class="settings-toggle"
          :title="t('sidebar.settings')"
          :aria-label="t('sidebar.settings')"
          @click="emit('settings')"
        >
          <template #icon>
            <Settings class="icon-sm" />
          </template>
        </n-button>
      </div>
    </div>
    <div
      id="app-sidebar-body"
      class="sidebar-body"
      :class="{ hidden: collapsed }"
      :aria-hidden="collapsed"
      :inert="collapsed ? true : undefined"
    >
      <AiSettingsPanel v-if="aiWindowVisible" compact />
      <WorkspacePanel />
    </div>
  </aside>

  <div
    class="resize-handle"
    :class="{ dragging: isDragging, disabled: collapsed }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="t('sidebar.resize')"
    :aria-valuemin="SIDEBAR_WIDTH_MIN"
    :aria-valuemax="SIDEBAR_WIDTH_MAX"
    :aria-valuenow="width"
    :aria-disabled="collapsed"
    :tabindex="collapsed ? -1 : 0"
    @mousedown="startResize"
    @keydown="onResizeKeydown"
  ></div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';
import { NButton } from 'naive-ui';
import { Bot, BotOff, Cable, PanelLeftClose, PanelLeftOpen, Settings } from '@lucide/vue';
import WorkspacePanel from '@/features/workspace/ui/WorkspacePanel.vue';
import { t } from '@/lib/i18n';
import { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '@/lib/sidebar-layout';
import { useSidebarResize } from '../application/use-sidebar-resize';

const props = defineProps<{ collapsed: boolean; width: number; aiWindowVisible: boolean }>();
const emit = defineEmits<{ toggle: []; toggleAi: []; settings: []; resize: [width: number] }>();
const AiSettingsPanel = defineAsyncComponent(() => import('@/features/ai/ui/AiSettingsPanel.vue'));
const sidebarStyle = computed(() => ({ width: props.collapsed ? '48px' : props.width + 'px' }));
const { isDragging, startResize, onResizeKeydown } = useSidebarResize({
  width: () => props.width,
  collapsed: () => props.collapsed,
  onResize: (width) => emit('resize', width),
});
</script>

<style scoped>
.sidebar {
  flex: 0 0 auto;
  min-width: 48px;
  max-width: var(--sidebar-width-max);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-inset);
  transition: width var(--transition-slow);
}

.sidebar.dragging {
  transition: none;
}

.sidebar.collapsed {
  min-width: 48px;
  max-width: 48px;
}

.sidebar-header {
  min-height: 58px;
  padding: 12px 12px 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--edge-highlight), transparent), var(--bg-secondary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.sidebar.collapsed .sidebar-header {
  /* When collapsed the brand + toolbar stack vertically; allow the header to
     grow with its contents instead of clipping the stacked action buttons
     (the sidebar has overflow:hidden, so a fixed min-height would crop them). */
  min-height: 0;
  padding: 10px 7px;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  overflow-y: auto;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  /* The brand is the flexible side of the header: it shrinks first so the
     fixed-width action buttons on the right can never be squeezed into
     overlapping it. */
  flex: 1 1 auto;
}

.sidebar.collapsed .app-brand {
  flex-direction: column;
  gap: 6px;
  flex: 0 0 auto;
}

.collapse-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.collapse-btn:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  user-select: none;
}

.brand-mark {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: var(--color-primary);
  background:
    linear-gradient(160deg, var(--color-primary-subtle), transparent 140%), var(--bg-elevated);
  border: 1px solid var(--color-primary-muted);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

.brand-mark-icon {
  width: 14px;
  height: 14px;
  stroke-width: 2;
}

.brand-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.2px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar.collapsed .collapse-btn {
  width: 34px;
  height: 34px;
}

.ai-toggle {
  flex-shrink: 0;
}

.sidebar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* Pin the action cluster: these icon buttons are fixed-size and must never
     be flex-compressed, otherwise they collide/overlap the brand on narrow
     sidebar widths (the sidebar can be as little as 252px wide). */
  flex: 0 0 auto;
  gap: 4px;
}

.sidebar.collapsed .sidebar-actions {
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  width: 100%;
}

/* In the collapsed rail, give the icon-only toggles a consistent square hit
   target and keep them visually centered. */
.sidebar.collapsed .sidebar-actions :deep(.n-button) {
  --n-size-tiny: 30px;
}

/* Wraps the sidebar body so the whole lower region fades/slides
   out together with the width animation when collapsing, instead of being
   yanked by v-if mid-transition (which flashed empty space). */
.sidebar-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    opacity var(--transition-normal),
    transform var(--transition-normal);
}

.sidebar-body.hidden {
  opacity: 0;
  transform: translateX(-6px);
  pointer-events: none;
}

.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  transition:
    background var(--transition-fast),
    opacity var(--transition-fast),
    width var(--transition-slow);
}

.resize-handle:hover,
.resize-handle.dragging,
.resize-handle:focus-visible {
  background: var(--color-primary);
}

.resize-handle:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

/* When the sidebar is collapsed the handle is inert and visually removed so
   it neither steals pointer events nor shows a misleading resize cursor. */
.resize-handle.disabled {
  width: 0;
  cursor: default;
  pointer-events: none;
  opacity: 0;
}
</style>
