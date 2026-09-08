<template>
  <div class="app-layout">
    <AppSidebar
      :collapsed="workspaceUi.sidebarCollapsed"
      :width="workspaceUi.sidebarWidth"
      :ai-window-visible="aiWindowVisible"
      @toggle="workspaceUi.toggleSidebarCollapsed"
      @resize="workspaceUi.setSidebarWidth"
      @toggle-ai="toggleAiWindow"
      @settings="showSettings = true"
    />

    <main class="main">
      <div
        v-if="mutationPolicy.persistenceReadOnly.value"
        class="persistence-readonly-banner"
        role="status"
        aria-live="polite"
      >
        <strong>{{ t('persistence.readOnly.title') }}</strong>
        <span>{{ t('persistence.readOnly.description') }}</span>
      </div>
      <SessionTabs @create="requestCreateSession" />
      <div class="session-viewport">
        <WorkspaceWelcome
          v-if="sessions.length === 0"
          :can-create="mutationPolicy.userMutationsAllowed.value"
          @create="requestCreateSession()"
        />
        <SessionRuntimeHost
          v-show="sessions.length > 0"
          :sessions="sessions"
          :active-session-id="activeSession?.id ?? null"
          @active-raw-data="activeRawData = $event"
        />
      </div>
      <StatusBar :session="activeSession" :raw-data="activeRawData" />
    </main>

    <CreateSessionDialog v-model:show="showCreateDialog" :preferred-port="preferredCreatePort" />
    <SettingsModal v-model:show="showSettings" />
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onErrorCaptured,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
} from 'vue';
import { useMessage } from 'naive-ui';
import SessionTabs from '@/features/sessions/ui/SessionTabs.vue';
import StatusBar from '@/features/app-shell/ui/StatusBar.vue';
import AppSidebar from './AppSidebar.vue';
import WorkspaceWelcome from './WorkspaceWelcome.vue';
import SessionRuntimeHost from '@/features/sessions/ui/SessionRuntimeHost.vue';
import { useAiWindowState } from '@/features/ai/application/use-ai-window-state';
import { useAppShortcuts } from '@/features/app-shell/application/use-app-shortcuts';
import { useSessionActions } from '@/features/sessions/application/use-session-actions';
import { useWorkspaceUiStore } from '@/features/workspace';
import {
  useSessionCatalog,
  useSessionMutationPolicy,
  type SessionRawDataView,
} from '@/features/sessions';
import { AUTO_LOG_FAILURE_EVENT } from '@/features/sessions/application/use-auto-log';
import { t } from '@/lib/i18n';

// Code-split the heavy modals/panels so their naive-ui dependencies (NModal,
// NForm, NFormItem) are fetched on first open, not at first paint. Together
// these trim a meaningful slice off the eager bundle; the main window renders
// with SessionView/StatusBar only.
const CreateSessionDialog = defineAsyncComponent(() => import('./CreateSessionDialog.vue'));
const SettingsModal = defineAsyncComponent(() => import('./SettingsModal.vue'));

const catalog = useSessionCatalog();
const mutationPolicy = useSessionMutationPolicy();
const workspaceUi = useWorkspaceUiStore();
const { requestCloseSession } = useSessionActions();
const { visible: aiWindowVisible, toggle: toggleAiWindow } = useAiWindowState();

const sessions = computed(() => catalog.sessions.value);
const activeSession = computed(() => catalog.activeSession.value);
const activeRawData = shallowRef<SessionRawDataView | null>(null);
const showCreateDialog = ref(false);
const preferredCreatePort = ref('');
const showSettings = ref(false);
const message = useMessage();

function requestCreateSession(preferredPort = ''): void {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  preferredCreatePort.value = preferredPort;
  showCreateDialog.value = true;
}

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

onUnmounted(() => {
  window.removeEventListener(AUTO_LOG_FAILURE_EVENT, onAutoLogFailure);
});

useAppShortcuts({
  onCreateSession: () => {
    requestCreateSession();
  },
  onCloseSession: () => {
    const id = catalog.activeSessionId.value;
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

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  min-width: 0;
  margin: 8px 8px 8px 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
}

.persistence-readonly-banner {
  display: flex;
  flex-wrap: wrap;
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
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
</style>
