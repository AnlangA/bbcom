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
            :type="showWaveform ? 'primary' : 'default'"
            :title="t('toolbar.waveform.title')"
            :aria-label="t('toolbar.waveform')"
            @click="showWaveform = !showWaveform"
          >
            <template #icon>
              <LineChart class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="showParser ? 'primary' : 'default'"
            :title="t('toolbar.parser.title')"
            :aria-label="t('toolbar.parser')"
            @click="showParser = !showParser"
          >
            <template #icon>
              <Binary class="icon-sm" />
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
      <WaveformPanel v-if="showWaveform" :frames="session.frames" direction="RX" />
      <ParserPanel
        v-if="showParser"
        :session-id="session.id"
        :frames="session.frames"
        @close="showParser = false"
      />
      <DataPacketList :frames="session.frames" :highlights="session.highlights" />
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NTag, NDropdown, NSelect } from 'naive-ui';
import {
  ArrowDownUp,
  Binary,
  Clock,
  Download,
  FileText,
  LineChart,
  Palette,
  Pause,
  Play,
  Power,
  PowerOff,
  Trash2,
  Unplug,
} from 'lucide-vue-next';
import DataPacketList from '../terminal/DataPacketList.vue';
import WaveformPanel from '../terminal/WaveformPanel.vue';
import ParserPanel from '../terminal/ParserPanel.vue';
import SendPanel from '../send-panel/SendPanel.vue';
import { useSerialConnection } from '../../composables/useSerialConnection';
import { useSessionStore } from '../../stores/sessions';
import { useAppStore } from '../../stores/app';
import { useExport } from '../../composables/useExport';
import { useAutoLog } from '../../composables/useAutoLog';
import { useSessionActions } from '../../composables/useSessionActions';
import { useSessionShortcuts } from '../../composables/useSessionShortcuts';
import { useTriggers } from '../../composables/useTriggers';
import { useMessage } from 'naive-ui';
import { EXPORT_OPTIONS, type ExportChoice } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
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
// Waveform overlay — toggled from the toolbar. Off by default so it only parses
// RX data when the user wants a plot, keeping the default terminal view dense.
const showWaveform = ref(false);
// Protocol parser overlay — splits the RX byte stream into discrete frames per
// a delimiter / fixed-length / length-field template.
const showParser = ref(false);
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
