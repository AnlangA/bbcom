<template>
  <div
    :id="`session-panel-${props.session.id}`"
    class="session-view"
    role="tabpanel"
    :aria-labelledby="`session-tab-${props.session.id}`"
  >
    <!--
      Toolbar extracted from SessionView: connection controls + display/view/format
      toggles live in SessionToolbar. This component is the layout orchestrator
      (toolbar + display-area + send-area) and owns the connection/Modbus/export
      state, wiring the toolbar's events to the composables.
    -->
    <SessionToolbar
      :session="props.session"
      :frames-version="visibleFramesVersion"
      :is-connected="runtime.sessionLinkUp.value"
      :is-connecting="runtime.isConnecting.value"
      :reconnecting="runtime.reconnecting.value"
      :error="runtime.error.value"
      :connection-conflict="runtime.connectionFailure.value?.conflict"
      :needs-rebind="Boolean(rebindMetadata)"
      :sending-break="runtime.sendingBreak.value"
      :is-exporting="isExporting"
      :view-mode="viewMode"
      :connection-locked="runtime.mcumgr.busy.value"
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
      @show-conflicting-session="showConflictingSession"
      @rebind="rebindDialogVisible = true"
    />
    <SessionRebindDialog
      :show="rebindDialogVisible"
      :session-id="props.session.id"
      :port-config="props.session.portConfig"
      @update:show="rebindDialogVisible = $event"
      @rebound="rebindDialogVisible = false"
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
      <KeepAlive :max="6">
        <WaveformPanel
          v-if="viewMode === 'waveform'"
          ref="waveformRef"
          :frames="props.session.frames"
          :frames-version="visibleFramesVersion"
          direction="RX"
          :mode="props.session.waveformSourceMode"
          :channel-labels="waveformChannelLabels"
          :waveform="waveformState"
          :can-edit="mutationPolicy.userMutationsAllowed.value"
          :can-append="mutationPolicy.runtimeCaptureAllowed.value"
          @toggle-mode="toggleWaveformSourceMode"
          @append-samples="appendWaveformSamples"
          @replace-samples="replaceWaveformSamples"
          @set-channel-visibility="setWaveformChannelVisibility"
          @update-frame-cursor="updateWaveformFrameCursor"
          @commit-frame-ingest="commitWaveformFrameIngest"
          @clear="clearWaveform"
        />
        <ModbusPanel
          v-else-if="viewMode === 'modbus'"
          :session-id="props.session.id"
          :config="props.session.modbusConfig"
          :registers="props.session.modbusRegisters"
          :is-connected="runtime.sessionLinkUp.value"
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
          :dropped-frames="runtime.parser.droppedFrames.value"
          :dropped-bytes="runtime.parser.droppedBytes.value"
          :throughput-bps="runtime.parser.throughputBps.value"
          :parser-reset-version="runtime.parser.resetVersion.value"
          @close="viewMode = 'terminal'"
        />
        <SerialShellPanel
          v-else-if="viewMode === 'shell'"
          :session-id="props.session.id"
          :config="props.session.shellConfig"
          :is-connected="runtime.sessionLinkUp.value"
          :shell="runtime.shell"
          @close="viewMode = 'terminal'"
        />
        <McumgrPanel
          v-else-if="viewMode === 'mcumgr'"
          :session-id="props.session.id"
          :config="props.session.mcumgrConfig"
          :is-connected="runtime.sessionLinkUp.value"
          :mcumgr="runtime.mcumgr"
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
    <div v-if="viewMode !== 'shell' && viewMode !== 'mcumgr'" class="send-area">
      <SendPanel
        :on-send="handleSend"
        :macro-runner="runtime.macro"
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
import { computed, defineAsyncComponent, onUnmounted, provide, ref } from 'vue';
import DataPacketList from '@/features/terminal/ui/DataPacketList.vue';
import SendPanel from '@/features/send-panel/ui/SendPanel.vue';
import SessionToolbar from './SessionToolbar.vue';
import SessionRebindDialog from './SessionRebindDialog.vue';
import {
  useSessionCapture,
  useSessionCatalog,
  useSessionDocument,
  useSessionMutationPolicy,
  useSessionWaveform,
} from '@/features/sessions';
import { useAppStore } from '@/features/settings/store/app-store';
import { useExport } from '@/features/workspace/application/use-export';
import { useSessionActions } from '@/features/sessions/application/use-session-actions';
import { useSessionShortcuts } from '@/features/sessions/application/use-session-shortcuts';
import { useMessage } from 'naive-ui';
import type { ExportChoice } from '@/lib/constants';
import type { ExportFrameSnapshot } from '@/lib/export-filters';
import { t } from '@/lib/i18n';
import type {
  SerialSession,
  SessionWaveformFrameCursor,
  SessionWaveformSampleInput,
  SessionWaveformState,
} from '@/types';
import type {
  SessionRuntimeController,
  SessionRuntimeWaveformSink,
} from '@/features/sessions/runtime/session-runtime-controller';
import { SESSION_UI_STATE_KEY } from '@/features/sessions/runtime/session-ui-state';

const props = defineProps<{
  session: SerialSession;
  runtime: SessionRuntimeController;
}>();

// Panels (packet list, tools tabs, Modbus) inject this to retain their
// view-local state on the runtime across SessionView remounts.
provide(SESSION_UI_STATE_KEY, props.runtime.uiState);

const WaveformPanel = defineAsyncComponent(() => import('@/features/terminal/ui/WaveformPanel.vue'));
const ParserPanel = defineAsyncComponent(() => import('@/features/terminal/ui/ParserPanel.vue'));
const ModbusPanel = defineAsyncComponent(() => import('@/features/terminal/ui/ModbusPanel.vue'));
const SerialShellPanel = defineAsyncComponent(() => import('@/features/terminal/ui/SerialShellPanel.vue'));
const McumgrPanel = defineAsyncComponent(() => import('@/features/terminal/ui/McumgrPanel.vue'));
const ExportDialog = defineAsyncComponent(() => import('./ExportDialog.vue'));

const catalog = useSessionCatalog();
const capture = useSessionCapture(props.session.id);
const sessionDocument = useSessionDocument(props.session.id);
const mutationPolicy = useSessionMutationPolicy();
const waveform = useSessionWaveform(props.session.id);
const runtime = props.runtime;
const visibleFramesVersion = capture.framesVersion;
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, progress, cancelExport, resetExportProgress, exportData } = useExport({
  sessionId: props.session.id,
});
const message = useMessage();
const exportDialogVisible = ref(false);
const rebindDialogVisible = ref(false);
const rebindMetadata = computed(
  () => catalog.workspaceRebindBySessionId.value[props.session.id] ?? null,
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
  capture.setPaused(!props.session.capturePaused);
}

// Pro-terminal keyboard shortcuts: Ctrl/Cmd+L clears the buffer, Esc toggles
// capture pause. Only active while connected so Esc doesn't fire spuriously.
useSessionShortcuts({
  onClear: clear,
  onTogglePause: togglePause,
  isConnected: () => runtime.isConnected.value,
  isActive: () => catalog.activeSessionId.value === props.session.id,
});

// Single view-mode switcher for the display area: terminal (default), waveform,
// parser, modbus, serial shell, or MCUMgr. Only the selected view renders.
const viewMode = runtime.viewMode;

// --- Modbus master ---------------------------------------------------------
// The runtime owns the Modbus master and its periodic loops. This active-only
// view attaches the optional waveform sink and consumes the controller API.
const waveformRef = ref<SessionRuntimeWaveformSink | null>(null);
const EMPTY_WAVEFORM_STATE = Object.freeze<SessionWaveformState>({
  channels: Object.freeze([]),
  samples: Object.freeze([]),
  frameCursor: Object.freeze({ consumed: 0, lastFrameId: null }),
});
const waveformState = computed(() => waveform.state.value ?? EMPTY_WAVEFORM_STATE);

function appendWaveformSamples(samples: readonly SessionWaveformSampleInput[]): void {
  waveform.appendSamples(props.session.id, samples);
}

function replaceWaveformSamples(samples: readonly SessionWaveformSampleInput[]): void {
  waveform.replaceSamples(props.session.id, samples);
}

function setWaveformChannelVisibility(channelIndex: number, visible: boolean): void {
  waveform.setChannelVisible(props.session.id, channelIndex, visible);
}

function updateWaveformFrameCursor(cursor: SessionWaveformFrameCursor): void {
  waveform.setFrameCursor(props.session.id, cursor);
}

function commitWaveformFrameIngest(ingest: {
  readonly mode: 'append' | 'replace';
  readonly samples: readonly SessionWaveformSampleInput[];
  readonly cursor: SessionWaveformFrameCursor;
}): void {
  waveform.commitFrameIngest(props.session.id, ingest.mode, ingest.samples, ingest.cursor);
}

function clearWaveform(cursor: SessionWaveformFrameCursor): void {
  waveform.reset(props.session.id, cursor);
}

function showConflictingSession(sessionId: string): void {
  if (catalog.sessions.value.some((session) => session.id === sessionId)) {
    catalog.activate(sessionId);
  }
}

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
  sessionDocument.setSendDraft(props.session.id, value);
}

function clearHistory() {
  sessionDocument.clearSendHistory(props.session.id);
}

function addQuickCommand(command: { name: string; data: string; isHex: boolean }) {
  sessionDocument.addQuickCommand(props.session.id, command);
}

function removeQuickCommand(id: string) {
  sessionDocument.removeQuickCommand(props.session.id, id);
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

async function handleExport(payload: {
  snapshot: ExportFrameSnapshot;
  choice: ExportChoice;
  unfiltered: boolean;
}) {
  const result = await exportData(payload.snapshot, payload.choice, appStore.displayMode, {
    unfiltered: payload.unfiltered,
  });
  if (result.ok) {
    exportDialogVisible.value = false;
    if (result.divergence) {
      // DB-sourced exports read the durable project, which can differ from the
      // paused-capture preview; the difference is surfaced, never silent.
      message.warning(
        t('message.exportDbDivergence', {
          persisted: result.divergence.persistedFrames,
          selection: result.divergence.selectionFrames,
        }),
      );
    }
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
