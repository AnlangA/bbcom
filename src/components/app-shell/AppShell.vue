<template>
  <div class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="app-brand">
          <span class="brand-mark">
            <Zap class="icon-lg" />
          </span>
          <span class="brand-copy">
            <span class="brand-title">bbcom</span>
            <span class="brand-subtitle">Serial console</span>
          </span>
        </div>
        <n-button
          size="tiny"
          :type="aiWindowVisible ? 'primary' : 'default'"
          secondary
          class="ai-toggle"
          @click="toggleAiWindow"
        >
          <template #icon>
            <Bot v-if="aiWindowVisible" class="icon-sm" />
            <BotOff v-else class="icon-sm" />
          </template>
          {{ aiWindowVisible ? '关闭 AI' : '开启 AI' }}
        </n-button>
      </div>
      <AiSettingsPanel v-if="aiWindowVisible" />
      <div class="sidebar-content">
        <PortSelector />
      </div>
    </aside>

    <main class="main">
      <SessionTabs @create="showCreateDialog = true" />
      <div class="session-viewport">
        <div v-if="sessions.length === 0" class="empty-state">
          <div class="empty-mark">
            <Cable class="icon-lg" />
          </div>
          <div class="empty-title">bbcom</div>
          <div class="empty-text">在左侧选择串口并点击「新建会话」开始调试</div>
          <div class="empty-shortcuts">
            <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>N</kbd> 新建会话</span>
            <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>W</kbd> 关闭会话</span>
          </div>
        </div>
        <SessionView v-if="activeSession" :key="activeSession.id" :session="activeSession" />
      </div>
      <StatusBar :session="activeSession" />
    </main>

    <CreateSessionDialog v-model:show="showCreateDialog" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import { Bot, BotOff, Cable, Zap } from 'lucide-vue-next';
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
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 160px), var(--bg-app);
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
  box-shadow: var(--shadow-inset);
}

.sidebar-header {
  min-height: 58px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent), var(--bg-secondary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.brand-mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: var(--color-primary);
  background: var(--color-primary-subtle);
  border: 1px solid var(--color-primary-muted);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-inset);
}

.brand-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.brand-title {
  font-size: 15px;
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  line-height: var(--line-height-tight);
  white-space: nowrap;
}

.brand-subtitle {
  color: var(--text-dim);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
  text-transform: uppercase;
}

.ai-toggle {
  flex-shrink: 0;
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
  gap: var(--space-md);
  color: var(--text-muted);
  user-select: none;
  padding: var(--space-xl);
  text-align: center;
}

.empty-mark {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  color: var(--color-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-inset);
}

.empty-title {
  font-size: var(--font-size-xl);
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
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
    width: 252px;
    min-width: 232px;
  }

  .brand-copy {
    display: none;
  }
}
</style>
