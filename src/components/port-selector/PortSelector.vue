<template>
  <div class="port-selector">
    <div class="section">
      <button class="section-title" type="button" @click="toggleSection('port')">
        <span class="section-heading">
          <Cable class="icon-sm" />
          {{ t('serial.portSelect') }}
        </span>
        <ChevronRight class="toggle-icon" :class="{ expanded: !collapsed.port }" />
      </button>
      <div class="section-body" :class="{ collapsed: collapsed.port }">
        <div class="port-row">
          <n-select
            v-model:value="selectedPort"
            :options="portOptions"
            :placeholder="t('serial.portPlaceholder')"
            clearable
            size="small"
          />
          <n-button
            size="small"
            @click="refreshPorts"
            :loading="isRefreshing"
            quaternary
            :title="t('serial.refreshPorts')"
          >
            <template #icon>
              <RefreshCw class="icon-sm" />
            </template>
          </n-button>
        </div>
        <div v-if="ports.length === 0" class="empty-hint">{{ t('serial.noPorts') }}</div>
        <div v-if="missingActivePorts.length > 0" class="empty-hint warning">
          {{ t('serial.disconnectedPorts', { ports: missingActivePorts.join(', ') }) }}
        </div>
        <div class="port-action">
          <n-button size="small" block @click="newSession" :disabled="!selectedPort" type="primary">
            <template #icon>
              <Plus class="icon-sm" />
            </template>
            {{ t('common.newSession') }}
          </n-button>
        </div>
      </div>
    </div>

    <div class="section">
      <button class="section-title" type="button" @click="toggleSection('config')">
        <span class="section-heading">
          <Settings2 class="icon-sm" />
          {{ t('serial.params') }}
        </span>
        <ChevronRight class="toggle-icon" :class="{ expanded: !collapsed.config }" />
      </button>
      <div class="section-body" :class="{ collapsed: collapsed.config }">
        <div class="config-grid">
          <div class="config-item">
            <label>{{ t('serial.baudRate') }}</label>
            <n-select v-model:value="config.baudRate" :options="baudRateOptions" size="small" />
          </div>
          <div class="config-item">
            <label>{{ t('serial.dataBits') }}</label>
            <n-select v-model:value="config.dataBits" :options="dataBitsOptions" size="small" />
          </div>
          <div class="config-item">
            <label>{{ t('serial.stopBits') }}</label>
            <n-select v-model:value="config.stopBits" :options="stopBitsOptions" size="small" />
          </div>
          <div class="config-item">
            <label>{{ t('serial.parity') }}</label>
            <n-select v-model:value="config.parity" :options="parityOptions" size="small" />
          </div>
          <div class="config-item">
            <label>{{ t('serial.flowControl') }}</label>
            <n-select
              v-model:value="config.flowControl"
              :options="flowControlOptions"
              size="small"
            />
          </div>
          <div class="config-item config-signals">
            <label>{{ t('serial.signals') }}</label>
            <div class="signals">
              <label class="signal-toggle"
                ><n-switch v-model:value="config.dtr" size="small" /> DTR</label
              >
              <label class="signal-toggle"
                ><n-switch v-model:value="config.rts" size="small" /> RTS</label
              >
            </div>
          </div>
        </div>
        <div class="config-summary" :title="t('serial.summary')">
          <span class="summary-chip">
            <span class="summary-label">{{ t('serial.rate') }}</span>
            {{ config.baudRate }}
          </span>
          <span class="summary-chip">
            <span class="summary-label">{{ t('serial.format') }}</span>
            {{ serialFormatLabel }}
          </span>
          <span class="summary-chip">
            <span class="summary-label">{{ t('serial.flowControl') }}</span>
            {{ flowControlLabel }}
          </span>
          <span class="summary-chip">
            <span class="summary-label">{{ t('serial.signals') }}</span>
            {{ signalSummary }}
          </span>
        </div>
      </div>
    </div>

    <div class="section">
      <button class="section-title" type="button" @click="toggleSection('checksum')">
        <span class="section-heading">
          <Hash class="icon-sm" />
          {{ t('checksum.title') }}
        </span>
        <ChevronRight class="toggle-icon" :class="{ expanded: !collapsed.checksum }" />
      </button>
      <div class="section-body" :class="{ collapsed: collapsed.checksum }">
        <div class="checksum-grid">
          <n-input
            v-model:value="checksumInput"
            :placeholder="t('checksum.placeholder')"
            size="small"
            :status="checksumInput && !isValidHexInput ? 'error' : undefined"
            @blur="normalizeChecksumInput"
          />
          <div class="checksum-meta">
            <span>{{ t('checksum.byteCount', { count: checksumByteCount }) }}</span>
            <span v-if="checksumInput && !isValidHexInput" class="checksum-error">{{
              t('checksum.hexEvenError')
            }}</span>
          </div>
          <div class="checksum-actions">
            <n-select v-model:value="checksumAlgo" :options="checksumAlgoOptions" size="small" />
          </div>
          <div
            v-if="checksumResult"
            class="checksum-result"
            @click="copyChecksum"
            :title="t('checksum.copyTitle')"
          >
            <div>
              <span class="checksum-label">{{ t('checksum.result') }}</span>
              <span class="checksum-algo">{{ checksumAlgoLabel }}</span>
            </div>
            <span class="checksum-value">{{ checksumResult }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch } from 'vue';
import { NSelect, NButton, NInput, NSwitch } from 'naive-ui';
import { Cable, ChevronRight, Hash, Plus, RefreshCw, Settings2 } from 'lucide-vue-next';
import { usePortWatcher } from '../../composables/usePortWatcher';
import { useSerialStore } from '../../stores/serial';
import { useSessionStore } from '../../stores/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import { formatHex, isValidHex, parseHex } from '../../lib/format';
import { calculateChecksum } from '../../lib/ipc';
import { checksumOptions } from '../../lib/checksum-constants';
import { t } from '../../lib/i18n';
import {
  BAUD_RATES,
  DATA_BITS_OPTIONS,
  STOP_BITS_OPTIONS,
  PARITY_OPTIONS,
  FLOW_CONTROL_OPTIONS,
} from '../../lib/constants';
import type { ChecksumType } from '../../types';

const serialStore = useSerialStore();
const sessionStore = useSessionStore();
const { createSession } = useSessionActions();
const { ports, refresh } = usePortWatcher();
const isRefreshing = ref(false);
const missingActivePorts = computed(() =>
  sessionStore.sessions
    .filter((s) => s.isConnected && !ports.value.includes(s.portName))
    .map((s) => s.portName),
);

const collapsed = reactive({
  port: false,
  config: false,
  checksum: true,
});

function toggleSection(key: keyof typeof collapsed) {
  collapsed[key] = !collapsed[key];
}

const selectedPort = computed({
  get: () => serialStore.selectedPort,
  set: (v) => serialStore.setSelectedPort(v),
});

const usedPorts = computed(
  () => new Set(sessionStore.sessions.filter((s) => s.isConnected).map((s) => s.portName)),
);

const portOptions = computed(() =>
  ports.value.map((p) => ({
    label: usedPorts.value.has(p) ? `${p} (${t('serial.inUse')})` : p,
    value: p,
    disabled: usedPorts.value.has(p),
  })),
);

// Auto-select first available port when none is selected
watch(
  () => ports.value,
  (newPorts) => {
    if (!selectedPort.value && newPorts.length > 0) {
      selectedPort.value = newPorts[0];
    }
  },
  { immediate: true },
);

const config = computed(() => serialStore.portConfig);

const parityCode = computed(() => {
  if (config.value.parity === 'odd') return 'O';
  if (config.value.parity === 'even') return 'E';
  return 'N';
});

const serialFormatLabel = computed(
  () => `${config.value.dataBits}${parityCode.value}${config.value.stopBits}`,
);

const flowControlLabel = computed(() => t(`serial.flow.${config.value.flowControl}`));

const signalSummary = computed(() => {
  const signals = [config.value.dtr ? 'DTR' : '', config.value.rts ? 'RTS' : ''].filter(Boolean);
  return signals.join('+') || t('serial.none');
});

async function refreshPorts() {
  isRefreshing.value = true;
  await refresh();
  isRefreshing.value = false;
}

function newSession() {
  if (!selectedPort.value) return;
  createSession(selectedPort.value, { ...serialStore.portConfig });
}

const baudRateOptions = BAUD_RATES;

const dataBitsOptions = DATA_BITS_OPTIONS;

const stopBitsOptions = STOP_BITS_OPTIONS;

const parityOptions = computed(() =>
  PARITY_OPTIONS.map((option) => ({
    ...option,
    label: t(`serial.parity.${option.value}`),
  })),
);

const flowControlOptions = computed(() =>
  FLOW_CONTROL_OPTIONS.map((option) => ({
    ...option,
    label: t(`serial.flow.${option.value}`),
  })),
);

const checksumInput = ref('');
const checksumAlgo = ref<ChecksumType>('CHECKSUM');
const checksumResult = ref('');
let checksumTimer: ReturnType<typeof setTimeout> | null = null;

const checksumAlgoOptions = computed(() =>
  checksumOptions.map((option) => ({
    ...option,
    label: option.value === 'CHECKSUM' ? t('checksum.checksum') : option.label,
  })),
);

const isValidHexInput = computed(() => {
  if (!checksumInput.value.trim()) return true;
  return isValidHex(checksumInput.value);
});

const checksumByteCount = computed(() => {
  const cleaned = checksumInput.value.replace(/[^0-9a-fA-F]/g, '');
  return Math.floor(cleaned.length / 2);
});

const checksumAlgoLabel = computed(
  () =>
    checksumAlgoOptions.value.find((option) => option.value === checksumAlgo.value)?.label ??
    checksumAlgo.value,
);

watch([checksumInput, checksumAlgo], () => {
  if (checksumTimer) clearTimeout(checksumTimer);
  checksumResult.value = '';
  if (!checksumInput.value.trim() || !isValidHexInput.value) return;
  checksumTimer = setTimeout(calcChecksum, 150);
});

async function calcChecksum() {
  if (!checksumInput.value || !isValidHexInput.value) return;
  const data = parseHex(checksumInput.value);
  try {
    const res = await calculateChecksum(data, checksumAlgo.value);
    checksumResult.value = res.result;
  } catch {
    checksumResult.value = t('checksum.failed');
  }
}

function normalizeChecksumInput() {
  if (checksumInput.value.trim() && isValidHexInput.value) {
    checksumInput.value = formatHex(parseHex(checksumInput.value));
  }
}

async function copyChecksum() {
  if (!checksumResult.value || checksumResult.value === t('checksum.failed')) return;
  try {
    await navigator.clipboard.writeText(checksumResult.value);
  } catch {
    // ignore — clipboard may not be available in some environments
  }
}
</script>

<style scoped>
.port-selector {
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 6px;
}

.section {
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-lift);
  box-shadow: var(--shadow-inset);
}

.section-title {
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
  cursor: pointer;
  transition: color var(--transition-normal);
}

.section-title:hover {
  color: var(--text-secondary);
}

.section-title:hover .toggle-icon {
  transform: translateX(2px);
}

.section-title:hover .toggle-icon.expanded {
  transform: translateX(-2px);
}

.section-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toggle-icon {
  width: 13px;
  height: 13px;
  color: var(--text-dim);
  transition: transform var(--transition-normal);
}

.toggle-icon.expanded {
  transform: rotate(90deg);
}

.section-body {
  overflow: hidden;
  /* Generous ceiling so the params section (6 rows + summary chips) never
     gets clipped at small window heights or larger zoom levels. */
  max-height: 640px;
  opacity: 1;
  transition:
    max-height var(--transition-slow),
    opacity var(--transition-normal),
    margin-top var(--transition-normal);
}

.section-body.collapsed {
  max-height: 0;
  opacity: 0;
  margin-top: -10px;
}

.port-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.port-row .n-select {
  flex: 1;
}

.empty-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 9px 8px;
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-color);
}

.empty-hint.warning {
  color: var(--accent-red);
  background: var(--accent-red-subtle);
  border-color: var(--accent-red-border);
}

.port-action {
  margin-top: 10px;
}

.config-grid {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.config-item label {
  font-size: 11px;
  color: var(--text-secondary);
  width: 48px;
  flex-shrink: 0;
  text-align: right;
  font-weight: 500;
}

.config-item .n-select {
  flex: 1;
}

.config-signals .signals {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.signal-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  cursor: pointer;
}

.config-summary {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.summary-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.summary-label {
  color: var(--text-dim);
  font-family: var(--font-sans);
  font-weight: 600;
}

.checksum-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checksum-actions {
  display: flex;
}

.checksum-meta {
  display: flex;
  justify-content: space-between;
  min-height: 16px;
  color: var(--text-dim);
  font-size: 10px;
  font-family: var(--font-mono);
}

.checksum-error {
  color: var(--accent-red);
}

.checksum-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  background: var(--accent-green-subtle);
  border: 1px solid var(--color-primary-muted);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 13px;
  cursor: copy;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.checksum-result:hover {
  border-color: var(--color-primary);
  background: rgba(61, 220, 151, 0.16);
}

.checksum-label {
  color: var(--text-muted);
  font-size: 11px;
}

.checksum-value {
  color: var(--accent-green);
  font-weight: 700;
  letter-spacing: 0.8px;
}

.checksum-algo {
  margin-left: 6px;
  color: var(--text-dim);
  font-size: 10px;
}
</style>
