<!--
  Session toolbar: the connection controls + display/view/format toggles.
  Extracted from SessionView (T3.1) so SessionView stays a thin layout
  orchestrator. The toolbar is purely presentational: it receives the reactive
  state it needs (serialState refs, the session, appStore flags, viewMode,
  isExporting) and emits one event per action — no business logic lives here.
-->
<template>
  <div class="session-toolbar">
    <div class="toolbar-cluster connection-cluster">
      <div class="toolbar-actions">
        <n-button
          v-if="!isConnected"
          type="primary"
          size="small"
          :loading="isConnecting"
          @click="$emit('connect')"
        >
          <template #icon>
            <Power class="icon-sm" />
          </template>
          {{ t('session.connect') }}
        </n-button>
        <n-button v-else type="error" size="small" ghost @click="$emit('disconnect')">
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
          v-if="session.isConnected"
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
          v-if="session.isConnected"
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
        <n-tag v-if="reconnecting" type="warning" size="small" round :bordered="false">
          {{ t('session.reconnecting') }}
        </n-tag>
        <span v-if="error" class="error-hint">{{ error }}</span>
        <span
          v-if="totalDroppedBytes > 0"
          class="drop-hint"
          :title="t('session.dropped.title', { count: totalDroppedBytes })"
        >
          {{ t('session.dropped', { bytes: formatBytes(totalDroppedBytes) }) }}
        </span>
      </div>
    </div>

    <div class="toolbar-cluster display-cluster">
      <div class="toolbar-format">
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
            @click="$emit('update:viewMode', 'modbus')"
          >
            <template #icon>
              <Cpu class="icon-sm" />
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
            @click="$emit('toggle-auto-log')"
          >
            <template #icon>
              <FileText class="icon-sm" />
            </template>
          </n-button>
          <n-dropdown
            :options="exportOptions"
            :disabled="session.frames.length === 0 || isExporting"
            @select="(key: string) => $emit('export', key)"
          >
            <n-button
              class="toolbar-export-btn"
              size="small"
              quaternary
              :disabled="session.frames.length === 0"
              :loading="isExporting"
              :title="t('toolbar.exportData')"
            >
              <template #icon>
                <Download class="icon-sm" />
              </template>
            </n-button>
          </n-dropdown>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
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
import { useAppStore } from '../../stores/app';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { DisplayMode, SerialSession } from '../../types';

export type SessionViewMode = 'terminal' | 'waveform' | 'parser' | 'modbus';

defineProps<{
  session: SerialSession;
  isConnected: boolean;
  isConnecting: boolean;
  reconnecting: boolean;
  error: string | null;
  totalDroppedBytes: number;
  sendingBreak: boolean;
  isExporting: boolean;
  viewMode: SessionViewMode;
  exportOptions: { label: string; key: string }[];
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
  export: [string];
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
  padding: 8px 12px;
  display: grid;
  grid-template-columns: minmax(320px, 1fr) auto;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  min-height: var(--toolbar-height);
  flex-shrink: 0;
  gap: 8px 12px;
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
  gap: 8px 10px;
  justify-self: start;
}

.display-cluster {
  justify-self: end;
  justify-content: flex-end;
  flex-wrap: wrap;
  /* Match connection-cluster's row gap for a single toolbar rhythm. */
  gap: 8px;
  padding: 4px;
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
  gap: 6px;
}

.toolbar-actions {
  gap: 8px;
}

.toolbar-format {
  flex: 0 0 auto;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-toggle-sections {
  display: inline-flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  flex-wrap: nowrap;
  justify-content: flex-end;
  padding: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.toggle-group {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
}

.view-toggle-group {
  padding-right: 6px;
  margin-right: 6px;
  border-right: 1px solid var(--border-subtle);
}

.settings-toggle-group {
  background: transparent;
}

.toolbar-export-btn {
  width: 30px;
  white-space: nowrap;
}

.toolbar-field {
  height: 30px;
  padding: 0 4px 0 6px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
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

@media (min-width: 1260px) {
  .session-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

@media (max-width: 1100px) {
  .session-toolbar {
    grid-template-columns: minmax(0, 1fr);
    gap: 7px 10px;
  }

  .display-cluster {
    justify-self: stretch;
    justify-content: flex-start;
  }

  .toolbar-toggle-sections {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
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

/* U-a (T3.3): on very narrow screens the toolbar switches to horizontal
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
