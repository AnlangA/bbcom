<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <div class="app-brand">
          <div class="brand-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M13 2L4.09 12.97a.5.5 0 00.39.81H11l-1 8.22a.31.31 0 00.55.22L19.91 11a.5.5 0 00-.39-.81H13l1-8.18z"
                fill="url(#brand-grad)" stroke="url(#brand-grad)" stroke-width="0.5" stroke-linejoin="round"/>
              <defs>
                <linearGradient id="brand-grad" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#63ffb1"/>
                  <stop offset="0.55" stop-color="#4fc3ff"/>
                  <stop offset="1" stop-color="#b388ff"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <span v-if="!sidebarCollapsed" class="brand-title">bbcom</span>
        </div>
        <div v-if="!sidebarCollapsed" class="header-actions">
          <n-button
            size="tiny"
            :type="aiWindowVisible ? 'primary' : 'default'"
            secondary
            @click="toggleAiWindow"
            title="AI 助手"
          >
            <template #icon>
              <n-icon size="14"><SparklesIcon /></n-icon>
            </template>
            AI
          </n-button>
          <n-button size="tiny" quaternary @click="sidebarCollapsed = true" title="收起侧栏">
            <template #icon>
              <n-icon size="14"><ChevronBackIcon /></n-icon>
            </template>
          </n-button>
        </div>
      </div>
      <template v-if="!sidebarCollapsed">
        <AiSettingsPanel />
        <div class="sidebar-content">
          <PortSelector />
        </div>
      </template>
      <div v-else class="sidebar-collapsed-rail">
        <n-button size="tiny" quaternary circle @click="toggleAiWindow" :type="aiWindowVisible ? 'primary' : 'default'" title="AI 助手">
          <template #icon>
            <n-icon size="16"><SparklesIcon /></n-icon>
          </template>
        </n-button>
        <n-button size="tiny" quaternary circle @click="sidebarCollapsed = false" title="展开侧栏">
          <template #icon>
            <n-icon size="16"><ChevronForwardIcon /></n-icon>
          </template>
        </n-button>
      </div>
    </aside>

    <main class="main">
      <SessionTabs @create="showCreateDialog = true" />
      <div class="session-viewport">
        <div v-if="sessions.length === 0" class="empty-state">
          <div class="empty-icon-wrap">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              <rect x="12" y="20" width="40" height="28" rx="4" stroke="url(#empty-grad)" stroke-width="2" opacity="0.5"/>
              <path d="M20 28h24M20 34h18M20 40h12" stroke="url(#empty-grad)" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/>
              <circle cx="50" cy="18" r="7" fill="#1a1a1d" stroke="url(#empty-grad)" stroke-width="2"/>
              <path d="M47.5 18l2 2 3.5-4" stroke="url(#empty-grad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <defs>
                <linearGradient id="empty-grad" x1="12" y1="18" x2="52" y2="52">
                  <stop stop-color="#63ffb1"/>
                  <stop offset="0.55" stop-color="#4fc3ff"/>
                  <stop offset="1" stop-color="#b388ff"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
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
import { NButton, NIcon } from 'naive-ui';
import { Sparkles as SparklesIcon, ChevronBack as ChevronBackIcon, ChevronForward as ChevronForwardIcon } from '@vicons/ionicons5';
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
const sidebarCollapsed = ref(false);

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
  transition: width var(--transition-slow), min-width var(--transition-slow);
}

.sidebar.collapsed {
  width: 48px;
  min-width: 48px;
}

.sidebar-header {
  padding: 12px 14px;
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
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  filter: drop-shadow(0 0 6px rgba(99, 255, 177, 0.25));
}

.brand-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-bold);
  color: transparent;
  background: var(--gradient-brand);
  background-clip: text;
  -webkit-background-clip: text;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.sidebar-collapsed-rail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
  padding-top: var(--space-md);
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
  animation: fade-in var(--transition-slow);
}

.empty-icon-wrap {
  position: relative;
  margin-bottom: var(--space-xs);
}

.empty-icon-wrap::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  background: var(--gradient-brand-subtle);
  filter: blur(20px);
  z-index: -1;
}

.empty-title {
  font-size: 28px;
  color: transparent;
  background: var(--gradient-brand);
  background-clip: text;
  -webkit-background-clip: text;
  font-weight: var(--font-weight-bold);
  letter-spacing: 1px;
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
  box-shadow: 0 1px 0 var(--border-subtle);
}

@media (max-width: 760px) {
  .sidebar:not(.collapsed) {
    width: 240px;
    min-width: 220px;
  }

  .brand-title {
    display: none;
  }
}
</style>
