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
        <div class="toolbar-field">
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
          <n-button size="small" quaternary @click="toggleAutoScroll" :type="appStore.autoScroll ? 'primary' : 'default'" title="自动滚动">
            自动滚动
          </n-button>
          <n-button size="small" quaternary @click="appStore.toggleAnsiColor" :type="appStore.ansiColorEnabled ? 'primary' : 'default'" title="ANSI颜色渲染">
            颜色
          </n-button>
          <n-button size="small" quaternary @click="toggleTimestamp" :type="appStore.showTimestamp ? 'primary' : 'default'" title="显示时间">
            时间
          </n-button>
          <n-button size="small" quaternary @click="toggleAutoLog" :type="session.autoLogEnabled ? 'primary' : 'default'" title="接收自动记录">
            LOG
          </n-button>
        </div>
        <n-dropdown :options="exportOptions" @select="handleExport" :disabled="session.frames.length === 0 || isExporting">
          <n-button size="small" quaternary :disabled="session.frames.length === 0" :loading="isExporting" title="导出数据">
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
import DataPacketList from '../terminal/DataPacketList.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import { useSerialData } from '../../composables/useSerialData';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useExport } from '../../composables/useExport';
import { useSessionActions } from '../../composables/useSessionActions';
import { useMessage } from 'naive-ui';
import type { DisplayMode, SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession;
}>();

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, exportData } = useExport();
const message = useMessage();
const serialState = useSerialData(
  props.session.id,
  props.session.portName,
  props.session.portConfig,
);

const displayModeOptions: { label: string; value: DisplayMode }[] = [
  { label: 'HEX', value: 'HEX' },
  { label: 'ASCII', value: 'ASCII' },
  { label: 'ANSI', value: 'ANSI' },
  { label: 'UTF-8', value: 'UTF8' },
];

const exportOptions = [
  { label: '导出为 TXT (HEX)', key: 'txt-hex' },
  { label: '导出为 TXT (ASCII)', key: 'txt-ascii' },
  { label: '导出为 CSV', key: 'csv' },
  { label: '导出为 JSON Lines', key: 'jsonl' },
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
  requestClearFrames(props.session.id);
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
  message.info(props.session.autoLogEnabled ? '已关闭自动记录标记' : '已开启自动记录标记，可通过导出保存数据');
}

async function handleExport(format: string) {
  const ok = await exportData(props.session.frames, format as 'txt-hex' | 'txt-ascii' | 'csv' | 'jsonl' | 'bin');
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
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  min-height: 44px;
  flex-shrink: 0;
  gap: 8px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: 6px;
  align-items: center;
}

.toolbar-left {
  min-width: 0;
}

.toolbar-right {
  gap: 10px;
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
  padding: 2px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
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
