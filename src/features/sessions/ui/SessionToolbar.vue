<!--
  Session toolbar: the connection controls + display/view/format toggles.
  Extracted from SessionView so SessionView stays a thin layout
  orchestrator. The toolbar is purely presentational: it receives the reactive
  state it needs (serialState refs, the session, appStore flags, viewMode,
  isExporting) and emits one event per action — no business logic lives here.
-->
<template>
  <div class="session-toolbar">
    <div class="toolbar-cluster connection-cluster">
      <div class="toolbar-actions">
        <n-button v-if="needsRebind" type="warning" size="small" @click="$emit('rebind')">
          <template #icon>
            <Cable class="icon-sm" />
          </template>
          {{ t('session.rebind') }}
        </n-button>
        <n-button
          v-else-if="!isConnected"
          type="primary"
          size="small"
          :loading="isConnecting"
          :disabled="connectionLocked"
          @click="$emit('connect')"
        >
          <template #icon>
            <Power class="icon-sm" />
          </template>
          {{ t('session.connect') }}
        </n-button>
        <n-button
          v-else
          type="error"
          size="small"
          ghost
          :disabled="connectionLocked"
          @click="$emit('disconnect')"
        >
          <template #icon>
            <PowerOff class="icon-sm" />
          </template>
          {{ t('session.disconnect') }}
        </n-button>
        <n-button size="small" :disabled="session.frames.length === 0" @click="$emit('clear')">
          <template #icon>
            <Trash2 class="icon-sm" />
          </template>
          {{ t('session.clear') }}
        </n-button>
        <n-button
          v-if="isConnected"
          size="small"
          ghost
          :type="session.capturePaused ? 'warning' : 'default'"
          :title="session.capturePaused ? t('session.resume.title') : t('session.pause.title')"
          @click="$emit('toggle-pause')"
        >
          <template #icon>
            <Pause v-if="!session.capturePaused" class="icon-sm" />
            <Play v-else class="icon-sm" />
          </template>
          {{ session.capturePaused ? t('session.resume') : t('session.pause') }}
        </n-button>
        <n-button
          v-if="isConnected"
          size="small"
          ghost
          :loading="sendingBreak"
          :title="t('session.break.title')"
          @click="$emit('send-break')"
        >
          <template #icon>
            <Unplug class="icon-sm" />
          </template>
          {{ t('session.break') }}
        </n-button>
      </div>

      <div class="toolbar-feedback">
        <span v-if="needsRebind" class="rebind-hint">{{ t('session.rebindRequired') }}</span>
        <n-tag v-if="reconnecting" type="warning" size="small" round :bordered="false">
          {{ t('session.reconnecting') }}
        </n-tag>
        <span v-if="error" class="error-hint">{{ error }}</span>
        <button
          v-if="connectionConflict"
          class="conflict-action"
          type="button"
          @click="$emit('show-conflicting-session', connectionConflict.ownerSessionId)"
        >
          {{ connectionConflict.ownerSessionName }}
        </button>
      </div>
    </div>

    <div class="toolbar-cluster display-cluster">
      <div class="toolbar-format">
        <div class="toolbar-field">
          <FileText class="icon-sm field-icon" />
          <span class="field-label">{{ t('toolbar.format') }}</span>
          <AppSelect
            :value="appStore.displayMode"
            :aria-label="t('toolbar.format')"
            :options="displayModeOptions"
            size="small"
            style="width: var(--control-w-lg)"
            @update:value="appStore.setDisplayMode"
          />
        </div>
      </div>
      <div class="toolbar-toggle-sections" :aria-label="t('toolbar.displayOptions')">
        <div
          class="toggle-group view-toggle-group"
          role="group"
          :aria-label="t('toolbar.viewSwitch')"
        >
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'terminal' ? 'primary' : 'default'"
            :title="t('toolbar.terminal')"
            :aria-label="t('toolbar.terminal')"
            :aria-pressed="viewMode === 'terminal'"
            @click="$emit('update:viewMode', 'terminal')"
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
            :aria-pressed="viewMode === 'waveform'"
            @click="$emit('update:viewMode', 'waveform')"
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
            :aria-pressed="viewMode === 'parser'"
            @click="$emit('update:viewMode', 'parser')"
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
            :aria-pressed="viewMode === 'modbus'"
            @click="$emit('update:viewMode', 'modbus')"
          >
            <template #icon>
              <Cpu class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'shell' ? 'primary' : 'default'"
            :title="t('toolbar.shell.title')"
            :aria-label="t('toolbar.shell')"
            :aria-pressed="viewMode === 'shell'"
            @click="$emit('update:viewMode', 'shell')"
          >
            <template #icon>
              <Keyboard class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="viewMode === 'mcumgr' ? 'primary' : 'default'"
            :title="t('toolbar.mcumgr.title')"
            :aria-label="t('toolbar.mcumgr')"
            :aria-pressed="viewMode === 'mcumgr'"
            @click="$emit('update:viewMode', 'mcumgr')"
          >
            <template #icon>
              <MemoryStick class="icon-sm" />
            </template>
          </n-button>
        </div>
        <div
          class="toggle-group settings-toggle-group"
          role="group"
          :aria-label="t('toolbar.functionSettings')"
        >
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.autoScroll ? 'primary' : 'default'"
            :title="t('toolbar.autoScroll')"
            :aria-label="t('toolbar.autoScroll')"
            :aria-pressed="appStore.autoScroll"
            @click="$emit('toggle-auto-scroll')"
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
            :aria-pressed="appStore.ansiColorEnabled"
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
            :type="appStore.preserveLogLineBreaks ? 'primary' : 'default'"
            :title="t('toolbar.logLineBreaks.title')"
            :aria-label="t('toolbar.logLineBreaks')"
            :aria-pressed="appStore.preserveLogLineBreaks"
            @click="appStore.toggleLogLineBreaks"
          >
            <template #icon>
              <WrapText class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.softWrapEnabled ? 'primary' : 'default'"
            :title="t('toolbar.softWrap.title')"
            :aria-label="t('toolbar.softWrap')"
            :aria-pressed="appStore.softWrapEnabled"
            @click="appStore.toggleSoftWrap"
          >
            <template #icon>
              <AlignJustify class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toggle-btn"
            size="small"
            quaternary
            :type="appStore.showTimestamp ? 'primary' : 'default'"
            :title="t('toolbar.timestamp')"
            :aria-label="t('toolbar.timestamp')"
            :aria-pressed="appStore.showTimestamp"
            @click="$emit('toggle-timestamp')"
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
            :aria-pressed="session.autoLogEnabled"
            @click="$emit('toggle-auto-log')"
          >
            <template #icon>
              <FileText class="icon-sm" />
            </template>
          </n-button>
          <n-button
            class="toolbar-export-btn"
            size="small"
            quaternary
            :disabled="session.frames.length === 0"
            :loading="isExporting"
            :title="t('toolbar.exportData')"
            @click="$emit('export')"
          >
            <template #icon>
              <Download class="icon-sm" />
            </template>
          </n-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NButton, NTag } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import {
  AlignJustify,
  ArrowDownUp,
  Binary,
  Cable,
  Clock,
  Cpu,
  Download,
  FileText,
  Keyboard,
  LineChart,
  MemoryStick,
  Palette,
  Pause,
  Play,
  TerminalSquare,
  Power,
  PowerOff,
  Trash2,
  Unplug,
  WrapText,
} from '@lucide/vue';
import { useAppStore } from '@/features/settings/store/app-store';
import { t } from '@/lib/i18n';
import type { DisplayMode, SerialSession } from '@/types';
import type { PortLeaseConflict } from '@/generated/ipc-contracts';

export type SessionViewMode = 'terminal' | 'waveform' | 'parser' | 'modbus' | 'shell' | 'mcumgr';

defineProps<{
  session: SerialSession;
  /** Per-session invalidation pulse for the raw frame arrays. */
  framesVersion: number;
  isConnected: boolean;
  isConnecting: boolean;
  reconnecting: boolean;
  error: string | null;
  connectionConflict?: Readonly<PortLeaseConflict>;
  needsRebind?: boolean;
  sendingBreak: boolean;
  isExporting: boolean;
  viewMode: SessionViewMode;
  /** True while MCUmgr owns the port; connect/disconnect must stay locked. */
  connectionLocked?: boolean;
}>();

defineEmits<{
  connect: [];
  disconnect: [];
  clear: [];
  'toggle-pause': [];
  'send-break': [];
  'update:viewMode': [SessionViewMode];
  'toggle-auto-scroll': [];
  'toggle-timestamp': [];
  'toggle-auto-log': [];
  export: [];
  'show-conflicting-session': [sessionId: string];
  rebind: [];
}>();

const appStore = useAppStore();

const displayModeOptions: { label: string; value: DisplayMode }[] = [
  { label: 'HEX', value: 'HEX' },
  { label: 'HEX+ASCII', value: 'HEXASCII' },
  { label: 'ASCII', value: 'ASCII' },
  { label: 'ANSI', value: 'ANSI' },
  { label: 'UTF-8', value: 'UTF8' },
];
</script>

<style scoped>
.session-toolbar {
  padding: var(--space-sm) var(--space-md);
  display: grid;
  grid-template-columns: minmax(320px, 1fr) auto;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  min-height: var(--toolbar-height);
  flex-shrink: 0;
  gap: var(--space-sm) var(--space-md);
}

.toolbar-cluster {
  display: flex;
  align-items: center;
  min-width: 0;
}

.connection-cluster {
  flex-wrap: wrap;
  /* Row/column gap matches the display-cluster below so both toolbar halves
     share one spacing rhythm rather than two subtly different ones. */
  gap: var(--space-sm);
  justify-self: start;
}

.display-cluster {
  justify-self: end;
  justify-content: flex-end;
  flex-wrap: wrap;
  /* Match connection-cluster's row gap for a single toolbar rhythm. */
  gap: var(--space-sm);
  padding: var(--space-xs);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-inset);
}

.toolbar-actions,
.toolbar-feedback {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}

.toolbar-feedback {
  gap: var(--space-sm);
}

.toolbar-actions {
  gap: var(--space-sm);
}

.toolbar-format {
  flex: 0 0 auto;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  height: 30px;
  padding: 0 var(--space-xs) 0 var(--space-sm);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
}

.toolbar-toggle-sections {
  display: inline-flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  flex-wrap: nowrap;
  justify-content: flex-end;
  padding: var(--space-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.toggle-group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
}

.view-toggle-group {
  padding-right: var(--space-sm);
  margin-right: var(--space-sm);
  border-right: 1px solid var(--border-subtle);
}

.settings-toggle-group {
  background: transparent;
}

.toolbar-export-btn {
  width: 30px;
  white-space: nowrap;
}

.field-icon {
  color: var(--text-dim);
}

.field-label {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.error-hint {
  color: var(--accent-red);
  font-size: var(--font-size-sm);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: var(--space-2xs) var(--space-sm);
  background: var(--accent-red-subtle);
  border: 1px solid var(--accent-red-border);
  border-radius: var(--radius-full);
}

.conflict-action {
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid var(--border-focus);
  border-radius: var(--radius-full);
  color: var(--color-primary);
  background: transparent;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.conflict-action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.drop-hint {
  color: var(--accent-amber);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  padding: var(--space-2xs) var(--space-sm);
  background: var(--accent-amber-subtle);
  border: 1px solid var(--accent-amber-border);
  border-radius: var(--radius-full);
}

@media (min-width: 1260px) {
  .session-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

/* Single-column stack: both clusters stretch and left-align. This merges the
   former 1100px and 900px blocks, whose rules were near-identical. */
@media (max-width: 1100px) {
  .session-toolbar {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }

  .connection-cluster,
  .display-cluster {
    justify-self: stretch;
    justify-content: flex-start;
  }

  .toolbar-toggle-sections {
    justify-content: flex-start;
  }
}

/* On very narrow screens the toolbar switches to horizontal
   scroll rather than wrapping/clipping, so no controls are hidden. */
@media (max-width: 600px) {
  .session-toolbar {
    grid-template-columns: auto auto;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .connection-cluster,
  .display-cluster {
    flex-wrap: nowrap;
  }
}
</style>
