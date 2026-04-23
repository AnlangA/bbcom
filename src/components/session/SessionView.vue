<template>
  <div class="session-view">
    <div class="session-toolbar">
      <div class="toolbar-left">
        <n-button
          v-if="!serialState.isConnected.value"
          type="primary"
          size="small"
          @click="connect"
          :loading="serialState.isConnecting.value"
        >
          连接
        </n-button>
        <n-button
          v-else
          type="error"
          size="small"
          ghost
          @click="disconnect"
        >
          断开
        </n-button>
        <n-button size="small" @click="clear" :disabled="session.frames.length === 0">
          清空
        </n-button>
        <n-tag :type="session.isConnected ? 'success' : 'default'" size="small" round>
          {{ session.isConnected ? '已连接' : '未连接' }}
        </n-tag>
        <span v-if="serialState.error.value" class="error-hint">{{ serialState.error.value }}</span>
      </div>
      <div class="toolbar-right">
        <n-button-group size="small">
          <n-button
            :type="appStore.displayMode === 'HEX' ? 'primary' : 'default'"
            @click="appStore.setDisplayMode('HEX')"
          >
            HEX
          </n-button>
          <n-button
            :type="appStore.displayMode === 'ASCII' ? 'primary' : 'default'"
            @click="appStore.setDisplayMode('ASCII')"
          >
            ASCII
          </n-button>
        </n-button-group>
        <n-button size="small" quaternary @click="toggleAutoScroll" :type="appStore.autoScroll ? 'primary' : 'default'" title="自动滚动">
          ↓
        </n-button>
        <n-button size="small" quaternary @click="toggleTimestamp" :type="appStore.showTimestamp ? 'primary' : 'default'" title="显示时间">
          ⏱
        </n-button>
        <n-dropdown :options="exportOptions" @select="handleExport" :disabled="session.frames.length === 0">
          <n-button size="small" quaternary :disabled="session.frames.length === 0" title="导出数据">
            导出
          </n-button>
        </n-dropdown>
      </div>
    </div>
    <div class="display-area">
      <DataPacketList :frames="session.frames" />
    </div>
    <div class="send-area">
      <SendPanel :on-send="handleSend" :disabled="!session.isConnected" :history="session.sendHistory" @clear-history="clearHistory" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { NButton, NTag, NButtonGroup, NDropdown } from 'naive-ui';
import DataPacketList from '../terminal/DataPacketList.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import { useSerialData } from '../../composables/useSerialData';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useExport } from '../../composables/useExport';
import { useMessage } from 'naive-ui';
import type { SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession;
}>();

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { exportData } = useExport();
const message = useMessage();
const serialState = useSerialData(
  props.session.id,
  props.session.portName,
  props.session.portConfig,
);

const exportOptions = [
  { label: '导出为 TXT (HEX)', key: 'txt-hex' },
  { label: '导出为 TXT (ASCII)', key: 'txt-ascii' },
  { label: '导出为 CSV', key: 'csv' },
  { label: '导出为 BIN', key: 'bin' },
];

onMounted(() => {
  sessionStore.registerCleanup(props.session.id, serialState.stop);
});

async function connect() {
  const ok = await serialState.start();
  if (!ok && serialState.error.value) {
    message.error(`连接失败: ${serialState.error.value}`);
  }
}

async function disconnect() {
  await serialState.stop();
}

function clear() {
  sessionStore.clearFrames(props.session.id);
}

async function handleSend(data: string, isHex: boolean) {
  const ok = await serialState.send(data, isHex);
  if (ok) {
    sessionStore.addSendHistory(props.session.id, { data, isHex });
  }
  return ok;
}

function clearHistory() {
  sessionStore.clearSendHistory(props.session.id);
}

function toggleAutoScroll() {
  appStore.toggleAutoScroll();
}

function toggleTimestamp() {
  appStore.toggleShowTimestamp();
}

async function handleExport(format: string) {
  const ok = await exportData(props.session.frames, format as 'txt-hex' | 'txt-ascii' | 'csv' | 'bin');
  if (ok) {
    message.success('导出成功');
  } else if (props.session.frames.length > 0) {
    message.error('导出失败');
  }
}
</script>

<style scoped>
.session-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.session-toolbar {
  padding: 6px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  min-height: 38px;
  flex-shrink: 0;
  gap: 8px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: 6px;
  align-items: center;
}

.error-hint {
  color: var(--accent-red);
  font-size: 11px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  background: var(--accent-red-subtle);
  border-radius: var(--radius-sm);
}

.display-area {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

.send-area {
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
</style>
