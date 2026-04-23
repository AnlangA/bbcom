<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <n-message-provider>
      <div class="app-layout">
        <div class="sidebar">
          <div class="sidebar-header">
            <div class="app-brand">
              <span class="brand-icon">⚡</span>
              <span class="brand-title">串口调试助手</span>
            </div>
          </div>
          <div class="sidebar-content">
            <PortSelector />
          </div>
        </div>
        <div class="main">
          <SessionTabs @create="showCreateDialog = true" />
          <div class="session-viewport">
            <div v-if="sessions.length === 0" class="empty-state">
              <div class="empty-icon">🔌</div>
              <div class="empty-title">串口调试助手</div>
              <div class="empty-text">在左侧选择串口并点击「新建会话」开始调试</div>
              <div class="empty-shortcuts">
                <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>N</kbd> 新建会话</span>
                <span class="shortcut"><kbd>Ctrl</kbd>+<kbd>W</kbd> 关闭会话</span>
              </div>
            </div>
            <SessionView
              v-for="s in sessions"
              :key="s.id"
              :session="s"
              :style="{ display: s.id === activeSessionId ? 'flex' : 'none' }"
            />
          </div>
          <StatusBar :session="activeSession" />
        </div>
      </div>

      <n-modal v-model:show="showCreateDialog" preset="dialog" title="新建会话 (Ctrl+N)" positive-text="确定" negative-text="取消"
        @positive-click="createSession" @negative-click="showCreateDialog = false">
        <n-form label-placement="left" label-width="60">
          <n-form-item label="串口">
            <n-select v-model:value="newPortName" :options="portOptions" placeholder="选择可用串口" />
          </n-form-item>
          <n-form-item label="波特率">
            <n-select v-model:value="newBaudRate" :options="baudRateOptions" />
          </n-form-item>
        </n-form>
      </n-modal>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  darkTheme,
  NConfigProvider,
  NMessageProvider,
  NModal,
  NForm,
  NFormItem,
  NSelect,
} from 'naive-ui';
import PortSelector from './components/port-selector/PortSelector.vue';
import SessionTabs from './components/session-tabs/SessionTabs.vue';
import SessionView from './components/session/SessionView.vue';
import StatusBar from './components/status-bar/StatusBar.vue';
import { useSessionStore } from './stores/sessions';
import { useSerialStore } from './stores/serial';
import { BAUD_RATES } from './lib/constants';
import type { PortConfig } from './types';

const sessionStore = useSessionStore();
const serialStore = useSerialStore();

const sessions = computed(() => sessionStore.sessions);
const activeSessionId = computed(() => sessionStore.activeSessionId);
const activeSession = computed(() => sessionStore.activeSession);
const showCreateDialog = ref(false);
const newPortName = ref('');
const newBaudRate = ref(115200);

const usedPorts = computed(() =>
  new Set(sessionStore.sessions.filter((s) => s.isConnected).map((s) => s.portName))
);

const portOptions = computed(() =>
  serialStore.availablePorts.map((p) => ({
    label: usedPorts.value.has(p) ? `${p} (使用中)` : p,
    value: p,
    disabled: usedPorts.value.has(p),
  }))
);

const baudRateOptions = BAUD_RATES;

const themeOverrides = {
  common: {
    primaryColor: '#4caf50',
    primaryColorHover: '#66bb6a',
    primaryColorPressed: '#388e3c',
    borderRadius: '4px',
  },
};

function createSession() {
  if (!newPortName.value) return false;
  const config: PortConfig = { ...serialStore.portConfig, baudRate: newBaudRate.value };
  sessionStore.createSession(newPortName.value, config);
  newPortName.value = '';
  newBaudRate.value = 115200;
  return true;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'n') {
      e.preventDefault();
      showCreateDialog.value = true;
    } else if (e.key === 'w') {
      e.preventDefault();
      const id = sessionStore.activeSessionId;
      if (id) sessionStore.removeSession(id);
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<style scoped>
.app-layout {
  width: 100vw;
  height: 100vh;
  display: flex;
}

.sidebar {
  width: 300px;
  border-right: 1px solid #3c3c3c;
  background: #252526;
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 12px 16px;
  border-bottom: 1px solid #3c3c3c;
  background: #2a2a2a;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-icon {
  font-size: 18px;
}

.brand-title {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
  letter-spacing: 0.5px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #1e1e1e;
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
  gap: 12px;
  color: #666;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.4;
}

.empty-title {
  font-size: 16px;
  color: #888;
  font-weight: 500;
}

.empty-text {
  font-size: 13px;
}

.empty-shortcuts {
  margin-top: 12px;
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: #555;
}

.shortcut kbd {
  display: inline-block;
  padding: 1px 5px;
  background: #333;
  border: 1px solid #444;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: #aaa;
}
</style>
