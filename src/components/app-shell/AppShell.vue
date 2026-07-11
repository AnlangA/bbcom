<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ collapsed: appStore.sidebarCollapsed }" :style="sidebarStyle">
      <div class="sidebar-header">
        <div class="app-brand">
          <button
            class="collapse-btn"
            type="button"
            @click="appStore.toggleSidebarCollapsed"
            :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          >
            <PanelLeftClose v-if="!appStore.sidebarCollapsed" class="icon" />
            <PanelLeftOpen v-else class="icon" />
          </button>
        </div>
        <div class="sidebar-actions">
          <n-button
            v-if="!appStore.sidebarCollapsed"
            size="tiny"
            :type="aiWindowVisible ? 'primary' : 'default'"
            secondary
            class="ai-toggle"
            :title="aiWindowVisible ? t('sidebar.ai.on') : t('sidebar.ai.off')"
            :aria-label="aiWindowVisible ? t('sidebar.ai.on') : t('sidebar.ai.off')"
            @click="toggleAiWindow"
          >
            <template #icon>
              <Bot v-if="aiWindowVisible" class="icon-sm" />
              <BotOff v-else class="icon-sm" />
            </template>
          </n-button>
          <n-button
            size="tiny"
            quaternary
            class="locale-toggle"
            :title="
              appStore.locale === 'zh'
                ? t('sidebar.locale.toEnglish')
                : t('sidebar.locale.toChinese')
            "
            :aria-label="
              appStore.locale === 'zh'
                ? t('sidebar.locale.toEnglish')
                : t('sidebar.locale.toChinese')
            "
            @click="toggleLocale"
          >
            <template #icon>
              <Languages class="icon-sm" />
            </template>
          </n-button>
          <n-button
            size="tiny"
            quaternary
            class="theme-toggle"
            :title="appStore.theme === 'light' ? t('sidebar.theme.light') : t('sidebar.theme.dark')"
            :aria-label="
              appStore.theme === 'light' ? t('sidebar.theme.light') : t('sidebar.theme.dark')
            "
            @click="toggleTheme"
          >
            <template #icon>
              <Moon v-if="appStore.theme === 'light'" class="icon-sm" />
              <Sun v-else class="icon-sm" />
            </template>
          </n-button>
          <n-button
            size="tiny"
            quaternary
            class="settings-toggle"
            :title="t('sidebar.settings')"
            :aria-label="t('sidebar.settings')"
            @click="showSettings = true"
          >
            <template #icon>
              <Settings class="icon-sm" />
            </template>
          </n-button>
        </div>
      </div>
      <div class="sidebar-body" :class="{ hidden: appStore.sidebarCollapsed }">
        <AiSettingsPanel v-if="aiWindowVisible" compact />
        <div class="sidebar-content">
          <PortSelector />
        </div>
      </div>
    </aside>

    <div
      class="resize-handle"
      :class="{ dragging: isDragging, disabled: appStore.sidebarCollapsed }"
      @mousedown="startResize"
    ></div>

    <main class="main">
      <div
        v-if="sessionStore.persistenceReadOnly"
        class="persistence-readonly-banner"
        role="status"
        aria-live="polite"
      >
        <strong>{{ t('persistence.readOnly.title') }}</strong>
        <span>{{ t('persistence.readOnly.description') }}</span>
      </div>
      <SessionTabs @create="showCreateDialog = true" />
      <div class="session-viewport">
        <div v-if="sessions.length === 0" class="empty-state">
          <div class="empty-mark">
            <Cable class="icon-lg" />
          </div>
          <div class="empty-title">{{ t('session.empty.title') }}</div>
          <div class="empty-text">{{ t('session.empty.hint') }}</div>
          <div class="empty-actions">
            <n-button type="primary" size="medium" @click="showCreateDialog = true">
              <template #icon>
                <Plus class="icon-sm" />
              </template>
              {{ t('common.newSession') }}
            </n-button>
          </div>
          <div class="empty-shortcuts">
            <span class="shortcut"
              ><kbd>Ctrl</kbd>+<kbd>N</kbd> {{ t('shortcut.newSession') }}</span
            >
            <span class="shortcut"
              ><kbd>Ctrl</kbd>+<kbd>W</kbd> {{ t('shortcut.closeSession') }}</span
            >
          </div>
        </div>
        <SessionRuntimeHost :sessions="sessions" :active-session-id="activeSession?.id ?? null" />
      </div>
      <StatusBar :session="activeSession" :frames-version="activeFramesVersion" />
    </main>

    <CreateSessionDialog v-model:show="showCreateDialog" />
    <SettingsModal v-model:show="showSettings" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onErrorCaptured, onMounted, onUnmounted, ref } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import {
  Bot,
  BotOff,
  Cable,
  Languages,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
} from '@lucide/vue';
import PortSelector from '../port-selector/PortSelector.vue';
import SessionTabs from '../session-tabs/SessionTabs.vue';
import StatusBar from '../status-bar/StatusBar.vue';
import { SessionRuntimeHost } from '../../features/sessions';
import { useAiWindowState } from '../../composables/useAiWindowState';
import { useAppShortcuts } from '../../composables/useAppShortcuts';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { AUTO_LOG_FAILURE_EVENT } from '../../composables/useAutoLog';
import { t, setLocale } from '../../lib/i18n';

// Code-split the heavy modals/panels so their naive-ui dependencies (NModal,
// NForm, NFormItem) are fetched on first open, not at first paint. Together
// these trim a meaningful slice off the eager bundle; the main window renders
// with PortSelector/SessionView/StatusBar only.
const CreateSessionDialog = defineAsyncComponent(() => import('./CreateSessionDialog.vue'));
const SettingsModal = defineAsyncComponent(() => import('./SettingsModal.vue'));
const AiSettingsPanel = defineAsyncComponent(() => import('../ai/AiSettingsPanel.vue'));

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestCloseSession } = useSessionActions();
const { visible: aiWindowVisible, toggle: toggleAiWindow } = useAiWindowState();

const sessions = computed(() => sessionStore.sessions);
const activeSession = computed(() => sessionStore.activeSession);
const activeFramesVersion = computed(() =>
  activeSession.value ? sessionStore.getSessionFramesVersion(activeSession.value.id) : 0,
);
const showCreateDialog = ref(false);
const showSettings = ref(false);
const message = useMessage();

function onAutoLogFailure(event: Event) {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return;
  const value = detail as { sessionId?: unknown; reason?: unknown };
  if (typeof value.sessionId !== 'string' || typeof value.reason !== 'string') return;
  message.error(t('message.autoLogFailed'));
}

onMounted(() => {
  window.addEventListener(AUTO_LOG_FAILURE_EVENT, onAutoLogFailure);
});

function toggleTheme() {
  appStore.setTheme(appStore.theme === 'light' ? 'dark' : 'light');
}

function toggleLocale() {
  setLocale(appStore.locale === 'zh' ? 'en' : 'zh');
}

onErrorCaptured((err) => {
  // Surface component render errors with a toast instead of a silent blank
  // screen — critical for a desktop debugging tool where a blank window looks
  // like a hang.
  // eslint-disable-next-line no-console
  console.error('[bbcom] component error:', err);
  message.error(
    t('message.componentError', { error: err instanceof Error ? err.message : String(err) }),
  );
  return false;
});

const isDragging = ref(false);
let startX = 0;
let startWidth = 0;

const sidebarStyle = computed(() => ({
  width: appStore.sidebarCollapsed ? '48px' : `${appStore.sidebarWidth}px`,
}));

function startResize(e: MouseEvent) {
  if (appStore.sidebarCollapsed) return;
  isDragging.value = true;
  startX = e.clientX;
  startWidth = appStore.sidebarWidth;
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResize(e: MouseEvent) {
  const delta = e.clientX - startX;
  appStore.setSidebarWidth(startWidth + delta);
}

function stopResize() {
  isDragging.value = false;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  window.removeEventListener(AUTO_LOG_FAILURE_EVENT, onAutoLogFailure);
});

useAppShortcuts({
  onCreateSession: () => {
    showCreateDialog.value = true;
  },
  onCloseSession: () => {
    const id = sessionStore.activeSessionId;
    if (id) requestCloseSession(id);
  },
});
</script>

<style scoped>
.app-layout {
  width: 100vw;
  height: 100vh;
  display: flex;
  background: linear-gradient(180deg, var(--edge-highlight), transparent 160px), var(--bg-app);
}

.sidebar {
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

.sidebar.collapsed {
  min-width: 48px;
  max-width: 48px;
}

.sidebar-header {
  min-height: 58px;
  padding: 12px 14px;
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

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Wraps AiSettingsPanel + PortSelector so the whole lower region fades/slides
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
.resize-handle.dragging {
  background: var(--color-primary);
}

/* When the sidebar is collapsed the handle is inert and visually removed so
   it neither steals pointer events nor shows a misleading resize cursor. */
.resize-handle.disabled {
  width: 0;
  cursor: default;
  pointer-events: none;
  opacity: 0;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  min-width: 0;
}

.persistence-readonly-banner {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  color: var(--accent-amber);
  background: var(--accent-amber-subtle);
  border-bottom: 1px solid var(--accent-amber-border);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  flex-shrink: 0;
}

.persistence-readonly-banner strong {
  white-space: nowrap;
}

.session-viewport {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  color: var(--text-muted);
  user-select: none;
  padding: var(--space-xl);
  text-align: center;
  animation:
    fade-in 300ms ease,
    slide-up 300ms ease;
}

.empty-mark {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  color: var(--color-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-inset);
  animation: scale-in 400ms ease;
}

.empty-title {
  font-size: var(--font-size-xl);
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
}

.empty-text {
  font-size: var(--font-size-base);
  color: var(--text-muted);
  max-width: 360px;
  line-height: var(--line-height-normal);
}

.empty-actions {
  display: flex;
  justify-content: center;
  margin-top: var(--space-xs);
}

.empty-shortcuts {
  margin-top: var(--space-lg);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-md);
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}

.shortcut kbd {
  display: inline-block;
  padding: 2px 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.4;
}

@media (max-width: 760px) {
  .sidebar {
    max-width: 252px;
  }
}
</style>
