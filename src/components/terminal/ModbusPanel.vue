<template>
  <div class="modbus-panel">
    <!--
      Modbus register table. Each row is read and/or written based on its
      function code, not a global mode:
      - Read FCs (01-04): show a single Read button + live value readout; opt
        into periodic reads via the R toggle.
      - Write FCs (05/06): show a single Send button + editable value; opt into
        periodic writes via the W toggle (values come from a loaded .bbreg source).
      Periodic reads feed the waveform (rows with a channel assignment). Periodic
      writes push values from the data source, advancing per-row each tick and
      looping. Manual Send/Send all/Replay still write on demand (FC05/06,
      auto-batched into FC0F/FC10 when contiguous).
    -->
    <!-- Header row 1: identity + transport + master enable + status -->
    <div class="mb-header">
      <span class="mb-title">
        <Cpu class="icon-sm" />
        {{ t('modbus.title') }}
      </span>
      <n-select
        :value="config.transport"
        :options="transportOptions"
        size="tiny"
        style="width: 168px"
        @update:value="(v) => patch({ transport: v })"
      />
      <n-checkbox
        :checked="config.enabled"
        size="small"
        @update:checked="(v) => patch({ enabled: v })"
      >
        {{ t('modbus.master.enable') }}
      </n-checkbox>
      <span class="mb-status" :class="statusClass">{{ statusText }}</span>
      <button class="mb-close" type="button" :title="t('common.close')" @click="emit('close')">
        <X class="icon-sm" />
      </button>
    </div>

    <!-- Header row 2: timing inputs (own row so inputs are never squeezed).
         Step controls are hidden — they steal horizontal space and the wheel/
         direct entry already cover value entry. -->
    <div class="mb-timing-bar">
      <span class="mb-field-label">{{ t('modbus.pollInterval') }}</span>
      <n-input-number
        :value="config.pollIntervalMs"
        size="tiny"
        :min="100"
        :max="10000"
        :step="100"
        :show-button="false"
        style="width: 124px"
        @update:value="(v) => patch({ pollIntervalMs: v ?? 1000 })"
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
        style="width: 124px"
        @update:value="(v) => patch({ writeIntervalMs: v ?? 1000 })"
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
        style="width: 120px"
        @update:value="(v) => patch({ timeoutMs: v ?? 500 })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="mb-writesrc">
        <span class="mb-field-label">{{ t('modbus.writeSource') }}</span>
        <n-button size="tiny" quaternary @click="pickWriteSource">
          <template #icon><FileUp class="icon-sm" /></template>
          {{ writeSourceName ?? t('modbus.writeSourceNone') }}
        </n-button>
        <n-button
          v-if="writeSourceName"
          size="tiny"
          quaternary
          :title="t('modbus.clearWriteSource')"
          @click="clearWriteSourceSelection"
        >
          <template #icon><X class="icon-sm" /></template>
        </n-button>
      </span>
    </div>

    <!-- Header row 3: action buttons -->
    <div class="mb-actions-bar">
      <n-button size="tiny" quaternary :disabled="busy || !isConnected" @click="onReadAll">
        <template #icon><RefreshCw class="icon-sm" /></template>
        {{ t('modbus.readAll') }}
      </n-button>
      <n-button
        v-if="hasWriteRegs"
        size="tiny"
        quaternary
        :disabled="busy || !isConnected"
        @click="onSendAll"
      >
        <template #icon><Send class="icon-sm" /></template>
        {{ t('modbus.sendAll') }}
      </n-button>
      <n-button
        v-if="hasWriteRegs && !replaying"
        size="tiny"
        quaternary
        :disabled="!isConnected"
        @click="onReplayClick"
      >
        <template #icon><Play class="icon-sm" /></template>
        {{ t('modbus.replay') }}
      </n-button>
      <n-button v-else-if="replaying" size="tiny" type="warning" @click="emitStopReplay">
        <template #icon><Square class="icon-sm" /></template>
        {{ t('modbus.stopReplay') }}
      </n-button>
      <n-button size="tiny" quaternary @click="onLoad">
        <template #icon><Upload class="icon-sm" /></template>
        {{ t('modbus.load') }}
      </n-button>
      <n-button size="tiny" quaternary :disabled="registers.length === 0" @click="onSave">
        <template #icon><Download class="icon-sm" /></template>
        {{ t('modbus.save') }}
      </n-button>
    </div>

    <!-- Column header row -->
    <div class="mb-colhead">
      <span class="col col-name">{{ t('modbus.col.name') }}</span>
      <span class="col col-slave">{{ t('modbus.col.slave') }}</span>
      <span class="col col-fc">{{ t('modbus.col.fc') }}</span>
      <span class="col col-addr">{{ t('modbus.col.addr') }}</span>
      <span class="col col-type">{{ t('modbus.col.type') }}</span>
      <span class="col col-ch">{{ t('modbus.col.ch') }}</span>
      <span class="col col-rw" :title="t('modbus.col.rwHint')">{{ t('modbus.col.rw') }}</span>
      <span class="col col-value">{{ t('modbus.col.value') }}</span>
      <span class="col col-unit">{{ t('modbus.col.unit') }}</span>
      <span class="col col-actions">{{ t('modbus.col.actions') }}</span>
    </div>

    <!-- Register rows -->
    <div class="mb-list scrollbar-thin">
      <div v-if="registers.length === 0" class="mb-empty">{{ t('modbus.empty') }}</div>
      <div
        v-for="(reg, idx) in registers"
        :key="reg.id"
        class="mb-row"
        :class="{ alt: idx % 2 === 1 }"
      >
        <span class="col col-name" :title="reg.name">{{ reg.name }}</span>
        <span class="col col-slave">{{ reg.slaveAddress }}</span>
        <span class="col col-fc">{{ fcLabel(reg.functionCode) }}</span>
        <span class="col col-addr">{{ reg.address }}</span>
        <span class="col col-type">{{ typeLabel(reg.type) }}</span>
        <span class="col col-ch">
          <n-select
            :value="reg.waveformChannel ?? -1"
            :options="channelOptions"
            size="tiny"
            style="width: 60px"
            @update:value="(v) => setChannel(reg.id, v)"
          />
        </span>
        <span class="col col-rw">
          <!-- R: periodic read toggle (read FCs only). W: periodic write toggle (FC05/06). -->
          <button
            class="rw-toggle"
            type="button"
            :class="{ on: reg.periodicRead, disabled: !isReadReg(reg) }"
            :disabled="!isReadReg(reg)"
            :title="t('modbus.periodicRead')"
            @click="togglePeriodic(reg.id, 'periodicRead', !reg.periodicRead)"
          >
            R
          </button>
          <button
            class="rw-toggle w"
            type="button"
            :class="{ on: reg.periodicWrite, disabled: !isWriteReg(reg) }"
            :disabled="!isWriteReg(reg)"
            :title="t('modbus.periodicWrite')"
            @click="togglePeriodic(reg.id, 'periodicWrite', !reg.periodicWrite)"
          >
            W
          </button>
        </span>
        <span class="col col-value">
          <!-- Write FCs: editable value. Read FCs: live monospace readout. -->
          <n-input
            v-if="isWriteReg(reg) && !isBitReg(reg)"
            :value="String(reg.value ?? '')"
            size="tiny"
            :placeholder="t('modbus.valuePlaceholder')"
            @update:value="(v) => editValue(reg.id, v)"
          />
          <n-checkbox
            v-else-if="isWriteReg(reg) && isBitReg(reg)"
            :checked="(reg.value ?? 0) !== 0"
            size="small"
            @update:checked="(v) => editValue(reg.id, v ? '1' : '0')"
          />
          <span v-else class="value-readout" :class="{ stale: reg.value === null }">{{
            formatValue(reg)
          }}</span>
        </span>
        <span class="col col-unit">{{ reg.unit ?? '' }}</span>
        <span class="col col-actions">
          <button
            class="row-btn"
            type="button"
            :title="t('modbus.plot')"
            @click="emit('plotInWaveform', reg)"
          >
            <LineChart class="icon-sm" />
          </button>
          <!-- Single-shot action is chosen by the row's FC, not a global mode. -->
          <button
            v-if="isReadReg(reg)"
            class="row-btn"
            type="button"
            :disabled="busy || !isConnected"
            :title="t('modbus.read')"
            @click="onReadRow(reg)"
          >
            <RefreshCw class="icon-sm" />
          </button>
          <button
            v-else
            class="row-btn"
            type="button"
            :disabled="busy || !isConnected"
            :title="t('modbus.send')"
            @click="onSendRow(reg)"
          >
            <Send class="icon-sm" />
          </button>
          <button
            class="row-btn danger"
            type="button"
            :title="t('common.delete')"
            @click="remove(reg.id)"
          >
            <Trash2 class="icon-sm" />
          </button>
        </span>
      </div>
    </div>

    <!-- Add-register form -->
    <div class="mb-add">
      <n-input
        v-model:value="draft.name"
        size="tiny"
        :placeholder="t('modbus.namePlaceholder')"
        style="width: 130px"
      />
      <n-input-number
        v-model:value="draft.slaveAddress"
        size="tiny"
        :min="0"
        :max="247"
        style="width: 76px"
      />
      <n-select
        v-model:value="draft.functionCode"
        :options="fcOptions"
        size="tiny"
        style="width: 150px"
      />
      <n-input-number
        v-model:value="draft.address"
        size="tiny"
        :min="0"
        :max="65535"
        style="width: 92px"
      />
      <n-select v-model:value="draft.type" :options="typeOptions" size="tiny" style="width: 88px" />
      <n-input v-model:value="draft.unit" size="tiny" placeholder="°C" style="width: 56px" />
      <n-select
        v-model:value="draft.waveformChannel"
        :options="channelOptions"
        size="tiny"
        style="width: 60px"
      />
      <n-button size="tiny" type="primary" :disabled="!canAdd" @click="addRegister">
        <template #icon><Plus class="icon-sm" /></template>
        {{ t('modbus.addRegister') }}
      </n-button>
    </div>

    <input ref="fileInput" type="file" accept=".bbreg,.jsonl,.txt" hidden @change="onFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowReactive } from 'vue';
import { NButton, NCheckbox, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import {
  Cpu,
  Download,
  FileUp,
  LineChart,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next';
import { useSessionStore } from '../../stores/sessions';
import {
  encodeStream,
  parseStream,
  recordsToRegisterDefs,
  snapshotFromRegisters,
} from '../../lib/modbus-stream';
import { isBitFc, isReadFc } from '../../lib/modbus';
import { t } from '../../lib/i18n';
import type {
  ModbusFunctionCode,
  ModbusMasterConfig,
  ModbusRegister,
  ModbusValueType,
} from '../../types';

const props = defineProps<{
  sessionId: string;
  config: ModbusMasterConfig;
  registers: ModbusRegister[];
  isConnected: boolean;
  busy: boolean;
  statusText: string;
  statusClass: string;
  replaying: boolean;
  /** Filename of the loaded periodic-write data source, or null when none. */
  writeSourceName: string | null;
  onReadAll: () => Promise<void>;
  onReadRow: (reg: ModbusRegister) => Promise<void>;
  onSendAll: () => Promise<void>;
  onSendRow: (reg: ModbusRegister) => Promise<void>;
  /** Begin replaying a parsed .bbreg stream onto write-rows. */
  onReplay: (records: ReturnType<typeof parseStream>) => void;
  /** Stop an in-flight replay. */
  onStopReplay: () => void;
  /** Load a parsed .bbreg stream as the periodic-write data source. */
  onLoadWriteSource: (records: ReturnType<typeof parseStream>, name: string) => void;
  /** Clear the loaded periodic-write data source. */
  onClearWriteSource: () => void;
  /** Open the OS file picker for the periodic-write data source. */
  onPickWriteSource: () => void;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'plotInWaveform', reg: ModbusRegister): void;
}>();

const sessionStore = useSessionStore();
const message = useMessage();
const fileInput = ref<HTMLInputElement | null>(null);

const transportOptions = computed(() => [
  { label: t('modbus.transport.rtu'), value: 'rtu' },
  { label: t('modbus.transport.pdu'), value: 'pdu' },
]);
const fcOptions = computed(() => [
  { label: t('modbus.fc.01'), value: 0x01 },
  { label: t('modbus.fc.02'), value: 0x02 },
  { label: t('modbus.fc.03'), value: 0x03 },
  { label: t('modbus.fc.04'), value: 0x04 },
  { label: t('modbus.fc.05'), value: 0x05 },
  { label: t('modbus.fc.06'), value: 0x06 },
]);
const typeOptions = computed(() =>
  (['bool', 'uint16', 'int16', 'uint32-be', 'int32-be', 'float32-be'] as ModbusValueType[]).map(
    (tp) => ({ label: t(`modbus.type.${tp}`), value: tp }),
  ),
);
const channelOptions = computed(() => [
  { label: t('modbus.channel.off'), value: -1 },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: i })),
]);

/** Whether the table has any writable rows (FC05/06) — drives Send/Replay visibility. */
const hasWriteRegs = computed(() => props.registers.some(isWriteReg));

interface Draft {
  name: string;
  slaveAddress: number;
  functionCode: ModbusFunctionCode;
  address: number;
  type: ModbusValueType;
  unit: string;
  waveformChannel: number; // -1 = off
}
const draft = shallowReactive<Draft>({
  name: '',
  slaveAddress: 1,
  functionCode: 0x03,
  address: 0,
  type: 'uint16',
  unit: '',
  waveformChannel: -1,
});

const canAdd = computed(() => draft.name.trim().length > 0);

function patch(p: Partial<ModbusMasterConfig>) {
  sessionStore.setModbusConfig(props.sessionId, p);
}

function fcLabel(fc: number): string {
  return t(`modbus.fc.${fc.toString(16).padStart(2, '0')}`);
}
function typeLabel(tp: ModbusValueType): string {
  return t(`modbus.type.${tp}`);
}
function isBitReg(reg: ModbusRegister): boolean {
  return isBitFc(reg.functionCode);
}
function isReadReg(reg: ModbusRegister): boolean {
  return isReadFc(reg.functionCode);
}
function isWriteReg(reg: ModbusRegister): boolean {
  return reg.functionCode === 0x05 || reg.functionCode === 0x06;
}

function togglePeriodic(regId: string, field: 'periodicRead' | 'periodicWrite', value: boolean) {
  sessionStore.updateModbusRegister(props.sessionId, regId, { [field]: value });
}

function formatValue(reg: ModbusRegister): string {
  if (reg.value === null || !Number.isFinite(reg.value)) return '—';
  if (Math.abs(reg.value) >= 1000) return reg.value.toFixed(0);
  if (Math.abs(reg.value) >= 10) return reg.value.toFixed(1);
  return reg.value.toFixed(2);
}

function setChannel(regId: string, ch: number) {
  sessionStore.updateModbusRegister(props.sessionId, regId, {
    waveformChannel: ch < 0 ? null : ch,
  });
}

function editValue(regId: string, raw: string) {
  const num = Number(raw);
  sessionStore.updateModbusRegister(props.sessionId, regId, {
    value: Number.isFinite(num) ? num : null,
    valueTs: Date.now(),
  });
}

function addRegister() {
  if (!canAdd.value) return;
  // New rows default to periodic read for read-FCs and never auto-write — the
  // user opts each row in via the R/W toggles.
  const fc = draft.functionCode;
  const isWriteFc = fc === 0x05 || fc === 0x06;
  sessionStore.addModbusRegister(props.sessionId, {
    name: draft.name.trim(),
    slaveAddress: draft.slaveAddress,
    functionCode: draft.functionCode,
    address: draft.address,
    type: draft.type,
    unit: draft.unit || undefined,
    waveformChannel: draft.waveformChannel < 0 ? null : draft.waveformChannel,
    periodicRead: !isWriteFc,
    periodicWrite: false,
  });
  // Reset the name + address for the next add, keep the rest (common to batch-add a block).
  draft.name = '';
  draft.address +=
    draft.type === 'bool' || draft.type === 'uint16' || draft.type === 'int16' ? 1 : 2;
}

function remove(regId: string) {
  sessionStore.removeModbusRegister(props.sessionId, regId);
}

// --- .bbreg load / save ---
// Uses the hidden <input type=file> for loading and a Blob download for saving.
// Both work natively in the Tauri webview and in a plain browser dev build,
// with no extra plugins or Rust commands required.

function onLoad() {
  fileInput.value?.click();
}

async function onSave() {
  const records = snapshotFromRegisters(props.registers);
  if (records.length === 0) {
    message.warning(t('modbus.empty'));
    return;
  }
  const text = encodeStream(records);
  const blob = new Blob([text], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bbcom-registers-${Date.now()}.bbreg`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(t('waveform.exportedStream', { count: records.length }));
}

function onReplayClick() {
  // The replay source is the same file picker; the picked stream is handed to
  // the master, which matches records to write-rows by (slave, fc, addr).
  fileInput.value?.click();
}

function emitStopReplay() {
  props.onStopReplay();
}

function pickWriteSource() {
  // Delegates to SessionView, which owns the hidden file input + master binding.
  props.onPickWriteSource();
}

function clearWriteSourceSelection() {
  props.onClearWriteSource();
}

function onFilePicked(e: Event) {
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
    // If the stream contains write-target records (FC05/06) the master can
    // replay them; otherwise import it as register-row definitions.
    const hasWriteTargets = records.some((r) => r.fc === 0x05 || r.fc === 0x06);
    if (hasWriteTargets) {
      props.onReplay(records);
      message.success(t('waveform.exportedStream', { count: records.length }));
    } else {
      const defs = recordsToRegisterDefs(records);
      const merged: ModbusRegister[] = [
        ...props.registers,
        ...defs.map((d) => ({ ...d, id: crypto.randomUUID() })),
      ];
      sessionStore.setModbusRegisters(props.sessionId, merged);
      message.success(t('waveform.exportedStream', { count: defs.length }));
    }
  };
  reader.readAsText(file);
  input.value = ''; // allow re-picking the same file
}
</script>

<style scoped>
.modbus-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  min-height: 0;
}

/* Header row 1: identity + transport + enable + status */
.mb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  font-size: 10px;
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

/* Header row 2: timing inputs on their own row so values are never squeezed. */
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
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

/* Header row 3: action buttons on their own row. */
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
  font-size: 10px;
  color: var(--text-dim);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  margin-left: auto;
}

.mb-status.polling {
  color: var(--accent-blue);
}

.mb-status.writing {
  color: var(--accent-green);
}

.mb-status.replaying {
  color: var(--accent-green);
}

.mb-status.timeout,
.mb-status.exception,
.mb-status.crc-error {
  color: var(--accent-red);
  background: var(--accent-red-subtle);
}

/* Table layout: a CSS grid keeps columns aligned between header and rows. */
.mb-colhead,
.mb-row {
  display: grid;
  grid-template-columns:
    minmax(90px, 1.4fr) 44px 130px 60px 80px 64px 48px minmax(80px, 1fr) 50px
    92px;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
}

.mb-colhead {
  position: sticky;
  top: 0;
  z-index: 1;
  border-bottom: 1px solid var(--border-strong);
  background: var(--bg-tertiary);
  color: var(--text-dim);
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.mb-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.mb-empty {
  color: var(--text-dim);
  font-size: 11px;
  padding: 24px 12px;
  text-align: center;
}

.mb-row {
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

.mb-row.alt {
  background: var(--bg-secondary);
}

.mb-row:hover {
  background: var(--bg-hover);
}

.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-weight: 600;
}

.col-actions {
  display: inline-flex;
  gap: 2px;
  justify-content: flex-end;
}

.value-readout {
  color: var(--accent-blue);
  font-weight: 600;
}

.value-readout.stale {
  color: var(--text-dim);
  font-weight: 400;
}

.row-btn {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.row-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.row-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.row-btn.danger:hover:not(:disabled) {
  color: var(--accent-red);
}

.mb-add {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

/* Periodic read/write toggle chips. */
.col-rw {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}

.rw-toggle {
  width: 16px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  font-size: 9px;
  font-weight: 700;
  font-family: var(--font-sans);
  line-height: 1;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.rw-toggle:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.rw-toggle:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}

.rw-toggle.on {
  color: var(--accent-blue);
  border-color: var(--accent-blue);
  background: var(--accent-blue-subtle, transparent);
}

.rw-toggle.w.on {
  color: var(--accent-green);
  border-color: var(--accent-green);
  background: transparent;
}

/* Write data-source chip in the timing bar. */
.mb-writesrc {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}
</style>
