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
    <ModbusHeader
      :config="config"
      :status-text="statusText"
      :status-class="statusClass"
      :busy="busy"
      :is-connected="isConnected"
      :replaying="replaying"
      :has-write-regs="hasWriteRegs"
      :registers-empty="registers.length === 0"
      :write-source-name="writeSourceName"
      @close="emit('close')"
      @patch="patch"
      @pick-write-source="onPickWriteSource"
      @clear-write-source="onClearWriteSource"
      @read-all="onReadAll"
      @send-all="onSendAll"
      @replay="onReplayClick"
      @stop-replay="emitStopReplay"
      @load="onLoad"
      @save="onSave"
    />

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
      <ModbusRegisterRow
        v-for="(reg, idx) in registers"
        :key="reg.id"
        :reg="reg"
        :session-id="sessionId"
        :busy="busy"
        :is-connected="isConnected"
        :flashed="flashRowId === reg.id"
        :alt="idx % 2 === 1"
        :fc-options="fcOptions"
        :channel-options="channelOptions"
        :type-options="typeOptions"
        :bit-type-options="bitTypeOptions"
        @plot="emit('plotInWaveform', reg)"
        @read="onReadRow(reg)"
        @send="handleSendRow(reg)"
        @remove="remove(reg.id)"
      />
    </div>

    <!-- Add-register form: shares the table's grid columns so each field sits
         directly under its column header. The R/W and Value columns are omitted
         here (they have no meaning until the row exists); the trailing Unit +
         Add fields land in the last two columns. -->
    <ModbusAddRegisterForm @add="addRegisterFromDraft" />

    <input ref="fileInput" type="file" accept=".bbreg,.jsonl,.txt" hidden @change="onFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { useSessionStore } from '../../stores/sessions';
import {
  encodeStream,
  parseStream,
  recordsToRegisterDefs,
  snapshotFromRegisters,
} from '../../lib/modbus';
import {
  isModbusWriteFc,
  modbusWriteRowValues,
  normalizeModbusDataQuantity,
} from '../../lib/modbus';
import { t } from '../../lib/i18n';
import type {
  ModbusFunctionCode,
  ModbusMasterConfig,
  ModbusRegister,
  ModbusValueType,
} from '../../types';
import ModbusHeader from './ModbusHeader.vue';
import ModbusRegisterRow from './ModbusRegisterRow.vue';
import ModbusAddRegisterForm from './ModbusAddRegisterForm.vue';

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
const bitTypeOptions = computed(() => [{ label: t('modbus.type.bool'), value: 'bool' as ModbusValueType }]);
const channelOptions = computed(() => [
  { label: t('modbus.channel.off'), value: -1 },
  ...Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: i })),
]);

/** Whether the table has any writable rows (FC05/06/10) — drives Send/Replay visibility. */
const hasWriteRegs = computed(() => props.registers.some((r) => isModbusWriteFc(r.functionCode)));

function patch(p: Partial<ModbusMasterConfig>) {
  sessionStore.setModbusConfig(props.sessionId, p);
}

/** Handler for ModbusAddRegisterForm's @add event. New rows default to periodic
 *  read for read-FCs and never auto-write — the user opts each row in via R/W. */
interface AddRegisterDraft {
  name: string;
  slaveAddress: number;
  functionCode: ModbusFunctionCode;
  address: number;
  quantity: number;
  type: ModbusValueType;
  unit: string;
  waveformChannel: number;
}
function addRegisterFromDraft(d: AddRegisterDraft) {
  const fc = d.functionCode;
  const quantity = normalizeModbusDataQuantity(d.quantity, fc, d.type);
  sessionStore.addModbusRegister(props.sessionId, {
    name: d.name.trim(),
    slaveAddress: d.slaveAddress,
    functionCode: d.functionCode,
    address: d.address,
    quantity,
    type: d.type,
    unit: d.unit || undefined,
    waveformChannel: d.waveformChannel < 0 ? null : d.waveformChannel,
    periodicRead: !isModbusWriteFc(fc),
    periodicWrite: false,
  });
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

/* Table layout: a CSS grid keeps columns aligned between header and rows. */
.mb-colhead {
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

/* Periodic read/write toggle chips. */
/* Write data-source chip in the timing bar. */
.mb-writesrc {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}
</style>
