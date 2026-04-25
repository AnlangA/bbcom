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
            <n-button
              size="tiny"
              :type="aiWindowVisible ? 'primary' : 'default'"
              secondary
              @click="toggleAiWindow"
            >
              {{ aiWindowVisible ? '关闭 AI' : '开启 AI' }}
            </n-button>
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
              v-if="activeSession"
              :key="activeSession.id"
              :session="activeSession"
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
          <n-form-item label="数据位">
            <n-select v-model:value="newDataBits" :options="dataBitsOptions" />
          </n-form-item>
          <n-form-item label="停止位">
            <n-select v-model:value="newStopBits" :options="stopBitsOptions" />
          </n-form-item>
          <n-form-item label="校验位">
            <n-select v-model:value="newParity" :options="parityOptions" />
          </n-form-item>
          <n-form-item label="流控">
            <n-select v-model:value="newFlowControl" :options="flowControlOptions" />
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
  NButton,
  NSelect,
} from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import PortSelector from './components/port-selector/PortSelector.vue';
import SessionTabs from './components/session-tabs/SessionTabs.vue';
import SessionView from './components/session/SessionView.vue';
import StatusBar from './components/status-bar/StatusBar.vue';
import { useSessionStore } from './stores/sessions';
import { useSerialStore } from './stores/serial';
import { useSessionActions } from './composables/useSessionActions';
import { BAUD_RATES, DATA_BITS_OPTIONS, FLOW_CONTROL_OPTIONS, PARITY_OPTIONS, STOP_BITS_OPTIONS } from './lib/constants';
import type { PortConfig } from './types';

const sessionStore = useSessionStore();
const serialStore = useSerialStore();
const { createSession: createSessionFromConfig, requestCloseSession } = useSessionActions();

const sessions = computed(() => sessionStore.sessions);
const activeSession = computed(() => sessionStore.activeSession);
const showCreateDialog = ref(false);
const newPortName = ref('');
const newBaudRate = ref(115200);
const newDataBits = ref<PortConfig['dataBits']>(8);
const newStopBits = ref<PortConfig['stopBits']>(1);
const newParity = ref<PortConfig['parity']>('none');
const newFlowControl = ref<PortConfig['flowControl']>('none');
const aiWindowVisible = ref(false);
let unlistenAiWindowState: (() => void) | null = null;

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
const dataBitsOptions = DATA_BITS_OPTIONS;
const stopBitsOptions = STOP_BITS_OPTIONS;
const parityOptions = PARITY_OPTIONS;
const flowControlOptions = FLOW_CONTROL_OPTIONS;

const themeOverrides = {
  common: {
    primaryColor: '#4caf50',
    primaryColorHover: '#66bb6a',
    primaryColorPressed: '#388e3c',
    primaryColorSuppl: '#4caf50',
    borderRadius: '4px',
    borderRadiusSmall: '3px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono: '"Menlo", "Consolas", "Courier New", monospace',
    fontSize: '13px',
    fontSizeMini: '11px',
    fontSizeTiny: '11px',
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    heightSmall: '28px',
    heightMedium: '32px',
    dividerColor: '#2e2e2e',
    borderColor: '#3c3c3c',
    inputColor: '#1a1a1a',
    inputColorDisabled: '#252526',
    actionColor: '#252526',
    modalColor: '#2a2a2a',
    cardColor: '#252526',
    tableColor: '#1e1e1e',
    popoverColor: '#2a2a2a',
  },
  Button: {
    textColorPrimary: '#fff',
    textColorHoverPrimary: '#fff',
    textColorPressedPrimary: '#fff',
  },
  Input: {
    color: '#1a1a1a',
    colorFocus: '#1a1a1a',
    border: '1px solid #3c3c3c',
    borderHover: '#505050',
    borderFocus: '#4caf50',
    boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.15)',
  },
  Select: {
    peers: {
      InternalSelection: {
        color: '#1a1a1a',
        border: '1px solid #3c3c3c',
        borderHover: '#505050',
        borderFocus: '#4caf50',
        boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.15)',
      },
    },
  },
  Tag: {
    border: '1px solid #3c3c3c',
    borderRadiusSmall: '3px',
  },
  Modal: {
    color: '#2a2a2a',
    borderColor: '#3c3c3c',
  },
};

function createSession() {
  if (!newPortName.value) return false;
  const config: PortConfig = {
    baudRate: newBaudRate.value,
    dataBits: newDataBits.value,
    stopBits: newStopBits.value,
    parity: newParity.value,
    flowControl: newFlowControl.value,
  };
  serialStore.setPortConfig(config);
  createSessionFromConfig(newPortName.value, config);
  newPortName.value = '';
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
      if (id) {
        requestCloseSession(id);
      }
    }
  }
}

async function refreshAiWindowState() {
  try {
    const state = await invoke<{ visible: boolean }>('get_ai_window_state');
    aiWindowVisible.value = state.visible;
  } catch {
    aiWindowVisible.value = false;
  }
}

async function toggleAiWindow() {
  try {
    if (aiWindowVisible.value) {
      await invoke('hide_ai_window');
      aiWindowVisible.value = false;
    } else {
      await invoke('show_ai_window');
      aiWindowVisible.value = true;
    }
  } catch {
    // ignore
  }
}

onMounted(() => {
  newBaudRate.value = serialStore.portConfig.baudRate;
  newDataBits.value = serialStore.portConfig.dataBits;
  newStopBits.value = serialStore.portConfig.stopBits;
  newParity.value = serialStore.portConfig.parity;
  newFlowControl.value = serialStore.portConfig.flowControl;
  window.addEventListener('keydown', handleKeydown);
  refreshAiWindowState();
  listen<{ visible: boolean }>('ai-window-state', (event) => {
    aiWindowVisible.value = event.payload.visible;
  }).then((unlisten) => {
    unlistenAiWindowState = unlisten;
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  if (unlistenAiWindowState) {
    unlistenAiWindowState();
    unlistenAiWindowState = null;
  }
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
  width: 280px;
  min-width: 280px;
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
  gap: 8px;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-icon {
  font-size: 20px;
  line-height: 1;
}

.brand-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.5px;
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
  gap: 16px;
  color: var(--text-muted);
  user-select: none;
}

.empty-icon {
  font-size: 56px;
  opacity: 0.3;
  filter: grayscale(0.5);
}

.empty-title {
  font-size: 18px;
  color: var(--text-secondary);
  font-weight: 600;
  letter-spacing: 0.3px;
}

.empty-text {
  font-size: 13px;
  color: var(--text-muted);
}

.empty-shortcuts {
  margin-top: 16px;
  display: flex;
  gap: 20px;
  font-size: 11px;
  color: var(--text-dim);
}

.shortcut kbd {
  display: inline-block;
  padding: 2px 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  line-height: 1.4;
}

</style>
