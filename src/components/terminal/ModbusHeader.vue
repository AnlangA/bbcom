<!--
  Modbus panel header: identity + transport + master enable + status, the
  timing inputs (poll/write/timeout + write-source), and the action buttons
  (read-all / send-all / replay / load / save). Extracted from ModbusPanel
  so the panel stays under 400 lines. Presentational: receives config + flags,
  emits one event per action and a `patch` event for config edits.
-->
<template>
  <div>
    <!-- Header row 1: identity + transport + master enable + status -->
    <div class="mb-header">
      <span class="mb-title">
        <Cpu class="icon-sm" />
        {{ t('modbus.title') }}
      </span>
      <AppSelect
        :value="config.transport"
        :aria-label="t('modbus.transport')"
        :options="transportOptions"
        size="tiny"
        style="width: 168px"
        @update:value="(v) => $emit('patch', { transport: v })"
      />
      <n-checkbox
        :checked="config.enabled"
        size="small"
        @update:checked="(v) => $emit('patch', { enabled: v })"
      >
        {{ t('modbus.master.enable') }}
      </n-checkbox>
      <span
        class="mb-status"
        :class="statusClass"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        >{{ statusText }}</span
      >
      <button
        class="mb-close"
        type="button"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="$emit('close')"
      >
        <X class="icon-sm" />
      </button>
    </div>

    <!-- Header row 2: timing inputs (own row so inputs are never squeezed). -->
    <div class="mb-timing-bar">
      <span class="mb-field-label">{{ t('modbus.pollInterval') }}</span>
      <n-input-number
        :value="config.pollIntervalMs"
        size="tiny"
        :min="100"
        :max="10000"
        :step="100"
        :show-button="false"
        :aria-label="t('modbus.pollInterval')"
        style="width: 124px"
        @update:value="(v) => $emit('patch', { pollIntervalMs: v ?? 1000 })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="mb-field-label">{{ t('modbus.writeInterval') }}</span>
      <n-input-number
        :value="config.writeIntervalMs"
        size="tiny"
        :min="100"
        :max="10000"
        :step="100"
        :show-button="false"
        :aria-label="t('modbus.writeInterval')"
        style="width: 124px"
        @update:value="(v) => $emit('patch', { writeIntervalMs: v ?? 1000 })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="mb-field-label">{{ t('modbus.timeout') }}</span>
      <n-input-number
        :value="config.timeoutMs"
        size="tiny"
        :min="50"
        :max="5000"
        :step="50"
        :show-button="false"
        :aria-label="t('modbus.timeout')"
        style="width: 120px"
        @update:value="(v) => $emit('patch', { timeoutMs: v ?? 500 })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="mb-writesrc">
        <span class="mb-field-label">{{ t('modbus.writeSource') }}</span>
        <n-button size="tiny" quaternary @click="$emit('pick-write-source')">
          <template #icon><FileUp class="icon-sm" /></template>
          {{ writeSourceName ?? t('modbus.writeSourceNone') }}
        </n-button>
        <n-button
          v-if="writeSourceName"
          size="tiny"
          quaternary
          :title="t('modbus.clearWriteSource')"
          @click="$emit('clear-write-source')"
        >
          <template #icon><X class="icon-sm" /></template>
        </n-button>
      </span>
    </div>

    <!-- Header row 3: action buttons -->
    <div class="mb-actions-bar">
      <n-button size="tiny" quaternary :disabled="busy || !isConnected" @click="$emit('read-all')">
        <template #icon><RefreshCw class="icon-sm" /></template>
        {{ t('modbus.readAll') }}
      </n-button>
      <n-button
        v-if="hasWriteRegs"
        size="tiny"
        quaternary
        :disabled="busy || !isConnected"
        @click="$emit('send-all')"
      >
        <template #icon><Send class="icon-sm" /></template>
        {{ t('modbus.sendAll') }}
      </n-button>
      <n-button
        v-if="hasWriteRegs && !replaying"
        size="tiny"
        quaternary
        :disabled="!isConnected"
        @click="$emit('replay')"
      >
        <template #icon><Play class="icon-sm" /></template>
        {{ t('modbus.replay') }}
      </n-button>
      <n-button v-else-if="replaying" size="tiny" type="warning" @click="$emit('stop-replay')">
        <template #icon><Square class="icon-sm" /></template>
        {{ t('modbus.stopReplay') }}
      </n-button>
      <n-button size="tiny" quaternary @click="$emit('load')">
        <template #icon><Upload class="icon-sm" /></template>
        {{ t('modbus.load') }}
      </n-button>
      <n-button size="tiny" quaternary :disabled="registersEmpty" @click="$emit('save')">
        <template #icon><Download class="icon-sm" /></template>
        {{ t('modbus.save') }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NButton, NCheckbox, NInputNumber } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { Cpu, Download, FileUp, Play, RefreshCw, Send, Square, Upload, X } from '@lucide/vue';
import { computed } from 'vue';
import { t } from '../../lib/i18n';
import type { ModbusMasterConfig } from '../../types';

defineProps<{
  config: ModbusMasterConfig;
  statusText: string;
  statusClass: string;
  busy: boolean;
  isConnected: boolean;
  replaying: boolean;
  hasWriteRegs: boolean;
  registersEmpty: boolean;
  writeSourceName: string | null;
}>();

defineEmits<{
  close: [];
  patch: [Partial<ModbusMasterConfig>];
  'pick-write-source': [];
  'clear-write-source': [];
  'read-all': [];
  'send-all': [];
  replay: [];
  'stop-replay': [];
  load: [];
  save: [];
}>();

const transportOptions = computed(() => [
  { label: t('modbus.transport.rtu'), value: 'rtu' },
  { label: t('modbus.transport.pdu'), value: 'pdu' },
]);
</script>

<style scoped>
/* Header row 1: identity + transport + enable + status */
.mb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.mb-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.mb-close {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  margin-left: auto;
}

.mb-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* Header row 2: timing inputs. */
.mb-timing-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.mb-field-label {
  font-size: var(--font-size-sm);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

/* Header row 3: action buttons. */
.mb-actions-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.mb-status {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  margin-left: auto;
}

.mb-status.polling {
  color: var(--accent-blue);
}
.mb-status.writing,
.mb-status.replaying {
  color: var(--accent-green);
}
.mb-status.backoff {
  color: var(--accent-amber);
  background: var(--accent-amber-subtle);
}
.mb-status.timeout,
.mb-status.exception,
.mb-status.crc-error,
.mb-status.error {
  color: var(--accent-red);
  background: var(--accent-red-subtle);
}

.mb-writesrc {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}
</style>
