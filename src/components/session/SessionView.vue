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
      :is-connected="serialState.isConnected.value"
      :is-connecting="serialState.isConnecting.value"
      :reconnecting="serialState.reconnecting.value"
      :error="serialState.error.value"
      :total-dropped-bytes="serialState.totalDroppedBytes.value"
      :sending-break="sendingBreak"
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
        :frames-version="sessionStore.framesVersion"
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
        :is-connected="props.session.isConnected"
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
        @close="viewMode = 'terminal'"
      />
      <DataPacketList
        v-else
        :frames="props.session.frames"
        :highlights="props.session.highlights"
      />
    </div>
    <div class="send-area">
      <SendPanel
        :on-send="handleSend"
        :session-id="props.session.id"
        :model-value="props.session.sendDraft"
        :disabled="!props.session.isConnected"
        :history="props.session.sendHistory"
        :quick-commands="props.session.quickCommands"
        @update:model-value="updateSendDraft"
        @clear-history="clearHistory"
        @add-quick-command="addQuickCommand"
        @remove-quick-command="removeQuickCommand"
      />
    </div>
    <input
      ref="writeSourceInput"
      type="file"
      accept=".bbreg,.jsonl,.txt"
      hidden
      @change="onWriteSourcePicked"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import DataPacketList from '../terminal/DataPacketList.vue';
import WaveformPanel from '../terminal/WaveformPanel.vue';
import ParserPanel from '../terminal/ParserPanel.vue';
import ModbusPanel from '../terminal/ModbusPanel.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import SessionToolbar, { type SessionViewMode } from './SessionToolbar.vue';
import { useSerialConnection } from '../../composables/useSerialConnection';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useSessionModbus } from '../../composables/useSessionModbus';
import { useExport } from '../../composables/useExport';
import { useAutoLog } from '../../composables/useAutoLog';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionShortcuts } from '../../composables/useSessionShortcuts';
import { useTriggers } from '../../composables/useTriggers';
import { useMessage } from 'naive-ui';
import { EXPORT_OPTIONS, type ExportChoice } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession;
}>();

const sessionStore = useSessionStore();
const appStore = useAppStore();
const { requestClearFrames } = useSessionActions();
const { isExporting, exportData } = useExport();
const { enable: enableAutoLog, disable: disableAutoLog } = useAutoLog();
const message = useMessage();

// Scripted triggers: watch RX bytes and auto-send a configured response on
// match. `handleSend` is defined below but hoisted via function declaration, so
// it is safely referenceable here. The engine itself is debounced/cooldown'd.
const triggersRef = computed(() => props.session.triggers);
const { feedFrame: feedTriggerFrame } = useTriggers({
  triggers: triggersRef,
  send: (data, isHex) => handleSend(data, isHex),
  onFire: (fire) => {
    const trigger = props.session.triggers.find((x) => x.id === fire.triggerId);
    message.info(t('message.triggerFired', { name: trigger?.name ?? fire.triggerId }));
  },
});

const serialState = useSerialConnection(
  props.session.id,
  props.session.portName,
  props.session.portConfig,
  {
    onDisconnect: () => {
      message.warning(t('serial.error.disconnected'));
    },
    onOverflow: (total) => {
      message.warning(t('serial.error.rxOverflow', { bytes: formatBytes(total) }));
      // Mirror the cumulative dropped-byte count onto the session so the
      // StatusBar can surface it as a live metric without the connection composable.
      sessionStore.updateDroppedBytes(props.session.id, total);
    },
    autoReconnect: () => appStore.autoReconnect,
    onReconnecting: () => {
      message.info(t('serial.error.reconnecting'));
    },
    onReconnected: () => {
      message.success(t('serial.error.reconnected'));
    },
    onRxFrame: (frame) => {
      void feedTriggerFrame(frame);
    },
  },
);

const exportOptions = computed(() =>
  EXPORT_OPTIONS.map((option) => ({ ...option, label: t(`export.${option.key}`) })),
);

onMounted(() => {
  sessionStore.registerCleanup(props.session.id, serialState.stop);
});

async function connect() {
  const ok = await serialState.start();
  if (!ok && serialState.error.value) {
    message.error(t('serial.error.connectFailed', { error: serialState.error.value }));
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

// Pro-terminal keyboard shortcuts: Ctrl/Cmd+L clears the buffer, Esc toggles
// capture pause. Only active while connected so Esc doesn't fire spuriously.
useSessionShortcuts({
  onClear: clear,
  onTogglePause: togglePause,
  isConnected: () => props.session.isConnected,
});

const sendingBreak = ref(false);
// Single view-mode switcher for the display area: terminal (default, dense),
// waveform (live RX plot), parser (frame reassembly), or modbus (register
// table). Only the selected view renders, so they never stack and compete for
// vertical space.
const viewMode = ref<SessionViewMode>('terminal');

// --- Modbus master ---------------------------------------------------------
// All Modbus wiring (master lifecycle, the imperative read/write/replay
// handlers, the periodic-write source file picking) is encapsulated in
// useSessionModbus so this component stays a thin orchestrator.
const waveformRef = ref<{
  pushRegisterSample: (channel: number, value: number, timestamp?: number) => void;
  pushRegisterSamples: (
    samples: readonly { channel: number; value: number; timestamp?: number }[],
  ) => void;
} | null>(null);

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
} = useSessionModbus({
  session: computed(() => props.session),
  sendBytes: (payload) => serialState.sendBytes(payload),
  rawBytes: (cb) => serialState.rawBytes(cb),
  isConnected: serialState.isConnected,
  waveformRef,
  showWaveform: () => {
    viewMode.value = 'waveform';
  },
});

async function handleSendBreak() {
  sendingBreak.value = true;
  const ok = await serialState.sendBreak();
  sendingBreak.value = false;
  if (ok) {
    message.success(t('message.breakSent'));
  } else {
    message.warning(t('message.breakFailed'));
  }
}

async function handleSend(data: string, isHex: boolean) {
  const ok = await serialState.send(data, isHex);
  if (ok) {
    sessionStore.addSendHistory(props.session.id, { data, isHex });
    // SendPanel owns draft clearing and skips it while cyclic send is active.
    // Clearing here would empty the payload after the first loop tick.
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
    message.info(t('message.autoLogStopped'));
    return;
  }
  const path = await enableAutoLog(props.session.id);
  if (path) {
    message.success(t('message.autoLogStarted', { path }));
  }
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
