<!--
  One register table row. Extracted from ModbusPanel so the panel stays
  under 400 lines. The row edits the store directly (it has the sessionId) and
  emits plot/read/send/remove for the few actions the parent wires to the master.
  Receives the shared option lists + the per-row send-success flash id.
-->
<template>
  <div class="mb-row" :class="{ alt: alt, 'send-flash': flashed }">
    <span class="col col-name" :title="reg.name">
      <n-input :value="reg.name" size="tiny" @update:value="(v) => edit({ name: v })" />
    </span>
    <span class="col col-slave">
      <n-input-number
        :value="reg.slaveAddress"
        size="tiny"
        :min="0"
        :max="247"
        :show-button="false"
        @update:value="(v) => editAndClear({ slaveAddress: v ?? 1 })"
      />
    </span>
    <span class="col col-fc">
      <n-select
        :value="reg.functionCode"
        :options="fcOptions"
        size="tiny"
        @update:value="(v) => editFunctionCode(v)"
      />
    </span>
    <span class="col col-addr">
      <n-input-number
        :value="reg.address"
        size="tiny"
        :min="0"
        :max="65535"
        :show-button="false"
        @update:value="(v) => editAndClear({ address: v ?? 0 })"
      />
    </span>
    <span class="col col-qty">
      <n-input-number
        v-if="isDataCountEditable(reg.functionCode)"
        :value="dataQuantity(reg)"
        size="tiny"
        :min="1"
        :max="dataQuantityMax(reg.functionCode, reg.type)"
        :show-button="false"
        style="width: 54px"
        @update:value="(v) => editQuantity(v ?? 1)"
      />
      <span v-else>—</span>
    </span>
    <span class="col col-type">
      <n-select
        :value="reg.type"
        :options="typeOptionsFor(reg.functionCode)"
        size="tiny"
        :disabled="isBitReg"
        @update:value="(v) => editType(v)"
      />
    </span>
    <span class="col col-ch">
      <n-select
        :value="reg.waveformChannel ?? -1"
        :options="channelOptions"
        size="tiny"
        style="width: 60px"
        @update:value="(v) => setChannel(v)"
      />
    </span>
    <span class="col col-rw">
      <!-- R: periodic read toggle (read FCs only). W: periodic write toggle (FC05/06/10). -->
      <button
        class="rw-toggle"
        type="button"
        :class="{ on: reg.periodicRead, disabled: !isReadReg }"
        :disabled="!isReadReg"
        :title="t('modbus.periodicRead')"
        @click="togglePeriodic('periodicRead', !reg.periodicRead)"
      >
        R
      </button>
      <button
        class="rw-toggle w"
        type="button"
        :class="{ on: reg.periodicWrite, disabled: !isWriteReg }"
        :disabled="!isWriteReg"
        :title="t('modbus.periodicWrite')"
        @click="togglePeriodic('periodicWrite', !reg.periodicWrite)"
      >
        W
      </button>
    </span>
    <span class="col col-value">
      <!-- Write FCs: editable value. Read FCs: live monospace readout. -->
      <n-input
        v-if="isWriteReg && !isBitReg"
        :value="editValueText"
        size="tiny"
        :placeholder="valuePlaceholder"
        @update:value="(v) => editValue(v)"
      />
      <n-checkbox
        v-else-if="isWriteReg && isBitReg"
        :checked="(reg.value ?? 0) !== 0"
        size="small"
        @update:checked="(v) => editValue(v ? '1' : '0')"
      />
      <span v-else class="value-readout" :class="{ stale: reg.value === null }">{{
        formatValue(reg)
      }}</span>
    </span>
    <span class="col col-unit">
      <n-input
        :value="reg.unit ?? ''"
        size="tiny"
        placeholder="°C"
        @update:value="(v) => edit({ unit: v || undefined })"
      />
    </span>
    <span class="col col-actions">
      <button class="row-btn" type="button" :title="t('modbus.plot')" @click="$emit('plot')">
        <LineChart class="icon-sm" />
      </button>
      <!-- Single-shot action is chosen by the row's FC, not a global mode. -->
      <button
        v-if="isReadReg"
        class="row-btn"
        type="button"
        :disabled="busy || !isConnected"
        :title="t('modbus.read')"
        @click="$emit('read')"
      >
        <RefreshCw class="icon-sm" />
      </button>
      <button
        v-else
        class="row-btn"
        type="button"
        :disabled="busy || !isConnected"
        :title="t('modbus.send')"
        @click="$emit('send')"
      >
        <Send class="icon-sm" />
      </button>
      <button
        class="row-btn danger"
        type="button"
        :title="t('common.delete')"
        @click="$emit('remove')"
      >
        <Trash2 class="icon-sm" />
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, shallowReactive } from 'vue';
import { NCheckbox, NInput, NInputNumber, NSelect } from 'naive-ui';
import { LineChart, RefreshCw, Send, Trash2 } from '@lucide/vue';
import { useSessionStore } from '../../stores/sessions';
import {
  formatModbusRegisterValue,
  isModbusDataCountEditable,
  isModbusWriteFc,
  modbusDataQuantityMax,
  modbusTypeForFunctionCode,
  normalizeModbusDataQuantity,
  parseModbusValueInput,
} from '../../lib/modbus';
import { isBitFc, isReadFc } from '../../lib/modbus';
import { t } from '../../lib/i18n';
import type { ModbusFunctionCode, ModbusRegister, ModbusValueType } from '../../types';

const props = defineProps<{
  reg: ModbusRegister;
  sessionId: string;
  busy: boolean;
  isConnected: boolean;
  flashed: boolean;
  alt: boolean;
  fcOptions: { label: string; value: number }[];
  channelOptions: { label: string; value: number }[];
  typeOptions: { label: string; value: ModbusValueType }[];
  bitTypeOptions: { label: string; value: ModbusValueType }[];
}>();

defineEmits<{
  plot: [];
  read: [];
  send: [];
  remove: [];
}>();

const sessionStore = useSessionStore();
const valueDrafts = shallowReactive<Record<string, string>>({});

const isBitReg = computed(() => isBitFc(props.reg.functionCode));
const isReadReg = computed(() => isReadFc(props.reg.functionCode));
const isWriteReg = computed(() => isModbusWriteFc(props.reg.functionCode));

function typeOptionsFor(fc: ModbusFunctionCode) {
  return isBitFc(fc) ? props.bitTypeOptions : props.typeOptions;
}
function isDataCountEditable(fc: ModbusFunctionCode) {
  return isModbusDataCountEditable(fc);
}
function dataQuantity(reg: ModbusRegister): number {
  return normalizeModbusDataQuantity(reg.quantity, reg.functionCode, reg.type);
}
function dataQuantityMax(fc: ModbusFunctionCode, type: ModbusValueType): number {
  return modbusDataQuantityMax(fc, type);
}

function edit(patchValue: Partial<Omit<ModbusRegister, 'id'>>) {
  sessionStore.updateModbusRegister(props.sessionId, props.reg.id, patchValue);
}
function editAndClear(patchValue: Partial<Omit<ModbusRegister, 'id'>>) {
  delete valueDrafts[props.reg.id];
  edit({ ...patchValue, value: null, values: null, valueTs: null });
}
function editFunctionCode(fc: ModbusFunctionCode) {
  const type = modbusTypeForFunctionCode(fc, props.reg.type);
  editAndClear({
    functionCode: fc,
    type,
    quantity: normalizeModbusDataQuantity(props.reg.quantity, fc, type),
    periodicRead: isReadFc(fc) ? props.reg.periodicRead : false,
    periodicWrite: isModbusWriteFc(fc) ? props.reg.periodicWrite : false,
  });
}
function editType(type: ModbusValueType) {
  const nextType = modbusTypeForFunctionCode(props.reg.functionCode, type);
  editAndClear({
    type: nextType,
    quantity: normalizeModbusDataQuantity(props.reg.quantity, props.reg.functionCode, nextType),
  });
}
function editQuantity(raw: number) {
  editAndClear({
    quantity: normalizeModbusDataQuantity(raw, props.reg.functionCode, props.reg.type),
  });
}
function setChannel(ch: number) {
  sessionStore.updateModbusRegister(props.sessionId, props.reg.id, {
    waveformChannel: ch < 0 ? null : ch,
  });
}
function togglePeriodic(field: 'periodicRead' | 'periodicWrite', value: boolean) {
  sessionStore.updateModbusRegister(props.sessionId, props.reg.id, { [field]: value });
}
function formatValue(reg: ModbusRegister): string {
  return formatModbusRegisterValue(reg);
}
const editValueText = computed(() => {
  if (Object.prototype.hasOwnProperty.call(valueDrafts, props.reg.id)) {
    return valueDrafts[props.reg.id];
  }
  const values =
    Array.isArray(props.reg.values) && props.reg.values.length > 0 ? props.reg.values : null;
  if (values) return values.join(' ');
  return props.reg.value === null || !Number.isFinite(props.reg.value)
    ? ''
    : String(props.reg.value);
});
const valuePlaceholder = computed(() =>
  props.reg.functionCode === 0x10 ? t('modbus.valueListPlaceholder') : t('modbus.valuePlaceholder'),
);
function editValue(raw: string) {
  valueDrafts[props.reg.id] = raw;
  const values = parseModbusValueInput(raw);
  const value = values[0] ?? null;
  sessionStore.updateModbusRegister(props.sessionId, props.reg.id, {
    value,
    values: values.length > 1 ? values : null,
    valueTs: Date.now(),
  });
}
</script>

<style scoped>
.mb-row {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  display: grid;
  grid-template-columns:
    minmax(82px, 1.2fr) 42px 126px 56px 54px 78px 60px 48px minmax(108px, 1fr)
    44px 92px;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
}

/* Send-success sweep across the row — same gradient + duration as the serial
   SendPanel flash, so a Modbus write reads identically to a serial TX. */
.mb-row.send-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--color-primary-subtle), transparent);
  animation: send-flash 320ms ease;
  pointer-events: none;
  z-index: 0;
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
</style>
