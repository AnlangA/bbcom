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
      :is-connected="runtime.isConnected.value"
      :is-connecting="runtime.isConnecting.value"
      :reconnecting="runtime.reconnecting.value"
      :error="runtime.error.value"
      :total-dropped-bytes="runtime.totalDroppedBytes.value"
      :sending-break="runtime.sendingBreak.value"
      :is-exporting="isExporting"
      :view-mode="viewMode"
      :export-options="exportOptions"
      @connect="connect"
      @disconnect="disconnect"
      @clear="clear"
      @toggle-pause="togglePause"
      @send-break="handleSendBreak"
      @update:view-mode="(m) => (viewMode = m)"
      @toggle-auto-scroll="toggleAutoScroll"
      @toggle-timestamp="toggleTimestamp"
      @toggle-auto-log="toggleAutoLog"
      @export="handleExport"
    />
    <div class="display-area">
      <!--
        View-mode switcher: only one of terminal / waveform / parser renders at
        a time, so they never stack and compete for vertical space. The terminal
        stays mounted (cheap to keep alive) while waveform/parser swap in only
        when selected, keeping the default view dense.
      -->
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
        :frames="props.session.frames"
        :frames-version="visibleFramesVersion"
        @close="viewMode = 'terminal'"
      />
      <DataPacketList
        v-else
        :frames="props.session.frames"
        :frames-version="visibleFramesVersion"
        :highlights="props.session.highlights"
      />
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
import { EXPORT_OPTIONS, type ExportChoice } from '../../lib/constants';
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

const sessionStore = useSessionStore();
const runtime = props.runtime;
const visibleFramesVersion = computed(() => sessionStore.getSessionFramesVersion(props.session.id));
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, exportData } = useExport();
const message = useMessage();

const exportOptions = computed(() =>
  EXPORT_OPTIONS.map((option) => ({ ...option, label: t(`export.${option.key}`) })),
);

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

async function handleExport(choice: string) {
  const result = await exportData(
    props.session.frames,
    choice as ExportChoice,
    appStore.displayMode,
  );
  if (result.ok) {
    message.success(t('message.exportSuccess'));
  } else if (result.error) {
    message.error(t('message.exportFailed', { error: result.error }));
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
