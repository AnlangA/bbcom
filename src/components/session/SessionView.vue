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
          <template #icon>
            <Power class="icon-sm" />
          </template>
          连接
        </n-button>
        <n-button v-else type="error" size="small" ghost @click="disconnect">
          <template #icon>
            <PowerOff class="icon-sm" />
          </template>
          断开
        </n-button>
        <n-button size="small" @click="clear" :disabled="session.frames.length === 0">
          <template #icon>
            <Trash2 class="icon-sm" />
          </template>
          清空
        </n-button>
        <n-button
          v-if="session.isConnected"
          size="small"
          ghost
          :type="session.capturePaused ? 'warning' : 'default'"
          :title="session.capturePaused ? '继续捕获' : '暂停捕获（冻结视图，继续缓冲）'"
          @click="togglePause"
        >
          <template #icon>
            <Pause v-if="!session.capturePaused" class="icon-sm" />
            <Play v-else class="icon-sm" />
          </template>
          {{ session.capturePaused ? '继续' : '暂停' }}
        </n-button>
        <n-tag
          :type="session.isConnected ? 'success' : 'default'"
          size="small"
          round
          :bordered="false"
        >
          {{ session.isConnected ? '已连接' : '未连接' }}
        </n-tag>
        <n-tag
          v-if="serialState.reconnecting.value"
          type="warning"
          size="small"
          round
          :bordered="false"
        >
          重连中
        </n-tag>
        <span v-if="serialState.error.value" class="error-hint">{{ serialState.error.value }}</span>
        <span
          v-if="serialState.totalDroppedBytes.value > 0"
          class="drop-hint"
          :title="`本次连接累计丢弃 ${serialState.totalDroppedBytes.value} 字节（接收速率超过处理能力）`"
        >
          丢弃 {{ formatBytes(serialState.totalDroppedBytes.value) }}
        </span>
      </div>
      <div class="toolbar-right">
        <div class="toolbar-field">
          <FileText class="icon-sm field-icon" />
          <span class="field-label">格式</span>
          <n-select
            :value="appStore.displayMode"
            :options="displayModeOptions"
            size="small"
            style="width: 112px"
            @update:value="appStore.setDisplayMode"
          />
        </div>
        <div class="toggle-group" role="group" aria-label="显示选项">
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.autoScroll ? 'primary' : 'default'"
            title="自动滚动"
            aria-label="自动滚动"
            @click="toggleAutoScroll"
          >
            <template #icon>
              <ArrowDownUp class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.ansiColorEnabled ? 'primary' : 'default'"
            title="ANSI 颜色渲染"
            aria-label="ANSI 颜色"
            @click="appStore.toggleAnsiColor"
          >
            <template #icon>
              <Palette class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.showTimestamp ? 'primary' : 'default'"
            title="显示时间戳"
            aria-label="时间戳"
            @click="toggleTimestamp"
          >
            <template #icon>
              <Clock class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="session.autoLogEnabled ? 'primary' : 'default'"
            title="标记自动记录"
            aria-label="自动记录"
            @click="toggleAutoLog"
          >
            <template #icon>
              <FileText class="icon-sm" />
            </template>
          </n-button>
        </div>
        <n-dropdown
          :options="exportOptions"
          @select="handleExport"
          :disabled="session.frames.length === 0 || isExporting"
        >
          <n-button
            size="small"
            quaternary
            :disabled="session.frames.length === 0"
            :loading="isExporting"
            title="导出数据"
          >
            <template #icon>
              <Download class="icon-sm" />
            </template>
            导出
          </n-button>
        </n-dropdown>
      </div>
    </div>
    <div class="display-area">
      <DataPacketList :frames="session.frames" />
    </div>
    <div class="send-area">
      <SendPanel
        :on-send="handleSend"
        :model-value="session.sendDraft"
        :disabled="!session.isConnected"
        :history="session.sendHistory"
        :quick-commands="session.quickCommands"
        @update:model-value="updateSendDraft"
        @clear-history="clearHistory"
        @add-quick-command="addQuickCommand"
        @remove-quick-command="removeQuickCommand"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { NButton, NTag, NDropdown, NSelect } from 'naive-ui';
import {
  ArrowDownUp,
  Clock,
  Download,
  FileText,
  Palette,
  Pause,
  Play,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-vue-next';
import DataPacketList from '../terminal/DataPacketList.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import { useSerialConnection } from '../../composables/useSerialConnection';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useExport } from '../../composables/useExport';
import { useSessionActions } from '../../composables/useSessionActions';
import { useMessage } from 'naive-ui';
import { EXPORT_OPTIONS, type ExportFormat } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import type { DisplayMode, SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession;
}>();

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, exportData } = useExport();
const message = useMessage();
const serialState = useSerialConnection(
  props.session.id,
  props.session.portName,
  props.session.portConfig,
  {
    onDisconnect: () => {
      message.warning('串口已断开');
    },
    onOverflow: (total) => {
      message.warning(`接收缓冲区溢出，已丢弃约 ${formatBytes(total)} 数据（速率超过处理能力）`);
    },
    autoReconnect: () => appStore.autoReconnect,
    onReconnecting: () => {
      message.info('连接已断开，正在尝试重新连接…');
    },
    onReconnected: () => {
      message.success('已重新连接');
    },
  },
);

const displayModeOptions: { label: string; value: DisplayMode }[] = [
  { label: 'HEX', value: 'HEX' },
  { label: 'ASCII', value: 'ASCII' },
  { label: 'ANSI', value: 'ANSI' },
  { label: 'UTF-8', value: 'UTF8' },
];

const exportOptions = EXPORT_OPTIONS;

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
  requestClearFrames(props.session.id);
}

function togglePause() {
  sessionStore.setCapturePaused(props.session.id, !props.session.capturePaused);
}

async function handleSend(data: string, isHex: boolean) {
  const ok = await serialState.send(data, isHex);
  if (ok) {
    sessionStore.addSendHistory(props.session.id, { data, isHex });
    sessionStore.setSendDraft(props.session.id, '');
  }
  return ok;
}

function updateSendDraft(value: string) {
  sessionStore.setSendDraft(props.session.id, value);
}

function clearHistory() {
  sessionStore.clearSendHistory(props.session.id);
}

function addQuickCommand(command: { name: string; data: string; isHex: boolean }) {
  sessionStore.addQuickCommand(props.session.id, command);
}

function removeQuickCommand(id: string) {
  sessionStore.removeQuickCommand(props.session.id, id);
}

function toggleAutoScroll() {
  appStore.toggleAutoScroll();
}

function toggleTimestamp() {
  appStore.toggleShowTimestamp();
}

function toggleAutoLog() {
  sessionStore.setAutoLogEnabled(props.session.id, !props.session.autoLogEnabled);
  message.info(
    props.session.autoLogEnabled ? '已关闭自动记录标记' : '已开启自动记录标记，可通过导出保存数据',
  );
}

async function handleExport(format: string) {
  const result = await exportData(props.session.frames, format as ExportFormat);
  if (result.ok) {
    message.success('导出成功');
  } else if (result.error) {
    message.error(`导出失败：${result.error}`);
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
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  min-height: var(--toolbar-height);
  flex-shrink: 0;
  gap: 12px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

.toolbar-left {
  min-width: 0;
}

.toolbar-right {
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toggle-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.toolbar-field {
  height: 32px;
  padding: 0 6px 0 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.field-icon {
  color: var(--text-dim);
}

.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.error-hint {
  color: var(--accent-red);
  font-size: 11px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 7px;
  background: var(--accent-red-subtle);
  border: 1px solid rgba(255, 107, 122, 0.22);
  border-radius: var(--radius-full);
}

.drop-hint {
  color: var(--accent-amber);
  font-size: 11px;
  white-space: nowrap;
  padding: 3px 7px;
  background: var(--accent-amber-subtle);
  border: 1px solid var(--accent-amber-border);
  border-radius: var(--radius-full);
}

.display-area {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

.send-area {
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  background: var(--bg-secondary);
}

@media (max-width: 900px) {
  .session-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .toolbar-right {
    justify-content: flex-start;
  }
}
</style>
