<template>
  <div class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="app-brand">
          <span class="brand-icon">⚡</span>
          <span class="brand-title">bbcom</span>
        </div>
        <n-button
          size="tiny"
          :type="aiWindowVisible ? 'primary' : 'default'"
          secondary
          @click="toggleAiWindow"
        >
          {{ aiWindowVisible ? '关闭 AI' : '开启 AI' }}
        </n-button>
      </div>
      <AiSettingsPanel />
      <div class="sidebar-content">
        <PortSelector />
      </div>
    </aside>

    <main class="main">
      <SessionTabs @create="showCreateDialog = true" />
      <div class="session-viewport">
        <div v-if="sessions.length === 0" class="empty-state">
          <div class="empty-icon">🔌</div>
          <div class="empty-title">bbcom</div>
          <div class="empty-text">在左侧选择串口并点击「新建会话」开始调试</div>
          <div class="empty-shortcuts">
            <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>N</kbd> 新建会话</span>
            <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>W</kbd> 关闭会话</span>
          </div>
        </div>
        <SessionView
          v-if="activeSession"
          :key="activeSession.id"
          :session="activeSession"
        />
      </div>
      <StatusBar :session="activeSession" />
    </main>

    <CreateSessionDialog v-model:show="showCreateDialog" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import PortSelector from '../port-selector/PortSelector.vue';
import SessionTabs from '../session-tabs/SessionTabs.vue';
import SessionView from '../session/SessionView.vue';
import StatusBar from '../status-bar/StatusBar.vue';
import CreateSessionDialog from './CreateSessionDialog.vue';
import AiSettingsPanel from '../ai/AiSettingsPanel.vue';
import { useAiWindowState } from '../../composables/useAiWindowState';
import { useAppShortcuts } from '../../composables/useAppShortcuts';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionStore } from '../../stores/sessions';

const sessionStore = useSessionStore();
const { requestCloseSession } = useSessionActions();
const { visible: aiWindowVisible, toggle: toggleAiWindow } = useAiWindowState();

const sessions = computed(() => sessionStore.sessions);
const activeSession = computed(() => sessionStore.activeSession);
const showCreateDialog = ref(false);

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
  background: var(--bg-primary);
}

.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width-min);
  max-width: var(--sidebar-width-max);
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.brand-icon {
  font-size: 20px;
  line-height: 1;
}

.brand-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-bold);
  color: transparent;
  background: linear-gradient(135deg, #63ffb1 0%, #4fc3ff 55%, #b388ff 100%);
  background-clip: text;
  -webkit-background-clip: text;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  min-width: 0;
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
  gap: var(--space-lg);
  color: var(--text-muted);
  user-select: none;
  padding: var(--space-xl);
  text-align: center;
}

.empty-icon {
  font-size: 56px;
  opacity: 0.3;
  filter: grayscale(0.5);
}

.empty-title {
  font-size: var(--font-size-xl);
  color: transparent;
  background: linear-gradient(135deg, #63ffb1 0%, #4fc3ff 55%, #b388ff 100%);
  background-clip: text;
  -webkit-background-clip: text;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.3px;
}

.empty-text {
  font-size: var(--font-size-base);
  color: var(--text-muted);
}

.empty-shortcuts {
  margin-top: var(--space-lg);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-xl);
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
    width: 240px;
    min-width: 220px;
  }

  .brand-title {
    display: none;
  }
}
</style>
