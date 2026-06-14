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
        <n-tag
          :type="session.isConnected ? 'success' : 'default'"
          size="small"
          round
          :bordered="false"
        >
          {{ session.isConnected ? '已连接' : '未连接' }}
        </n-tag>
        <span v-if="serialState.error.value" class="error-hint">{{ serialState.error.value }}</span>
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
        <div class="toolbar-toggles">
          <n-button
            size="small"
            quaternary
            @click="toggleAutoScroll"
            :type="appStore.autoScroll ? 'primary' : 'default'"
            title="自动滚动"
          >
            <template #icon>
              <ArrowDownUp class="icon-sm" />
            </template>
            自动滚动
          </n-button>
          <n-button
            size="small"
            quaternary
            @click="appStore.toggleAnsiColor"
            :type="appStore.ansiColorEnabled ? 'primary' : 'default'"
            title="ANSI颜色渲染"
          >
            <template #icon>
              <Palette class="icon-sm" />
            </template>
            颜色
          </n-button>
          <n-button
            size="small"
            quaternary
            @click="toggleTimestamp"
            :type="appStore.showTimestamp ? 'primary' : 'default'"
            title="显示时间"
          >
            <template #icon>
              <Clock class="icon-sm" />
            </template>
            时间
          </n-button>
          <n-button
            size="small"
            quaternary
            @click="toggleAutoLog"
            :type="session.autoLogEnabled ? 'primary' : 'default'"
            :title="
              session.autoLogEnabled && session.logPath
                ? `正在记录到 ${session.logPath}（再次点击停止）`
                : '自动记录 TX/RX 到文件'
            "
          >
            <template #icon>
              <FileText class="icon-sm" />
            </template>
            LOG
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
import { useAutoLog } from '../../composables/useAutoLog';
import { useSessionActions } from '../../composables/useSessionActions';
import { useMessage } from 'naive-ui';
import { EXPORT_OPTIONS, type ExportChoice } from '../../lib/constants';
import type { DisplayMode, SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession;
}>();

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, exportData } = useExport();
const { enable: enableAutoLog, disable: disableAutoLog } = useAutoLog();
const message = useMessage();
const serialState = useSerialConnection(
  props.session.id,
  props.session.portName,
  props.session.portConfig,
  {
    onDisconnect: () => {
      message.warning('串口已断开');
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

async function handleSend(data: string, isHex: boolean) {
  const ok = await serialState.send(data, isHex);
  if (ok) {
    sessionStore.addSendHistory(props.session.id, { data, isHex });
    // Note: do NOT clear the draft here. SendPanel owns the input and clears it
    // via updateInput on success — gated by !looping so a cyclic-send loop can
    // keep resending the same payload. Clearing here would empty the input after
    // the first loop tick and break every subsequent send.
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

async function toggleAutoLog() {
  if (props.session.autoLogEnabled) {
    disableAutoLog(props.session.id);
    message.info('已停止自动记录');
    return;
  }
  // enable prompts for a target file; frames (TX+RX) are then appended to it in
  // the current display format as they arrive.
  const path = await enableAutoLog(props.session.id);
  if (path) {
    message.success(`正在记录到 ${path}`);
  }
  // user dismissed the save dialog → no message
}

async function handleExport(choice: string) {
  // The text export follows the currently selected display mode, so the saved
  // file matches the encoding the user is viewing (HEX → hex, ASCII/UTF-8 →
  // decoded text). Passing appStore.displayMode lets useExport resolve it.
  const result = await exportData(
    props.session.frames,
    choice as ExportChoice,
    appStore.displayMode,
  );
  if (result === 'success') {
    message.success('导出成功');
  } else if (result === 'error') {
    message.error('导出失败');
  }
  // 'cancelled' (user dismissed the save dialog) → no message
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

.toolbar-field,
.toolbar-toggles {
  display: flex;
  align-items: center;
  gap: 6px;
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
