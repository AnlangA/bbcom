<template>
  <div class="session-toolbar">
    <div class="toolbar-primary">
      <SessionConnectionControls
        :is-connected="isConnected"
        :is-connecting="isConnecting"
        :is-closing="isClosing"
        :close-failed="closeFailed"
        :reconnecting="reconnecting"
        :needs-rebind="needsRebind"
        :connection-locked="connectionLocked"
        :baud-rate="session.portConfig.baudRate"
        :capture-paused="captureIsPaused"
        :can-clear="captureCanClear"
        :sending-break="sendingBreak"
        :reconfiguring="reconfiguring"
        :settings-disabled="settingsDisabled"
        @connect="$emit('connect')"
        @disconnect="$emit('disconnect')"
        @rebind="$emit('rebind')"
        @clear="$emit('clear')"
        @toggle-pause="$emit('toggle-pause')"
        @send-break="$emit('send-break')"
        @settings="$emit('settings')"
      />
      <div class="toolbar-file-actions">
        <div class="toolbar-field">
          <span class="field-label">{{ t('toolbar.format') }}</span>
          <AppSelect
            :value="appStore.displayMode"
            :aria-label="t('toolbar.format')"
            :options="displayModeOptions"
            size="small"
            class="format-select"
            @update:value="appStore.setDisplayMode"
          />
        </div>
        <n-button
          class="toolbar-export-btn"
          size="small"
          :disabled="captureFrames === 0"
          :loading="isExporting"
          :title="t('toolbar.exportData')"
          :aria-label="t('toolbar.exportData')"
          @click="$emit('export')"
        >
          <template #icon><Download class="icon-sm" /></template>
        </n-button>
      </div>
    </div>

    <div
      v-if="needsRebind || error || connectionConflict"
      class="toolbar-feedback"
      role="status"
      aria-live="polite"
    >
      <span v-if="needsRebind" class="rebind-hint">{{ t('session.rebindRequired') }}</span>
      <span v-if="error" class="error-hint" :title="error">{{ error }}</span>
      <button
        v-if="connectionConflict"
        class="conflict-action"
        type="button"
        @click="$emit('show-conflicting-session', connectionConflict.ownerSessionId)"
      >
        {{ connectionConflict.ownerSessionName }}
      </button>
    </div>

    <div class="toolbar-navigation">
      <SessionViewSwitcher
        :model-value="viewMode"
        @update:model-value="$emit('update:viewMode', $event)"
      />
      <SessionDisplayControls
        :auto-scroll="appStore.autoScroll"
        :ansi-color="appStore.ansiColorEnabled"
        :line-breaks="appStore.preserveLogLineBreaks"
        :soft-wrap="appStore.softWrapEnabled"
        :timestamp="appStore.showTimestamp"
        :auto-log="session.autoLogEnabled"
        :log-path="session.logPath"
        @toggle="toggleDisplayControl"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import { Download } from '@lucide/vue';
import AppSelect from '@/design-system/AppSelect.vue';
import { useAppStore } from '@/features/settings/store/app-store';
import { sessionHasClearableCapture } from '@/lib/session-store-helpers';
import { t } from '@/lib/i18n';
import type { DisplayMode, SerialSession } from '@/types';
import type { PortLeaseConflict } from '@/generated/ipc-contracts';
import SessionConnectionControls from './SessionConnectionControls.vue';
import SessionDisplayControls, { type DisplayControlAction } from './SessionDisplayControls.vue';
import SessionViewSwitcher from './SessionViewSwitcher.vue';
import type { SessionViewMode } from './session-view-mode';

export type { SessionViewMode } from './session-view-mode';

const props = withDefaults(
  defineProps<{
    session: SerialSession;
    capturePaused?: boolean;
    captureFrameCount?: number;
    captureHasData?: boolean;
    isConnected: boolean;
    isConnecting: boolean;
    isClosing?: boolean;
    closeFailed?: boolean;
    reconnecting: boolean;
    error: string | null;
    connectionConflict?: Readonly<PortLeaseConflict>;
    needsRebind?: boolean;
    sendingBreak: boolean;
    isExporting: boolean;
    viewMode: SessionViewMode;
    /** True while MCUmgr owns the port; connection controls must stay locked. */
    connectionLocked?: boolean;
    reconfiguring?: boolean;
    settingsDisabled?: boolean;
  }>(),
  { captureHasData: undefined, capturePaused: undefined },
);

const emit = defineEmits<{
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
  settings: [];
}>();

const appStore = useAppStore();
const captureIsPaused = computed(() => props.capturePaused ?? props.session.capturePaused);
const captureFrames = computed(() => props.captureFrameCount ?? props.session.frames.length);
const captureCanClear = computed(
  () =>
    props.captureHasData ?? (captureFrames.value > 0 || sessionHasClearableCapture(props.session)),
);

const displayModeOptions: { label: string; value: DisplayMode }[] = [
  { label: 'HEX', value: 'HEX' },
  { label: 'HEX+ASCII', value: 'HEXASCII' },
  { label: 'ASCII', value: 'ASCII' },
  { label: 'ANSI', value: 'ANSI' },
  { label: 'UTF-8', value: 'UTF8' },
];

// The toolbar adapts application settings to presentational controls. Children
// only receive values and emit intent, so neither owns a store or a runtime.
function toggleDisplayControl(action: DisplayControlAction): void {
  switch (action) {
    case 'auto-scroll':
      emit('toggle-auto-scroll');
      break;
    case 'ansi-color':
      appStore.toggleAnsiColor();
      break;
    case 'line-breaks':
      appStore.toggleLogLineBreaks();
      break;
    case 'soft-wrap':
      appStore.toggleSoftWrap();
      break;
    case 'timestamp':
      emit('toggle-timestamp');
      break;
    case 'auto-log':
      emit('toggle-auto-log');
      break;
  }
}
</script>

<style scoped>
.session-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  flex-shrink: 0;
  min-width: 0;
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
}

.toolbar-primary,
.toolbar-navigation,
.toolbar-file-actions,
.toolbar-field {
  display: flex;
  align-items: center;
  min-width: 0;
}

.toolbar-primary,
.toolbar-navigation {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-sm) var(--space-md);
}

.toolbar-file-actions {
  gap: var(--space-sm);
  margin-left: auto;
}

.toolbar-field {
  gap: var(--space-sm);
}

.field-label {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.format-select {
  width: var(--control-w-lg);
}

.toolbar-export-btn {
  width: var(--control-h-md);
}

.toolbar-feedback {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-sm);
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--accent-amber-border);
  border-radius: var(--radius-sm);
  background: var(--accent-amber-subtle);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.error-hint {
  color: var(--accent-red);
}

.rebind-hint {
  color: var(--accent-amber);
}

.conflict-action {
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid var(--border-focus);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  background: var(--bg-secondary);
  font-size: inherit;
  cursor: pointer;
}

.conflict-action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
