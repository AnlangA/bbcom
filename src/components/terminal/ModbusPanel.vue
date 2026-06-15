<template>
  <div class="modbus-panel">
    <!--
      Modbus register table. One row model, two table modes:
      - READ: rows are polled by the master (useModbusMaster in SessionView);
        the Value column shows live decoded values.
      - SEND: the Value column becomes editable; "Send" / "Send all" write the
        values (FC05/06 single, auto-batched into FC0F/FC10 when contiguous).
      The same rows feed the waveform (those with a channel assignment) and can
      be saved/loaded as .bbreg streams.
    -->
    <div class="mb-header">
      <span class="mb-title">
        <Cpu class="icon-sm" />
        {{ t('modbus.title') }}
      </span>
      <div class="mb-config">
        <n-select
          :value="config.transport"
          :options="transportOptions"
          size="tiny"
          style="width: 120px"
          @update:value="(v) => patch({ transport: v })"
        />
        <n-button-group size="tiny">
          <n-button
            :type="config.tableMode === 'read' ? 'primary' : 'default'"
            @click="patch({ tableMode: 'read' })"
            >{{ t('modbus.tableMode.read') }}</n-button
          >
          <n-button
            :type="config.tableMode === 'send' ? 'primary' : 'default'"
            @click="patch({ tableMode: 'send' })"
            >{{ t('modbus.tableMode.send') }}</n-button
          >
        </n-button-group>
        <n-checkbox
          :checked="config.enabled"
          size="small"
          @update:checked="(v) => patch({ enabled: v })"
        >
          {{ t('modbus.master.enable') }}
        </n-checkbox>
        <n-input-number
          :value="config.pollIntervalMs"
          size="tiny"
          :min="100"
          :max="10000"
          :step="100"
          style="width: 96px"
          @update:value="(v) => patch({ pollIntervalMs: v ?? 1000 })"
        >
          <template #suffix>ms</template>
        </n-input-number>
        <n-input-number
          :value="config.timeoutMs"
          size="tiny"
          :min="50"
          :max="5000"
          :step="50"
          style="width: 90px"
          @update:value="(v) => patch({ timeoutMs: v ?? 500 })"
        >
          <template #suffix>ms</template>
        </n-input-number>
        <span class="mb-status" :class="statusClass">{{ statusText }}</span>
      </div>
      <div class="mb-actions">
        <n-button size="tiny" quaternary :disabled="busy || !isConnected" @click="onReadAll">
          <template #icon><RefreshCw class="icon-sm" /></template>
          {{ t('modbus.readAll') }}
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :disabled="busy || !isConnected"
          @click="onSendAll"
          v-if="config.tableMode === 'send'"
        >
          <template #icon><Send class="icon-sm" /></template>
          {{ t('modbus.sendAll') }}
        </n-button>
        <n-button size="tiny" quaternary @click="onLoad">
          <template #icon><Upload class="icon-sm" /></template>
          {{ t('modbus.load') }}
        </n-button>
        <n-button size="tiny" quaternary :disabled="registers.length === 0" @click="onSave">
          <template #icon><Download class="icon-sm" /></template>
          {{ t('modbus.save') }}
        </n-button>
        <button class="mb-close" type="button" :title="t('common.close')" @click="emit('close')">
          <X class="icon-sm" />
        </button>
      </div>
    </div>

    <!-- Column header row -->
    <div class="mb-colhead">
      <span class="col col-name">{{ t('modbus.col.name') }}</span>
      <span class="col col-slave">{{ t('modbus.col.slave') }}</span>
      <span class="col col-fc">{{ t('modbus.col.fc') }}</span>
      <span class="col col-addr">{{ t('modbus.col.addr') }}</span>
      <span class="col col-type">{{ t('modbus.col.type') }}</span>
      <span class="col col-ch">{{ t('modbus.col.ch') }}</span>
      <span class="col col-value">{{ t('modbus.col.value') }}</span>
      <span class="col col-unit">{{ t('modbus.col.unit') }}</span>
      <span class="col col-actions">{{ t('modbus.col.actions') }}</span>
    </div>

    <!-- Register rows -->
    <div class="mb-list scrollbar-thin">
      <div v-if="registers.length === 0" class="mb-empty">{{ t('modbus.empty') }}</div>
      <div v-for="reg in registers" :key="reg.id" class="mb-row">
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
            style="width: 64px"
            @update:value="(v) => setChannel(reg.id, v)"
          />
        </span>
        <span class="col col-value">
          <!-- READ mode: live monospace readout. SEND mode: editable input. -->
          <n-input
            v-if="config.tableMode === 'send' && !isBitReg(reg)"
            :value="String(reg.value ?? '')"
            size="tiny"
            :placeholder="t('modbus.valuePlaceholder')"
            @update:value="(v) => editValue(reg.id, v)"
          />
          <n-checkbox
            v-else-if="config.tableMode === 'send' && isBitReg(reg)"
            :checked="(reg.value ?? 0) !== 0"
            size="small"
            @update:checked="(v) => editValue(reg.id, v ? '1' : '0')"
          />
          <span v-else class="value-readout">{{ formatValue(reg) }}</span>
        </span>
        <span class="col col-unit">{{ reg.unit ?? '' }}</span>
        <span class="col col-actions">
          <button
            v-if="config.tableMode === 'read'"
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
          <button class="row-btn danger" type="button" :title="t('common.delete')" @click="remove(reg.id)">
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
        style="width: 80px"
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
        style="width: 96px"
      />
      <n-select
        v-model:value="draft.type"
        :options="typeOptions"
        size="tiny"
        style="width: 88px"
      />
      <n-input v-model:value="draft.unit" size="tiny" placeholder="°C" style="width: 60px" />
      <n-select
        v-model:value="draft.waveformChannel"
        :options="channelOptions"
        size="tiny"
        style="width: 64px"
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
import {
  NButton,
  NButtonGroup,
  NCheckbox,
  NInput,
  NInputNumber,
  NSelect,
  useMessage,
} from 'naive-ui';
import { Cpu, Download, Plus, RefreshCw, Send, Trash2, Upload, X } from 'lucide-vue-next';
import { useSessionStore } from '../../stores/sessions';
import { encodeStream, parseStream, recordsToRegisterDefs, snapshotFromRegisters } from '../../lib/modbus-stream';
import { isBitFc } from '../../lib/modbus';
import { t } from '../../lib/i18n';
import type { ModbusFunctionCode, ModbusMasterConfig, ModbusRegister, ModbusValueType } from '../../types';

const props = defineProps<{
  sessionId: string;
  config: ModbusMasterConfig;
  registers: ModbusRegister[];
  isConnected: boolean;
  busy: boolean;
  statusText: string;
  statusClass: string;
  onReadAll: () => Promise<void>;
  onReadRow: (reg: ModbusRegister) => Promise<void>;
  onSendAll: () => Promise<void>;
  onSendRow: (reg: ModbusRegister) => Promise<void>;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

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
  (
    ['bool', 'uint16', 'int16', 'uint32-be', 'int32-be', 'float32-be'] as ModbusValueType[]
  ).map((tp) => ({ label: t(`modbus.type.${tp}`), value: tp })),
);
const channelOptions = computed(() => [
  { label: t('modbus.channel.off'), value: -1 },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: i })),
]);

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
  sessionStore.addModbusRegister(props.sessionId, {
    name: draft.name.trim(),
    slaveAddress: draft.slaveAddress,
    functionCode: draft.functionCode,
    address: draft.address,
    type: draft.type,
    unit: draft.unit || undefined,
    waveformChannel: draft.waveformChannel < 0 ? null : draft.waveformChannel,
  });
  // Reset the name + address for the next add, keep the rest (common to batch-add a block).
  draft.name = '';
  draft.address += draft.type === 'bool' || draft.type === 'uint16' || draft.type === 'int16' ? 1 : 2;
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
    const defs = recordsToRegisterDefs(records);
    // Merge: assign fresh ids; existing defs in the table are preserved.
    const merged: ModbusRegister[] = [
      ...props.registers,
      ...defs.map((d) => ({ ...d, id: crypto.randomUUID() })),
    ];
    sessionStore.setModbusRegisters(props.sessionId, merged);
    message.success(t('waveform.exportedStream', { count: defs.length }));
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

.mb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
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
}

.mb-config {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
}

.mb-actions {
  display: flex;
  align-items: center;
  gap: 4px;
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
}

.mb-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.mb-status {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}

.mb-status.polling {
  color: var(--accent-blue);
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
    minmax(90px, 1.4fr) 44px 130px 60px 80px 70px minmax(80px, 1fr) 50px
    72px;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
}

.mb-colhead {
  border-bottom: 1px solid var(--border-subtle);
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
</style>
