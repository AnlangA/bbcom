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
          {{ t('session.connect') }}
        </n-button>
        <n-button v-else type="error" size="small" ghost @click="disconnect">
          <template #icon>
            <PowerOff class="icon-sm" />
          </template>
          {{ t('session.disconnect') }}
        </n-button>
        <n-button size="small" @click="clear" :disabled="session.frames.length === 0">
          <template #icon>
            <Trash2 class="icon-sm" />
          </template>
          {{ t('session.clear') }}
        </n-button>
        <n-button
          v-if="session.isConnected"
          size="small"
          ghost
          :type="session.capturePaused ? 'warning' : 'default'"
          :title="session.capturePaused ? t('session.resume.title') : t('session.pause.title')"
          @click="togglePause"
        >
          <template #icon>
            <Pause v-if="!session.capturePaused" class="icon-sm" />
            <Play v-else class="icon-sm" />
          </template>
          {{ session.capturePaused ? t('session.resume') : t('session.pause') }}
        </n-button>
        <n-button
          v-if="session.isConnected"
          size="small"
          ghost
          :loading="sendingBreak"
          :title="t('session.break.title')"
          @click="handleSendBreak"
        >
          <template #icon>
            <Unplug class="icon-sm" />
          </template>
          BREAK
        </n-button>
        <n-tag
          :type="session.isConnected ? 'success' : 'default'"
          size="small"
          round
          :bordered="false"
        >
          {{ session.isConnected ? t('session.connected') : t('session.disconnected') }}
        </n-tag>
        <div class="toolbar-stats" :aria-label="t('session.stats.aria')">
          <span class="mini-stat tx" :title="`TX ${session.txFrames} ${t('status.frames')}`">
            <span class="mini-label">TX</span>
            {{ formatBytes(session.txBytes) }}
          </span>
          <span class="mini-stat rx" :title="`RX ${session.rxFrames} ${t('status.frames')}`">
            <span class="mini-label">RX</span>
            {{ formatBytes(session.rxBytes) }}
          </span>
          <span
            class="mini-stat"
            :title="t('session.stats.totalFrames', { count: session.frames.length })"
          >
            <span class="mini-label">{{ t('session.stats.frames') }}</span>
            {{ session.frames.length }}
          </span>
        </div>
        <n-tag
          v-if="serialState.reconnecting.value"
          type="warning"
          size="small"
          round
          :bordered="false"
        >
          {{ t('session.reconnecting') }}
        </n-tag>
        <span v-if="serialState.error.value" class="error-hint">{{ serialState.error.value }}</span>
        <span
          v-if="serialState.totalDroppedBytes.value > 0"
          class="drop-hint"
          :title="t('session.dropped.title', { count: serialState.totalDroppedBytes.value })"
        >
          {{ t('session.dropped', { bytes: formatBytes(serialState.totalDroppedBytes.value) }) }}
        </span>
      </div>
      <div class="toolbar-right">
        <div class="toolbar-field">
          <FileText class="icon-sm field-icon" />
          <span class="field-label">{{ t('toolbar.format') }}</span>
          <n-select
            :value="appStore.displayMode"
            :options="displayModeOptions"
            size="small"
            style="width: 112px"
            @update:value="appStore.setDisplayMode"
          />
        </div>
        <div class="toggle-group" role="group" :aria-label="t('toolbar.displayOptions')">
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.autoScroll ? 'primary' : 'default'"
            :title="t('toolbar.autoScroll')"
            :aria-label="t('toolbar.autoScroll')"
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
            :type="viewMode === 'terminal' ? 'primary' : 'default'"
            :title="t('toolbar.terminal')"
            :aria-label="t('toolbar.terminal')"
            @click="viewMode = 'terminal'"
          >
            <template #icon>
              <TerminalSquare class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'waveform' ? 'primary' : 'default'"
            :title="t('toolbar.waveform.title')"
            :aria-label="t('toolbar.waveform')"
            @click="viewMode = 'waveform'"
          >
            <template #icon>
              <LineChart class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'parser' ? 'primary' : 'default'"
            :title="t('toolbar.parser.title')"
            :aria-label="t('toolbar.parser')"
            @click="viewMode = 'parser'"
          >
            <template #icon>
              <Binary class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'modbus' ? 'primary' : 'default'"
            :title="t('modbus.title')"
            :aria-label="t('modbus.title')"
            @click="viewMode = 'modbus'"
          >
            <template #icon>
              <Cpu class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.ansiColorEnabled ? 'primary' : 'default'"
            :title="t('toolbar.ansiColor.render')"
            :aria-label="t('toolbar.ansiColor')"
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
            :title="t('toolbar.timestamp')"
            :aria-label="t('toolbar.timestamp')"
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
            :title="
              session.autoLogEnabled && session.logPath
                ? t('toolbar.autoLog.on', { path: session.logPath })
                : t('toolbar.autoLog.off')
            "
            :aria-label="t('toolbar.autoLog')"
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
            :title="t('toolbar.exportData')"
          >
            <template #icon>
              <Download class="icon-sm" />
            </template>
            {{ t('toolbar.export') }}
          </n-button>
        </n-dropdown>
      </div>
    </div>
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
        :frames="session.frames"
        direction="RX"
        :mode="session.waveformSourceMode"
        :channel-labels="waveformChannelLabels"
        @toggle-mode="toggleWaveformSourceMode"
      />
      <ModbusPanel
        v-else-if="viewMode === 'modbus'"
        :session-id="session.id"
        :config="session.modbusConfig"
        :registers="session.modbusRegisters"
        :is-connected="session.isConnected"
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
        :session-id="session.id"
        :frames="session.frames"
        @close="viewMode = 'terminal'"
      />
      <DataPacketList v-else :frames="session.frames" :highlights="session.highlights" />
    </div>
    <div class="send-area">
      <SendPanel
        :on-send="handleSend"
        :session-id="props.session.id"
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
import { NButton, NTag, NDropdown, NSelect } from 'naive-ui';
import {
  ArrowDownUp,
  Binary,
  Clock,
  Cpu,
  Download,
  FileText,
  LineChart,
  Palette,
  Pause,
  Play,
  TerminalSquare,
  Power,
  PowerOff,
  Trash2,
  Unplug,
} from 'lucide-vue-next';
import DataPacketList from '../terminal/DataPacketList.vue';
import WaveformPanel from '../terminal/WaveformPanel.vue';
import ParserPanel from '../terminal/ParserPanel.vue';
import ModbusPanel from '../terminal/ModbusPanel.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import { useSerialConnection } from '../../composables/useSerialConnection';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useModbusMaster } from '../../composables/useModbusMaster';
import { parseStream, type ModbusStreamRecord } from '../../lib/modbus-stream';
import { useExport } from '../../composables/useExport';
import { useAutoLog } from '../../composables/useAutoLog';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionShortcuts } from '../../composables/useSessionShortcuts';
import { useTriggers } from '../../composables/useTriggers';
import { useMessage } from 'naive-ui';
import { EXPORT_OPTIONS, type ExportChoice } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { DisplayMode, ModbusRegister, SerialSession } from '../../types';

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

const displayModeOptions: { label: string; value: DisplayMode }[] = [
  { label: 'HEX', value: 'HEX' },
  { label: 'ASCII', value: 'ASCII' },
  { label: 'ANSI', value: 'ANSI' },
  { label: 'UTF-8', value: 'UTF8' },
];

const exportOptions = computed(() =>
  EXPORT_OPTIONS.map((option) => ({
    ...option,
    label: t(`export.${option.key}`),
  })),
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
const viewMode = ref<'terminal' | 'waveform' | 'parser' | 'modbus'>('terminal');

// --- Modbus master ---------------------------------------------------------
// One master per session. It owns the poll loop (READ mode) and the imperative
// read/write API the register table calls. Decoded samples route into the
// waveform when its source mode is 'register'. The master shares the serial
// port via serialState.sendBytes / serialState.rawBytes (serialized TX, raw RX).
const modbusConfigRef = computed(() => props.session.modbusConfig);
const modbusRegistersRef = computed(() => props.session.modbusRegisters);
const waveformRef = ref<{ pushRegisterSample: (channel: number, value: number) => void } | null>(
  null,
);
const modbusBusy = ref(false);
const modbusStatus = ref<{ kind: string; code?: number; count?: number; remaining?: number }>({
  kind: 'idle',
});

const master = useModbusMaster({
  sessionId: props.session.id,
  config: modbusConfigRef,
  registers: modbusRegistersRef,
  sendBytes: (payload) => serialState.sendBytes(payload),
  rawBytes: (cb) => serialState.rawBytes(cb),
  isConnected: serialState.isConnected,
  onSamples: (samples) => {
    if (props.session.waveformSourceMode !== 'register') return;
    for (const s of samples) {
      if (s.channel === null) continue;
      waveformRef.value?.pushRegisterSample(s.channel, s.value);
    }
  },
  onStatus: (s) => {
    modbusStatus.value = {
      kind: s.kind,
      code: 'code' in s ? s.code : undefined,
      count: 'count' in s ? s.count : undefined,
      remaining: 'remaining' in s ? s.remaining : undefined,
    };
  },
});

const modbusStatusText = computed(() => {
  const s = modbusStatus.value;
  if (s.kind === 'polling') return t('modbus.status.polling', { count: s.count ?? 0 });
  if (s.kind === 'writing') return t('modbus.status.writing', { count: s.count ?? 0 });
  if (s.kind === 'timeout') return t('modbus.status.timeout');
  if (s.kind === 'exception') return t('modbus.status.exception', { code: s.code ?? 0 });
  if (s.kind === 'crc-error') return t('modbus.status.crcError');
  if (s.kind === 'replaying') return t('modbus.status.replaying', { remaining: s.remaining ?? 0 });
  return t('modbus.status.idle');
});
const modbusStatusClass = computed(() => modbusStatus.value.kind);

// Per-channel labels for register-mode waveform (channel index → register name).
const waveformChannelLabels = computed(() => {
  const labels: Record<number, string> = {};
  for (const reg of props.session.modbusRegisters) {
    if (reg.waveformChannel !== null && reg.waveformChannel >= 0) {
      labels[reg.waveformChannel] = reg.name;
    }
  }
  return labels;
});

function toggleWaveformSourceMode() {
  const next = props.session.waveformSourceMode === 'register' ? 'text' : 'register';
  sessionStore.setWaveformSourceMode(props.session.id, next);
}

async function onModbusReadAll() {
  modbusBusy.value = true;
  try {
    // Batched sweep: contiguous rows share one FC03/04 request, serialized
    // against the poll loop via the master's busy guard.
    await master.readAll();
  } finally {
    modbusBusy.value = false;
  }
}
async function onModbusReadRow(reg: ModbusRegister) {
  modbusBusy.value = true;
  try {
    await master.readOnce(reg);
  } finally {
    modbusBusy.value = false;
  }
}
async function onModbusSendAll() {
  modbusBusy.value = true;
  try {
    const res = await master.sendAll();
    if (res.sent > 0) {
      message.success(t('modbus.sendAll') + ` (${res.ok}/${res.sent})`);
    }
  } finally {
    modbusBusy.value = false;
  }
}
async function onModbusSendRow(reg: ModbusRegister) {
  modbusBusy.value = true;
  try {
    const ok = await master.sendRow(reg);
    if (!ok) message.warning(t('modbus.send'));
  } finally {
    modbusBusy.value = false;
  }
}
function onModbusReplay(records: ModbusStreamRecord[]) {
  master.startReplay(records);
}
function onModbusStopReplay() {
  master.stopReplay();
}

// --- Periodic-write data source (.bbreg) ---
// The source is parsed here then handed to the master, which groups records
// into per-(slave,writeFc,addr) value sequences. The filename is shown in the
// ModbusPanel timing bar so the user can see what's loaded.
const writeSourceInput = ref<HTMLInputElement | null>(null);
const writeSourceName = ref<string | null>(null);

function onPickWriteSource() {
  writeSourceInput.value?.click();
}
function onLoadWriteSource(records: ModbusStreamRecord[], name: string) {
  master.loadWriteSource(records, name);
  writeSourceName.value = name;
  message.success(t('modbus.writeSourceLoaded', { count: records.length, name }));
}
function onClearWriteSource() {
  master.clearWriteSource();
  writeSourceName.value = null;
}
function onWriteSourcePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? '');
    const records = parseStream(text);
    if (records.length === 0) {
      message.warning(t('modbus.empty'));
      return;
    }
    onLoadWriteSource(records, file.name);
  };
  reader.readAsText(file);
  input.value = ''; // allow re-picking the same file
}
/** Plot-in-waveform: assign a channel, set source mode, jump to the waveform. */
function onPlotInWaveform(reg: ModbusRegister) {
  let ch = reg.waveformChannel;
  if (ch === null) {
    // Assign the next free channel (0..7).
    const used = new Set(
      props.session.modbusRegisters
        .map((r) => r.waveformChannel)
        .filter((c): c is number => c !== null),
    );
    ch = -1;
    for (let i = 0; i < 8; i += 1) {
      if (!used.has(i)) {
        ch = i;
        break;
      }
    }
    if (ch < 0) return; // all channels taken
    sessionStore.updateModbusRegister(props.session.id, reg.id, { waveformChannel: ch });
  }
  sessionStore.setWaveformSourceMode(props.session.id, 'register');
  viewMode.value = 'waveform';
}
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
  flex-wrap: wrap;
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

.toolbar-stats {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.mini-stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 7px;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mini-stat.tx {
  color: var(--accent-green);
  background: var(--accent-green-subtle);
}

.mini-stat.rx {
  color: var(--accent-blue);
  background: var(--accent-blue-subtle);
}

.mini-label {
  color: var(--text-dim);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 700;
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
