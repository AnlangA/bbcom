<!--
  Add-register form: shares the table's grid columns so each field sits directly
  under its column header. Owns the draft state and emits `add` with the new
  register's fields. Extracted from ModbusPanel. The R/W and Value
  columns are omitted (no meaning until the row exists); the trailing Unit +
  Add fields land in the last two columns.
-->
<template>
  <div class="mb-add">
    <span class="col col-name">
      <n-input
        v-model:value="draft.name"
        size="tiny"
        :placeholder="t('modbus.namePlaceholder')"
        :aria-label="t('modbus.col.name')"
      />
    </span>
    <span class="col col-slave">
      <n-input-number
        v-model:value="draft.slaveAddress"
        size="tiny"
        :min="0"
        :max="247"
        :show-button="false"
        :aria-label="t('modbus.col.slave')"
      />
    </span>
    <span class="col col-fc">
      <AppSelect
        :value="draft.functionCode"
        :aria-label="t('modbus.col.fc')"
        :options="fcOptions"
        size="tiny"
        @update:value="setDraftFunctionCode"
      />
    </span>
    <span class="col col-addr">
      <n-input-number
        v-model:value="draft.address"
        size="tiny"
        :min="0"
        :max="65535"
        :show-button="false"
        :aria-label="t('modbus.col.addr')"
      />
    </span>
    <span class="col col-qty">
      <n-input-number
        v-model:value="draft.quantity"
        size="tiny"
        :min="1"
        :max="draftQuantityMax"
        :disabled="!isDataCountEditable(draft.functionCode)"
        :show-button="false"
        :aria-label="t('modbus.col.quantity')"
      />
    </span>
    <span class="col col-type">
      <AppSelect
        :value="draft.type"
        :aria-label="t('modbus.col.type')"
        :options="typeOptionsFor(draft.functionCode)"
        size="tiny"
        :disabled="isBitFc(draft.functionCode)"
        @update:value="setDraftType"
      />
    </span>
    <span class="col col-ch">
      <AppSelect
        v-model:value="draft.waveformChannel"
        :aria-label="t('waveform.channel')"
        :options="channelOptions"
        size="tiny"
      />
    </span>
    <span class="col col-rw"></span>
    <span class="col col-value"></span>
    <span class="col col-unit">
      <n-input
        v-model:value="draft.unit"
        size="tiny"
        placeholder="°C"
        :aria-label="t('modbus.col.unit')"
      />
    </span>
    <span class="col col-actions">
      <n-button size="tiny" type="primary" :disabled="!canAdd" @click="commit">
        <template #icon><Plus class="icon-sm" /></template>
        {{ t('modbus.addRegister') }}
      </n-button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, shallowReactive } from 'vue';
import { NButton, NInput, NInputNumber } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { Plus } from '@lucide/vue';
import {
  isBitFc,
  isModbusDataCountEditable,
  modbusDataQuantityMax,
  modbusTypeForFunctionCode,
  normalizeModbusDataQuantity,
} from '@/lib/modbus';
import { t } from '@/lib/i18n';
import type { ModbusFunctionCode, ModbusValueType } from '@/types';

interface Draft {
  name: string;
  slaveAddress: number;
  functionCode: ModbusFunctionCode;
  address: number;
  quantity: number;
  type: ModbusValueType;
  unit: string;
  waveformChannel: number; // -1 = off
}

const emit = defineEmits<{
  add: [Draft];
}>();

const draft = shallowReactive<Draft>({
  name: '',
  slaveAddress: 1,
  functionCode: 0x03,
  address: 0,
  quantity: 1,
  type: 'uint16',
  unit: '',
  waveformChannel: -1,
});

const fcOptions = computed(() => [
  { label: t('modbus.fc.01'), value: 0x01 },
  { label: t('modbus.fc.02'), value: 0x02 },
  { label: t('modbus.fc.03'), value: 0x03 },
  { label: t('modbus.fc.04'), value: 0x04 },
  { label: t('modbus.fc.05'), value: 0x05 },
  { label: t('modbus.fc.06'), value: 0x06 },
  { label: t('modbus.fc.10'), value: 0x10 },
]);

const typeOptions = computed(() =>
  (
    [
      'bool',
      'uint8',
      'int8',
      'uint16',
      'int16',
      'uint32-be',
      'int32-be',
      'float32-be',
      'uint32-le',
      'int32-le',
      'float32-le',
    ] as ModbusValueType[]
  ).map((tp) => ({ label: t(`modbus.type.${tp}`), value: tp })),
);
const bitTypeOptions = computed(() => [{ label: t('modbus.type.bool'), value: 'bool' }]);
const channelOptions = computed(() => [
  { label: t('modbus.channel.off'), value: -1 },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: i })),
]);

const draftQuantityMax = computed(() => modbusDataQuantityMax(draft.functionCode, draft.type));
const canAdd = computed(() => draft.name.trim().length > 0 && draft.quantity >= 1);

function typeOptionsFor(fc: ModbusFunctionCode) {
  return isBitFc(fc) ? bitTypeOptions.value : typeOptions.value;
}
function isDataCountEditable(fc: ModbusFunctionCode) {
  return isModbusDataCountEditable(fc);
}

function setDraftFunctionCode(fc: ModbusFunctionCode) {
  draft.functionCode = fc;
  draft.type = modbusTypeForFunctionCode(fc, draft.type);
  draft.quantity = normalizeModbusDataQuantity(draft.quantity, fc, draft.type);
}

function setDraftType(type: ModbusValueType) {
  draft.type = modbusTypeForFunctionCode(draft.functionCode, type);
  draft.quantity = normalizeModbusDataQuantity(draft.quantity, draft.functionCode, draft.type);
}

function commit() {
  if (!canAdd.value) return;
  emit('add', { ...draft });
  // Reset the name/unit for the next entry; keep the other fields (a batch of
  // similar rows usually shares slave/fc/type/channel).
  draft.name = '';
  draft.unit = '';
  draft.address = draft.address + (draft.quantity > 0 ? draft.quantity : 1);
}
</script>

<style scoped>
/* Mirror the table's column grid so each form field lines up under its column
   header, instead of using ad-hoc per-field widths. */
.mb-add {
  display: grid;
  grid-template-columns:
    minmax(82px, 1.2fr) 42px 126px 56px 54px 78px 60px 48px minmax(108px, 1fr)
    44px 92px;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

/* Let selects/inputs stretch to the cell. */
.mb-add .col :deep(.n-input),
.mb-add .col :deep(.n-base-selection),
.mb-add .col :deep(.n-input-number) {
  width: 100%;
}

/* The empty R/W and Value cells are visual spacers only. */
.mb-add .col-rw,
.mb-add .col-value {
  visibility: hidden;
}

.mb-add .col-actions {
  display: flex;
  justify-content: flex-end;
}

.mb-add .col-actions :deep(.n-button) {
  width: 100%;
}
</style>
