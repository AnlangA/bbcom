<template>
  <div class="session-view">
    <!--
      Toolbar extracted from SessionView: connection controls + display/view/format
      toggles live in SessionToolbar. This component is the layout orchestrator
      (toolbar + display-area + send-area) and owns the connection/Modbus/export
      state, wiring the toolbar's events to the composables.
    -->
    <SessionToolbar
      :session="props.session"
      :frames-version="visibleFramesVersion"
      :is-connected="runtime.isConnected.value"
      :is-connecting="runtime.isConnecting.value"
      :reconnecting="runtime.reconnecting.value"
      :error="runtime.error.value"
      :total-dropped-bytes="runtime.totalDroppedBytes.value"
      :sending-break="runtime.sendingBreak.value"
      :is-exporting="isExporting"
      :view-mode="viewMode"
      @connect="connect"
      @disconnect="disconnect"
      @clear="clear"
      @toggle-pause="togglePause"
      @send-break="handleSendBreak"
      @update:view-mode="(m) => (viewMode = m)"
      @toggle-auto-scroll="toggleAutoScroll"
      @toggle-timestamp="toggleTimestamp"
      @toggle-auto-log="toggleAutoLog"
      @export="openExportDialog"
    />
    <KeepAlive>
      <ExportDialog
        v-if="exportDialogVisible || isExporting"
        :show="exportDialogVisible"
        :frames="props.session.frames"
        :is-exporting="isExporting"
        :progress="progress"
        @confirm="handleExport"
        @cancel="handleExportCancel"
      />
    </KeepAlive>
    <div class="display-area">
      <!--
        Only one display mode renders at a time. Non-terminal panels load on
        first use, then KeepAlive preserves their local viewport/editor state
        while the user switches modes.
      -->
      <KeepAlive :max="4">
        <WaveformPanel
          v-if="viewMode === 'waveform'"
          ref="waveformRef"
          :frames="props.session.frames"
          :frames-version="visibleFramesVersion"
          direction="RX"
          :mode="props.session.waveformSourceMode"
          :channel-labels="waveformChannelLabels"
          @toggle-mode="toggleWaveformSourceMode"
        />
        <ModbusPanel
          v-else-if="viewMode === 'modbus'"
          :session-id="props.session.id"
          :config="props.session.modbusConfig"
          :registers="props.session.modbusRegisters"
          :is-connected="runtime.isConnected.value"
          :busy="modbusBusy"
          :status-text="modbusStatusText"
          :status-class="modbusStatusClass"
          :replaying="master.replaying.value"
          :write-source-name="writeSourceName"
          :on-read-all="onModbusReadAll"
          :on-read-row="onModbusReadRow"
          :on-send-all="onModbusSendAll"
          :on-send-row="onModbusSendRow"
          :on-replay="onModbusReplay"
          :on-stop-replay="onModbusStopReplay"
          :on-load-write-source="onLoadWriteSource"
          :on-clear-write-source="onClearWriteSource"
          :on-pick-write-source="onPickWriteSource"
          @plot-in-waveform="onPlotInWaveform"
          @close="viewMode = 'terminal'"
        />
        <ParserPanel
          v-else-if="viewMode === 'parser'"
          :session-id="props.session.id"
          :parsed-frames="runtime.parser.frames.value"
          :throughput-bps="runtime.parser.throughputBps.value"
          :parser-reset-version="runtime.parser.resetVersion.value"
          @close="viewMode = 'terminal'"
        />
        <DataPacketList
          v-else
          :frames="props.session.frames"
          :frames-version="visibleFramesVersion"
          :highlights="props.session.highlights"
        />
      </KeepAlive>
    </div>
    <div class="send-area">
      <SendPanel
        :on-send="handleSend"
        :on-start-loop="runtime.startSendLoop"
        :on-stop-loop="runtime.stopSendLoop"
        :looping="runtime.looping.value"
        :session-id="props.session.id"
        :model-value="props.session.sendDraft"
        :disabled="!runtime.isConnected.value"
        :history="props.session.sendHistory"
        :quick-commands="props.session.quickCommands"
        @update:model-value="updateSendDraft"
        @clear-history="clearHistory"
        @add-quick-command="addQuickCommand"
        @remove-quick-command="removeQuickCommand"
      />
    </div>
    <input
      :ref="setWriteSourceInput"
      type="file"
      accept=".bbreg,.jsonl,.txt"
      hidden
      @change="onWriteSourcePicked"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onUnmounted, ref } from 'vue';
import DataPacketList from '../terminal/DataPacketList.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import SessionToolbar from './SessionToolbar.vue';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useExport } from '../../composables/useExport';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionShortcuts } from '../../composables/useSessionShortcuts';
import { useMessage } from 'naive-ui';
import type { ExportChoice } from '../../lib/constants';
import type { ExportFrameSnapshot } from '../../lib/export-filters';
import { t } from '../../lib/i18n';
import type { SerialSession } from '../../types';
import type {
  SessionRuntimeController,
  SessionRuntimeWaveformSink,
} from '../../features/sessions/runtime/session-runtime-controller';

const props = defineProps<{
  session: SerialSession;
  runtime: SessionRuntimeController;
}>();

const WaveformPanel = defineAsyncComponent(() => import('../terminal/WaveformPanel.vue'));
const ParserPanel = defineAsyncComponent(() => import('../terminal/ParserPanel.vue'));
const ModbusPanel = defineAsyncComponent(() => import('../terminal/ModbusPanel.vue'));
const ExportDialog = defineAsyncComponent(() => import('./ExportDialog.vue'));

const sessionStore = useSessionStore();
const runtime = props.runtime;
const visibleFramesVersion = computed(() => sessionStore.getSessionFramesVersion(props.session.id));
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, progress, cancelExport, resetExportProgress, exportData } = useExport();
const message = useMessage();
const exportDialogVisible = ref(false);

async function connect() {
  await runtime.connect();
}

async function disconnect() {
  await runtime.disconnect();
}

function clear() {
  requestClearFrames(props.session.id);
}

function togglePause() {
  sessionStore.setCapturePaused(props.session.id, !props.session.capturePaused);
}

// Pro-terminal keyboard shortcuts: Ctrl/Cmd+L clears the buffer, Esc toggles
// capture pause. Only active while connected so Esc doesn't fire spuriously.
useSessionShortcuts({
  onClear: clear,
  onTogglePause: togglePause,
  isConnected: () => props.session.isConnected,
  isActive: () => sessionStore.activeSessionId === props.session.id,
});

// Single view-mode switcher for the display area: terminal (default, dense),
// waveform (live RX plot), parser (frame reassembly), or modbus (register
// table). Only the selected view renders, so they never stack and compete for
// vertical space.
const viewMode = runtime.viewMode;

// --- Modbus master ---------------------------------------------------------
// The runtime owns the Modbus master and its periodic loops. This active-only
// view attaches the optional waveform sink and consumes the controller API.
const waveformRef = ref<SessionRuntimeWaveformSink | null>(null);

const {
  modbusBusy,
  modbusStatusText,
  modbusStatusClass,
  waveformChannelLabels,
  writeSourceInput,
  writeSourceName,
  master,
  toggleWaveformSourceMode,
  readAll: onModbusReadAll,
  readRow: onModbusReadRow,
  sendAll: onModbusSendAll,
  sendRow: onModbusSendRow,
  startReplay: onModbusReplay,
  stopReplay: onModbusStopReplay,
  pickWriteSource: onPickWriteSource,
  loadWriteSource: onLoadWriteSource,
  clearWriteSource: onClearWriteSource,
  onWriteSourcePicked,
  plotInWaveform: onPlotInWaveform,
} = runtime.modbus;

const detachRuntimeView = runtime.attachView({ waveformRef });

onUnmounted(detachRuntimeView);

function setWriteSourceInput(element: unknown) {
  writeSourceInput.value = element instanceof HTMLInputElement ? element : null;
}

async function handleSendBreak() {
  await runtime.sendBreak();
}

async function handleSend(data: string, isHex: boolean) {
  return runtime.send(data, isHex);
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
  await runtime.toggleAutoLog();
}

async function handleExport(payload: { snapshot: ExportFrameSnapshot; choice: ExportChoice }) {
  const result = await exportData(payload.snapshot, payload.choice, appStore.displayMode);
  if (result.ok) {
    exportDialogVisible.value = false;
    message.success(t('message.exportSuccess'));
  } else if (result.cancelled) {
    exportDialogVisible.value = false;
  } else if (result.error) {
    message.error(t('message.exportFailed', { error: result.error }));
  }
}

function openExportDialog() {
  resetExportProgress();
  exportDialogVisible.value = true;
}

function handleExportCancel() {
  if (isExporting.value) {
    cancelExport();
  } else {
    exportDialogVisible.value = false;
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
</style>
