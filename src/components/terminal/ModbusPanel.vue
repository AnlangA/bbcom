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
      looping. Manual Send/Send all/Replay still write on demand. FC10 rows
      are batched when contiguous; FC06 rows stay single-register writes.
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
      <span class="col col-qty">{{ t('modbus.col.quantity') }}</span>
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
        :class="{ alt: idx % 2 === 1, 'send-flash': flashRowId === reg.id }"
      >
        <span class="col col-name" :title="reg.name">
          <n-input
            :value="reg.name"
            size="tiny"
            @update:value="(v) => editRegister(reg, { name: v })"
          />
        </span>
        <span class="col col-slave">
          <n-input-number
            :value="reg.slaveAddress"
            size="tiny"
            :min="0"
            :max="247"
            :show-button="false"
            @update:value="(v) => editRegisterAndClearValue(reg, { slaveAddress: v ?? 1 })"
          />
        </span>
        <span class="col col-fc">
          <n-select
            :value="reg.functionCode"
            :options="fcOptions"
            size="tiny"
            @update:value="(v) => editFunctionCode(reg, v)"
          />
        </span>
        <span class="col col-addr">
          <n-input-number
            :value="reg.address"
            size="tiny"
            :min="0"
            :max="65535"
            :show-button="false"
            @update:value="(v) => editRegisterAndClearValue(reg, { address: v ?? 0 })"
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
            @update:value="(v) => editQuantity(reg, v ?? 1)"
          />
          <span v-else>—</span>
        </span>
        <span class="col col-type">
          <n-select
            :value="reg.type"
            :options="typeOptionsFor(reg.functionCode)"
            size="tiny"
            :disabled="isBitReg(reg)"
            @update:value="(v) => editType(reg, v)"
          />
        </span>
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
          <!-- R: periodic read toggle (read FCs only). W: periodic write toggle (FC05/06/10). -->
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
            :value="editValueText(reg)"
            size="tiny"
            :placeholder="valuePlaceholder(reg)"
            @update:value="(v) => editValue(reg, v)"
          />
          <n-checkbox
            v-else-if="isWriteReg(reg) && isBitReg(reg)"
            :checked="(reg.value ?? 0) !== 0"
            size="small"
            @update:checked="(v) => editValue(reg, v ? '1' : '0')"
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
            @update:value="(v) => editRegister(reg, { unit: v || undefined })"
          />
        </span>
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
            @click="handleSendRow(reg)"
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

    <!-- Add-register form: shares the table's grid columns so each field sits
         directly under its column header. The R/W and Value columns are omitted
         here (they have no meaning until the row exists); the trailing Unit +
         Add fields land in the last two columns. -->
    <div class="mb-add">
      <span class="col col-name">
        <n-input
          v-model:value="draft.name"
          size="tiny"
          :placeholder="t('modbus.namePlaceholder')"
        />
      </span>
      <span class="col col-slave">
        <n-input-number
          v-model:value="draft.slaveAddress"
          size="tiny"
          :min="0"
          :max="247"
          :show-button="false"
        />
      </span>
      <span class="col col-fc">
        <n-select
          :value="draft.functionCode"
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
        />
      </span>
      <span class="col col-type">
        <n-select
          :value="draft.type"
          :options="typeOptionsFor(draft.functionCode)"
          size="tiny"
          :disabled="isBitFc(draft.functionCode)"
          @update:value="setDraftType"
        />
      </span>
      <span class="col col-ch">
        <n-select v-model:value="draft.waveformChannel" :options="channelOptions" size="tiny" />
      </span>
      <span class="col col-rw"></span>
      <span class="col col-value"></span>
      <span class="col col-unit">
        <n-input v-model:value="draft.unit" size="tiny" placeholder="°C" />
      </span>
      <span class="col col-actions">
        <n-button size="tiny" type="primary" :disabled="!canAdd" @click="addRegister">
          <template #icon><Plus class="icon-sm" /></template>
          {{ t('modbus.addRegister') }}
        </n-button>
      </span>
    </div>

    <input ref="fileInput" type="file" accept=".bbreg,.jsonl,.txt" hidden @change="onFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowReactive } from 'vue';
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
import {
  MODBUS_LIMITS,
  isBitFc,
  isReadFc,
  maxValueCountForRegisters,
  registerCountForValues,
  registerSpan,
} from '../../lib/modbus';
import { modbusWriteRowValues } from '../../lib/modbus-batches';
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
  onSendRow: (reg: ModbusRegister) => Promise<boolean>;
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
const valueDrafts = shallowReactive<Record<string, string>>({});

// Per-row send-success flash. Mirrors SendPanel's send-flash sweep so a write
// that landed gives the same immediate, non-modal confirmation as a serial TX.
const flashRowId = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function triggerRowFlash(regId: string) {
  flashRowId.value = regId;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashRowId.value = null;
  }, 320);
}

onUnmounted(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

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

/** Whether the table has any writable rows (FC05/06/10) — drives Send/Replay visibility. */
const hasWriteRegs = computed(() => props.registers.some(isWriteReg));

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

const draftQuantityMax = computed(() => dataQuantityMax(draft.functionCode, draft.type));
const canAdd = computed(() => draft.name.trim().length > 0 && draft.quantity >= 1);

function patch(p: Partial<ModbusMasterConfig>) {
  sessionStore.setModbusConfig(props.sessionId, p);
}

function isBitReg(reg: ModbusRegister): boolean {
  return isBitFc(reg.functionCode);
}
function isReadReg(reg: ModbusRegister): boolean {
  return isReadFc(reg.functionCode);
}
function isWriteReg(reg: ModbusRegister): boolean {
  return reg.functionCode === 0x05 || reg.functionCode === 0x06 || reg.functionCode === 0x10;
}

function typeOptionsFor(fc: ModbusFunctionCode) {
  return isBitFc(fc) ? bitTypeOptions.value : typeOptions.value;
}

function editRegister(reg: ModbusRegister, patchValue: Partial<Omit<ModbusRegister, 'id'>>) {
  sessionStore.updateModbusRegister(props.sessionId, reg.id, patchValue);
}

function editRegisterAndClearValue(
  reg: ModbusRegister,
  patchValue: Partial<Omit<ModbusRegister, 'id'>>,
) {
  delete valueDrafts[reg.id];
  editRegister(reg, {
    ...patchValue,
    value: null,
    values: null,
    valueTs: null,
  });
}

function typeForFunctionCode(
  fc: ModbusFunctionCode,
  currentType: ModbusValueType,
): ModbusValueType {
  if (isBitFc(fc)) return 'bool';
  return currentType === 'bool' ? 'uint16' : currentType;
}

function editFunctionCode(reg: ModbusRegister, fc: ModbusFunctionCode) {
  const type = typeForFunctionCode(fc, reg.type);
  editRegisterAndClearValue(reg, {
    functionCode: fc,
    type,
    quantity: normalizeDataQuantity(reg.quantity, fc, type),
    periodicRead: isReadFc(fc) ? reg.periodicRead : false,
    periodicWrite: fc === 0x05 || fc === 0x06 || fc === 0x10 ? reg.periodicWrite : false,
  });
}

function editType(reg: ModbusRegister, type: ModbusValueType) {
  const nextType = typeForFunctionCode(reg.functionCode, type);
  editRegisterAndClearValue(reg, {
    type: nextType,
    quantity: normalizeDataQuantity(reg.quantity, reg.functionCode, nextType),
  });
}

function setDraftFunctionCode(fc: ModbusFunctionCode) {
  draft.functionCode = fc;
  draft.type = typeForFunctionCode(fc, draft.type);
  draft.quantity = normalizeDataQuantity(draft.quantity, fc, draft.type);
}

function setDraftType(type: ModbusValueType) {
  draft.type = typeForFunctionCode(draft.functionCode, type);
  draft.quantity = normalizeDataQuantity(draft.quantity, draft.functionCode, draft.type);
}

function togglePeriodic(regId: string, field: 'periodicRead' | 'periodicWrite', value: boolean) {
  sessionStore.updateModbusRegister(props.sessionId, regId, { [field]: value });
}

function formatValue(reg: ModbusRegister): string {
  const values = Array.isArray(reg.values) && reg.values.length > 0 ? reg.values : null;
  if (values) {
    return values.map(formatNumber).join(' ');
  }
  if (reg.value === null || !Number.isFinite(reg.value)) return '—';
  return formatNumber(reg.value);
}

function setChannel(regId: string, ch: number) {
  sessionStore.updateModbusRegister(props.sessionId, regId, {
    waveformChannel: ch < 0 ? null : ch,
  });
}

function editValueText(reg: ModbusRegister): string {
  if (Object.prototype.hasOwnProperty.call(valueDrafts, reg.id)) {
    return valueDrafts[reg.id];
  }
  const values = Array.isArray(reg.values) && reg.values.length > 0 ? reg.values : null;
  if (values) return values.join(' ');
  return reg.value === null || !Number.isFinite(reg.value) ? '' : String(reg.value);
}

function valuePlaceholder(reg: ModbusRegister): string {
  return reg.functionCode === 0x10
    ? t('modbus.valueListPlaceholder')
    : t('modbus.valuePlaceholder');
}

function editValue(reg: ModbusRegister, raw: string) {
  valueDrafts[reg.id] = raw;
  const values = parseValueList(raw);
  const value = values[0] ?? null;
  const patch: Partial<Omit<ModbusRegister, 'id'>> = {
    value,
    values: values.length > 1 ? values : null,
    valueTs: Date.now(),
  };
  sessionStore.updateModbusRegister(props.sessionId, reg.id, patch);
}

function addRegister() {
  if (!canAdd.value) return;
  // New rows default to periodic read for read-FCs and never auto-write — the
  // user opts each row in via the R/W toggles.
  const fc = draft.functionCode;
  const quantity = normalizeDataQuantity(draft.quantity, fc, draft.type);
  const isWriteFc = fc === 0x05 || fc === 0x06 || fc === 0x10;
  sessionStore.addModbusRegister(props.sessionId, {
    name: draft.name.trim(),
    slaveAddress: draft.slaveAddress,
    functionCode: draft.functionCode,
    address: draft.address,
    quantity,
    type: draft.type,
    unit: draft.unit || undefined,
    waveformChannel: draft.waveformChannel < 0 ? null : draft.waveformChannel,
    periodicRead: !isWriteFc,
    periodicWrite: false,
  });
  // Reset the name + address for the next add, keep the rest (common to batch-add a block).
  draft.name = '';
  draft.address += addressStepFor(fc, draft.type, quantity);
}

function isDataCountEditable(fc: ModbusFunctionCode): boolean {
  return fc === 0x03 || fc === 0x10;
}

function dataQuantity(reg: ModbusRegister): number {
  return normalizeDataQuantity(reg.quantity, reg.functionCode, reg.type);
}

function dataQuantityMax(fc: ModbusFunctionCode, type: ModbusValueType): number {
  if (fc === 0x03) return maxValueCountForRegisters(type, MODBUS_LIMITS.readRegisters);
  if (fc === 0x10) return maxValueCountForRegisters(type, MODBUS_LIMITS.writeRegisters);
  return 1;
}

function normalizeDataQuantity(
  raw: unknown,
  fc: ModbusFunctionCode,
  type: ModbusValueType,
): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.max(1, Math.min(dataQuantityMax(fc, type), n));
}

function editQuantity(reg: ModbusRegister, raw: number) {
  editRegisterAndClearValue(reg, {
    quantity: normalizeDataQuantity(raw, reg.functionCode, reg.type),
  });
}

function addressStepFor(fc: ModbusFunctionCode, type: ModbusValueType, quantity: number): number {
  if (fc === 0x03 || fc === 0x10) return registerCountForValues(type, quantity);
  return isBitFc(fc) ? 1 : registerSpan(type);
}

function parseValueList(raw: string): number[] {
  return raw
    .trim()
    .split(/[\s,;，；]+/)
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

async function handleSendRow(reg: ModbusRegister) {
  // Pre-check before hitting the master: an empty value never reaches the wire
  // (the batch builder drops value-less rows), so reporting it as a send
  // failure / "no ack" would be misleading. Treat it as missing input instead.
  if (modbusWriteRowValues(reg).length === 0) {
    message.warning(t('modbus.writeValueMissing'));
    return;
  }
  const ok = await props.onSendRow(reg);
  // Silent on success (row flash); toast only when it actually failed, so a
  // green TX sweep and no popup means "it landed".
  if (ok) {
    triggerRowFlash(reg.id);
  } else {
    message.warning(t('modbus.sendFailed'));
  }
}

function remove(regId: string) {
  delete valueDrafts[regId];
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
    // If the stream contains write-target records (FC05/06/10) the master can
    // replay them; otherwise import it as register-row definitions.
    const hasWriteTargets = records.some((r) => r.fc === 0x05 || r.fc === 0x06 || r.fc === 0x10);
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

/* Table layout: a CSS grid keeps columns aligned between header and rows. */
.mb-colhead,
.mb-row {
  display: grid;
  grid-template-columns:
    minmax(82px, 1.2fr) 42px 126px 56px 54px 78px 60px 48px minmax(108px, 1fr)
    44px 92px;
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
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
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

.mb-add {
  /* Mirror the table's column grid so each form field lines up under its
     column header, instead of using ad-hoc per-field widths. */
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

/* Drop the internal flex shrink that flex children inherited; grid cells fill
   their column width. Let selects/inputs stretch to the cell. */
.mb-add .col :deep(.n-input),
.mb-add .col :deep(.n-base-selection),
.mb-add .col :deep(.n-input-number) {
  width: 100%;
}

/* The empty R/W and Value cells are visual spacers only — keep them empty so
   the trailing Unit + Add fields land in the last two columns. */
.mb-add .col-rw,
.mb-add .col-value {
  visibility: hidden;
}

/* Add button fills its actions column. */
.mb-add .col-actions {
  display: flex;
  justify-content: flex-end;
}

.mb-add .col-actions :deep(.n-button) {
  width: 100%;
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
