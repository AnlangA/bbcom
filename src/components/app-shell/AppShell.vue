<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ collapsed: appStore.sidebarCollapsed }" :style="sidebarStyle">
      <div class="sidebar-header">
        <div class="app-brand">
          <button class="collapse-btn" type="button" @click="appStore.toggleSidebarCollapsed" :title="appStore.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'">
            <PanelLeftClose v-if="!appStore.sidebarCollapsed" class="icon" />
            <PanelLeftOpen v-else class="icon" />
          </button>
          <span class="brand-mark">
            <Zap class="icon-lg" />
          </span>
          <span v-if="!appStore.sidebarCollapsed" class="brand-copy">
            <span class="brand-title">bbcom</span>
            <span class="brand-subtitle">Serial console</span>
          </span>
        </div>
        <div class="sidebar-actions">
          <n-button
            v-if="!appStore.sidebarCollapsed"
            size="tiny"
            :type="aiWindowVisible ? 'primary' : 'default'"
            secondary
            class="ai-toggle"
            :title="aiWindowVisible ? '关闭 AI' : '开启 AI'"
            :aria-label="aiWindowVisible ? '关闭 AI' : '开启 AI'"
            @click="toggleAiWindow"
          >
            <template #icon>
              <Bot v-if="aiWindowVisible" class="icon-sm" />
              <BotOff v-else class="icon-sm" />
            </template>
            <span class="action-label">{{ aiWindowVisible ? '关闭 AI' : '开启 AI' }}</span>
          </n-button>
          <n-button
            size="tiny"
            quaternary
            class="settings-toggle"
            title="设置"
            aria-label="设置"
            @click="showSettings = true"
          >
            <template #icon>
              <Settings class="icon-sm" />
            </template>
          </n-button>
        </div>
      </div>
      <template v-if="!appStore.sidebarCollapsed">
        <AiSettingsPanel v-if="aiWindowVisible" />
        <div class="sidebar-content">
          <PortSelector />
    </aside>

    <div
      class="resize-handle"
      :class="{ dragging: isDragging }"
      @mousedown="startResize"
    ></div>

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
        <Transition name="fade-slide" mode="out-in">
          <SessionView v-if="activeSession" :key="activeSession.id" :session="activeSession" />
        </Transition>
      </div>
      <StatusBar :session="activeSession" />
    </main>

    <CreateSessionDialog v-model:show="showCreateDialog" />
    <SettingsModal v-model:show="showSettings" />
  </div>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, onUnmounted, ref } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import { Bot, BotOff, Cable, PanelLeftClose, PanelLeftOpen, Settings, Zap } from 'lucide-vue-next';
import PortSelector from '../port-selector/PortSelector.vue';
import SessionTabs from '../session-tabs/SessionTabs.vue';
import SessionView from '../session/SessionView.vue';
import StatusBar from '../status-bar/StatusBar.vue';
import CreateSessionDialog from './CreateSessionDialog.vue';
import SettingsModal from './SettingsModal.vue';
import AiSettingsPanel from '../ai/AiSettingsPanel.vue';
import { useAiWindowState } from '../../composables/useAiWindowState';
import { useAppShortcuts } from '../../composables/useAppShortcuts';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestCloseSession } = useSessionActions();
const { visible: aiWindowVisible, toggle: toggleAiWindow } = useAiWindowState();

const sessions = computed(() => sessionStore.sessions);
const activeSession = computed(() => sessionStore.activeSession);
const showCreateDialog = ref(false);
const showSettings = ref(false);
const message = useMessage();

onErrorCaptured((err) => {
  // Surface component render errors with a toast instead of a silent blank
  // screen — critical for a desktop debugging tool where a blank window looks
  // like a hang.
  // eslint-disable-next-line no-console
  console.error('[bbcom] component error:', err);
  message.error(`界面渲染出错：${err instanceof Error ? err.message : String(err)}`);
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
  padding: 12px 7px;
  justify-content: center;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.sidebar.collapsed .app-brand {
  flex-direction: column;
  gap: 0;
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
  transition: transform var(--transition-normal);
}

.brand-mark:hover {
  transform: rotate(12deg);
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

.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  transition: background var(--transition-fast);
}

.resize-handle:hover,
.resize-handle.dragging {
  background: var(--color-primary);
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
  animation: fade-in 300ms ease, slide-up 300ms ease;
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

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (max-width: 760px) {
  .sidebar {
    max-width: 252px;
  }

  .brand-copy {
    display: none;
  }
}
</style>
